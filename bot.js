// Remove duplicates
async function removeDuplicates() {
  const tasks = await getAllTasks();
  const seen = new Map();
  const toDelete = [];
  
  tasks.forEach(task => {
    if (task.status === 'done') return;
    const key = `${task.task.toLowerCase().trim()}_${task.location}_${task.when}`;
    
    if (seen.has(key)) {
      toDelete.push(task.row);
    } else {
      seen.set(key, task);
    }
  });
  
  toDelete.sort((a, b) => b - a);
  
  for (const row of toDelete) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `A${row}:G${row}`,
    });
  }
  
  return toDelete.length;
}- For deleting one: {"action": "delete", "taskName": "..."}
- For deleting ALL: {"action": "deleteAll"}// bot.js - Full version with AI
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { google } = require('googleapis');
const express = require('express');

// Express server
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Initialize Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

// Initialize OpenAI - with error checking
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    openai = new OpenAI({ 
      apiKey: process.env.OPENAI_API_KEY.trim()
    });
    console.log('✅ OpenAI initialized');
  } catch (error) {
    console.error('❌ OpenAI init error:', error.message);
  }
} else {
  console.log('⚠️  No OpenAI key - running without AI');
}

// Health check - log requests
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get('/', (req, res) => res.send('Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'ok', ai: !!openai }));

// Telegram webhook
app.post(`/webhook`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Google Sheets setup
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// Get all tasks
async function getAllTasks() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'A2:G',
    });
    
    const rows = response.data.values || [];
    return rows.map((row, index) => ({
      row: index + 2,
      date: row[0] || '',
      person: row[1] || '',
      task: row[2] || '',
      location: row[3] || '',
      when: row[4] || '',
      category: row[5] || 'general',
      status: row[6] || 'pending'
    }));
  } catch (error) {
    console.error('Sheets error:', error.message);
    return [];
  }
}

// Helper to parse dates
function parseDate(dateStr) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const dayMap = {
    'heute': today,
    'today': today,
    'morgen': tomorrow,
    'tomorrow': tomorrow,
    'montag': getNextWeekday(1),
    'dienstag': getNextWeekday(2),
    'mittwoch': getNextWeekday(3),
    'donnerstag': getNextWeekday(4),
    'freitag': getNextWeekday(5),
    'samstag': getNextWeekday(6),
    'sonntag': getNextWeekday(0)
  };
  
  const lower = dateStr?.toLowerCase() || '';
  if (dayMap[lower]) {
    return dayMap[lower].toISOString().split('T')[0];
  }
  
  // Try to parse as date
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }
  
  return dateStr; // Return original if can't parse
}

function getNextWeekday(dayOfWeek) {
  const today = new Date();
  const todayDay = today.getDay();
  const daysUntil = (dayOfWeek - todayDay + 7) % 7 || 7;
  const result = new Date(today);
  result.setDate(today.getDate() + daysUntil);
  return result;
}

// Add tasks with date parsing
async function addTasks(tasks, userName) {
  const existingTasks = await getAllTasks();
  const date = new Date().toISOString().split('T')[0];
  const newTasks = [];
  
  for (const task of tasks) {
    const exists = existingTasks.some(existing => 
      existing.task.toLowerCase() === task.task.toLowerCase() &&
      existing.status !== 'done'
    );
    
    if (!exists) {
      newTasks.push([
        date,
        userName,
        task.task,
        task.location || '',
        parseDate(task.when) || '',  // Parse dates here
        task.category || 'general',
        'pending'
      ]);
    }
  }
  
  if (newTasks.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'A:G',
      valueInputOption: 'RAW',
      resource: { values: newTasks }
    });
  }
  
  return newTasks.length;
}

// Update task
async function updateTask(taskName, updates) {
  const tasks = await getAllTasks();
  const task = tasks.find(t => 
    t.task.toLowerCase().includes(taskName.toLowerCase()) && 
    t.status !== 'done'
  );
  
  if (task) {
    const updatedRow = [
      task.date,
      task.person,
      updates.task || task.task,
      updates.location || task.location,
      parseDate(updates.when) || task.when,  // Parse dates here
      updates.category || task.category,
      task.status
    ];
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `A${task.row}:G${task.row}`,
      valueInputOption: 'RAW',
      resource: { values: [updatedRow] }
    });
    
    return true;
  }
  return false;
}

// Complete all tasks
async function completeAllTasks() {
  const tasks = await getAllTasks();
  const activeTasks = tasks.filter(t => t.status !== 'done');
  
  let completed = 0;
  for (const task of activeTasks) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `G${task.row}`,
      valueInputOption: 'RAW',
      resource: { values: [['done']] }
    });
    completed++;
  }
  
  return completed;
}

// Delete task
async function deleteTask(taskName) {
  const tasks = await getAllTasks();
  const task = tasks.find(t => 
    t.task.toLowerCase().includes(taskName.toLowerCase()) && 
    t.status !== 'done'
  );
  
  if (task) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `A${task.row}:G${task.row}`,
    });
    return task.task;
  }
  return null;
}

// Delete all tasks
async function deleteAllTasks() {
  const tasks = await getAllTasks();
  const activeTasks = tasks.filter(t => t.status !== 'done');
  
  // Sort by row number descending to avoid index issues
  activeTasks.sort((a, b) => b.row - a.row);
  
  let deleted = 0;
  for (const task of activeTasks) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `A${task.row}:G${task.row}`,
    });
    deleted++;
  }
  
  return deleted;
}

// Format task list
function formatTaskList(tasks) {
  const active = tasks.filter(t => t.status !== 'done');
  
  if (active.length === 0) return 'Alles erledigt! 🎉';
  
  const byCategory = {};
  active.forEach(t => {
    const cat = t.category || 'general';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(t);
  });
  
  let response = `📋 Du hast ${active.length} Aufgaben:\n\n`;
  
  Object.entries(byCategory).forEach(([cat, tasks]) => {
    const emoji = {
      shopping: '🛒',
      household: '🏠',
      personal: '👤',
      work: '💼',
      general: '📋'
    }[cat] || '📋';
    
    response += `${emoji} ${cat.toUpperCase()}:\n`;
    tasks.forEach(t => {
      response += `• ${t.task}`;
      if (t.location) response += ` @${t.location}`;
      if (t.when) response += ` (${t.when})`;
      response += '\n';
    });
    response += '\n';
  });
  
  return response;
}

// AI handler
async function handleAI(text, tasks, userName, isGroup = false) {
  if (!openai) return null;
  
  try {
    const activeTasks = tasks.filter(t => t.status !== 'done');
    const context = `Current tasks: ${activeTasks.map(t => t.task).join(', ')}
User says: "${text}"
${isGroup ? 'This is in a group chat. Only respond if the message is clearly task-related or addressing the bot.' : ''}
Determine what action to take. Reply in German.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { 
          role: 'system', 
          content: `You are a task bot. Understand user intent and respond with JSON:
- For showing tasks: {"action": "show"}
- For adding: {"action": "add", "tasks": [{"task": "...", "location": "...", "when": "...", "category": "shopping|household|personal|work|general"}]}
- For completing: {"action": "complete", "taskName": "..."}
- For completing ALL: {"action": "completeAll"}
- For deleting one: {"action": "delete", "taskName": "..."}
- For deleting ALL: {"action": "deleteAll"}
- For updating when/date: {"action": "update", "taskName": "...", "when": "..."}
- For chat: {"action": "chat", "message": "..."}
- For ignoring (in groups): {"action": "ignore"}

When user says something like "X würde ich Y machen" or "X auf Y verschieben", update the task's when field.
When user says "lösche X" or "delete X", delete that specific task.
${isGroup ? 'In group chats, respond with {"action": "ignore"} for general conversation that is not task-related.' : ''}` 
        },
        { role: 'user', content: context }
      ],
      temperature: 0.3,
      response_format: { type: "json_object" }
    });
    
    const result = JSON.parse(completion.choices[0].message.content);
    console.log('AI result:', result);
    
    if (result.action === 'ignore') {
      return null;
    }
    
    if (result.action === 'show') {
      return formatTaskList(tasks);
    }
    
    if (result.action === 'add' && result.tasks) {
      const count = await addTasks(result.tasks, userName);
      return count > 0 ? `✅ ${count} neue Aufgaben hinzugefügt` : 'Diese Aufgaben existieren schon';
    }
    
    if (result.action === 'complete' && result.taskName) {
      const completed = await completeTask(result.taskName);
      return completed ? `✅ "${completed}" erledigt!` : `Nicht gefunden: "${result.taskName}"`;
    }
    
    if (result.action === 'completeAll') {
      const count = await completeAllTasks();
      return count > 0 ? `✅ Alle ${count} Aufgaben erledigt!` : 'Keine aktiven Aufgaben';
    }
    
    if (result.action === 'update' && result.taskName) {
      const success = await updateTask(result.taskName, { when: result.when });
      return success ? `✅ "${result.taskName}" verschoben auf ${result.when}` : `Nicht gefunden: "${result.taskName}"`;
    }
    
    if (result.action === 'delete' && result.taskName) {
      const deleted = await deleteTask(result.taskName);
      return deleted ? `🗑️ "${deleted}" gelöscht!` : `Nicht gefunden: "${result.taskName}"`;
    }
    
    if (result.action === 'deleteAll') {
      const count = await deleteAllTasks();
      return count > 0 ? `🗑️ Alle ${count} Aufgaben gelöscht!` : 'Keine aktiven Aufgaben';
    }
    
    if (result.action === 'chat' && result.message) {
      return result.message;
    }
    
    return null;
  } catch (error) {
    console.error('AI Error:', error.message);
    return null;
  }
}

// Message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;
  
  const userName = msg.from.first_name || 'User';
  const isGroup = msg.chat.type !== 'private';
  
  console.log(`Message from ${userName} in ${isGroup ? 'group' : 'private'}: ${text}`);
  
  try {
    // Remove duplicates first
    const duplicatesRemoved = await removeDuplicates();
    if (duplicatesRemoved > 0) {
      console.log(`Removed ${duplicatesRemoved} duplicate tasks`);
    }
    
    // Get current tasks
    const tasks = await getAllTasks();
    
    // Commands
    if (text === '/start' || text === '/help') {
      await bot.sendMessage(chatId, 
`Hallo! Ich bin dein Aufgaben-Bot 🤖

Sag einfach was du brauchst:
• "Was muss ich machen?"
• "Einkaufen bei Rewe"
• "Müll ist erledigt"

📊 Sheet: ${process.env.GOOGLE_SHEET_URL || 'Not set'}`);
      return;
    }
    
    // Try AI first
    if (openai) {
      const aiResponse = await handleAI(text, tasks, userName, isGroup);
      if (aiResponse) {
        await bot.sendMessage(chatId, aiResponse);
        return;
      } else if (isGroup) {
        // In group, AI decided to ignore this message
        return;
      }
    }
    
    // Fallback patterns if AI fails
    if (text.match(/aufgabe|liste|zeige|was muss/i)) {
      await bot.sendMessage(chatId, formatTaskList(tasks));
      return;
    }
    
    if (text.match(/erledigt|fertig|done/i)) {
      const taskName = text.replace(/erledigt|fertig|done/gi, '').trim();
      if (taskName) {
        const completed = await completeTask(taskName);
        if (completed) {
          await bot.sendMessage(chatId, `✅ "${completed}" erledigt!`);
        } else {
          await bot.sendMessage(chatId, `Nicht gefunden: "${taskName}"`);
        }
      }
      return;
    }
    
    // Default
    await bot.sendMessage(chatId, 'Ich verstehe nicht. Versuch: "zeige aufgaben" oder "X erledigt"');
    
  } catch (error) {
    console.error('Error:', error.message);
    await bot.sendMessage(chatId, '❌ Fehler: ' + error.message);
  }
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server on port ${PORT}`);
  
  // Set webhook after server is listening
  setTimeout(async () => {
    try {
      const WEBHOOK_URL = `https://task-bot-ai-production.up.railway.app/webhook`;
      
      console.log('Deleting old webhook...');
      await bot.deleteWebHook();
      
      console.log('Setting new webhook...');
      const result = await bot.setWebHook(WEBHOOK_URL);
      console.log('✅ Webhook set:', result);
      
      const info = await bot.getWebHookInfo();
      console.log('Webhook info:', info);
      
    } catch (error) {
      console.error('❌ Webhook error:', error.message);
    }
  }, 2000);
});

// Keep alive - IGNORE SIGTERM
process.on('SIGTERM', () => {
  console.log('SIGTERM received - IGNORING (staying alive)');
});

process.on('SIGINT', () => {
  console.log('SIGINT received - IGNORING (staying alive)');
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

process.stdin.resume();

// Heartbeat
setInterval(() => {
  console.log('💓 Bot alive at', new Date().toISOString());
}, 30000);

console.log('Starting bot WITH AI...');
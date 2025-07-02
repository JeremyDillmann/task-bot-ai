// bot.js - Full version with AI
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

// Complete task
async function completeTask(taskName) {
  const tasks = await getAllTasks();
  const task = tasks.find(t => 
    t.task.toLowerCase().includes(taskName.toLowerCase()) && 
    t.status !== 'done'
  );
  
  if (task) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `G${task.row}`,
      valueInputOption: 'RAW',
      resource: { values: [['done']] }
    });
    return task.task;
  }
  return null;
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

// AI handler with tool calling
async function handleAI(text, tasks, userName, isGroup = false) {
  if (!openai) return null;
  
  try {
    const activeTasks = tasks.filter(t => t.status !== 'done');
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        { 
          role: 'system', 
          content: `Du bist ein hilfreicher Aufgaben-Bot. Du antwortest IMMER auf jede Nachricht. 
          
WICHTIG: Wenn der User mehrere Aufgaben in einer Nachricht erwähnt (durch Kommas, "und", oder neue Sätze getrennt), erkenne ALLE Aufgaben und füge sie einzeln hinzu.

Beispiel: "Ich muss einkaufen, Bad putzen und Müll rausbringen" = 3 separate Aufgaben

Antworte auf Deutsch.`
        },
        { 
          role: 'user', 
          content: `Aktuelle Aufgaben: ${activeTasks.map(t => `"${t.task}" (Ort: ${t.location || 'überall'}, Wann: ${t.when || 'flexibel'})`).join(', ')}\n\nUser sagt: "${text}"`
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'show_tasks',
            description: 'Zeige alle Aufgaben'
          }
        },
        {
          type: 'function',
          function: {
            name: 'add_tasks',
            description: 'Füge eine oder mehrere neue Aufgaben hinzu',
            parameters: {
              type: 'object',
              properties: {
                tasks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      task: { type: 'string', description: 'Aufgabenbeschreibung' },
                      location: { type: 'string', description: 'Ort (optional)' },
                      when: { type: 'string', description: 'Wann (z.B. morgen, Montag)' },
                      category: { 
                        type: 'string', 
                        enum: ['shopping', 'household', 'personal', 'work', 'general'],
                        description: 'Kategorie'
                      }
                    },
                    required: ['task']
                  },
                  description: 'Liste von Aufgaben'
                }
              },
              required: ['tasks']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'complete_task',
            description: 'Markiere eine Aufgabe als erledigt',
            parameters: {
              type: 'object',
              properties: {
                taskName: { type: 'string', description: 'Name der Aufgabe' }
              },
              required: ['taskName']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'complete_all_tasks',
            description: 'Markiere ALLE Aufgaben als erledigt'
          }
        },
        {
          type: 'function',
          function: {
            name: 'delete_task',
            description: 'Lösche eine Aufgabe',
            parameters: {
              type: 'object',
              properties: {
                taskName: { type: 'string', description: 'Name der Aufgabe' }
              },
              required: ['taskName']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'delete_all_tasks',
            description: 'Lösche ALLE Aufgaben'
          }
        },
        {
          type: 'function',
          function: {
            name: 'update_task_date',
            description: 'Ändere das Datum einer Aufgabe',
            parameters: {
              type: 'object',
              properties: {
                taskName: { type: 'string', description: 'Name der Aufgabe' },
                when: { type: 'string', description: 'Neues Datum' }
              },
              required: ['taskName', 'when']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'suggest_tasks',
            description: 'Schlage passende Aufgaben vor basierend auf verfügbarer Zeit und/oder Ort',
            parameters: {
              type: 'object',
              properties: {
                time_available: { type: 'string', description: 'Verfügbare Zeit (z.B. "10 Minuten", "1 Stunde")' },
                location: { type: 'string', description: 'Aktueller Ort (z.B. "zuhause", "unterwegs", "Büro")' }
              }
            }
          }
        }
      ],
      tool_choice: 'auto',
      temperature: 0.3
    });
    
    const message = completion.choices[0].message;
    
    // Handle tool calls
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        
        console.log(`Tool call: ${functionName}`, args);
        
        switch (functionName) {
          case 'show_tasks':
            return formatTaskList(tasks);
            
          case 'add_tasks':
            const count = await addTasks(args.tasks, userName);
            if (count === 1) {
              return `✅ Aufgabe hinzugefügt: "${args.tasks[0].task}"`;
            } else if (count > 1) {
              return `✅ ${count} Aufgaben hinzugefügt!`;
            } else {
              return 'Diese Aufgaben existieren schon';
            }
            
          case 'complete_task':
            const completed = await completeTask(args.taskName);
            return completed ? `✅ "${completed}" erledigt!` : `Nicht gefunden: "${args.taskName}"`;
            
          case 'complete_all_tasks':
            const allCompleted = await completeAllTasks();
            return allCompleted > 0 ? `✅ Alle ${allCompleted} Aufgaben erledigt!` : 'Keine aktiven Aufgaben';
            
          case 'delete_task':
            const deleted = await deleteTask(args.taskName);
            return deleted ? `🗑️ "${deleted}" gelöscht!` : `Nicht gefunden: "${args.taskName}"`;
            
          case 'delete_all_tasks':
            const allDeleted = await deleteAllTasks();
            return allDeleted > 0 ? `🗑️ Alle ${allDeleted} Aufgaben gelöscht!` : 'Keine aktiven Aufgaben';
            
          case 'update_task_date':
            const updated = await updateTask(args.taskName, { when: args.when });
            return updated ? `✅ "${args.taskName}" verschoben auf ${parseDate(args.when)}` : `Nicht gefunden: "${args.taskName}"`;
            
          case 'suggest_tasks':
            return suggestTasks(tasks, args.time_available, args.location);
        }
      }
    }
    
    // Always return something - either tool result or message content
    return message.content || 'Ich bin mir nicht sicher, was du meinst. Kannst du es anders formulieren?';
    
  } catch (error) {
    console.error('AI Error:', error.message);
    return null;
  }
}

// Suggest tasks based on time and location
function suggestTasks(tasks, timeAvailable, location) {
  const active = tasks.filter(t => t.status !== 'done');
  
  if (active.length === 0) {
    return '🎉 Super! Du hast keine offenen Aufgaben!';
  }
  
  // Parse time to minutes
  let minutes = 0;
  if (timeAvailable) {
    const timeMatch = timeAvailable.match(/(\d+)\s*(minute|minuten|stunde|stunden|hour)/i);
    if (timeMatch) {
      const value = parseInt(timeMatch[1]);
      const unit = timeMatch[2].toLowerCase();
      if (unit.includes('stunde') || unit.includes('hour')) {
        minutes = value * 60;
      } else {
        minutes = value;
      }
    }
  }
  
  // Filter tasks by location and estimated time
  let suggested = active;
  
  // Location filtering
  if (location) {
    const locationLower = location.toLowerCase();
    if (locationLower.includes('zuhause') || locationLower.includes('home')) {
      suggested = suggested.filter(t => 
        !t.location || 
        t.location.toLowerCase().includes('zuhause') ||
        t.category === 'household'
      );
    } else if (locationLower.includes('unterwegs') || locationLower.includes('draußen')) {
      suggested = suggested.filter(t => 
        t.location && !t.location.toLowerCase().includes('zuhause') ||
        t.category === 'shopping'
      );
    }
  }
  
  // Time filtering - quick tasks for short time
  if (minutes > 0 && minutes <= 15) {
    // Prioritize quick tasks
    const quickTasks = ['geschirrspüler', 'müll', 'aufräumen', 'saugroboter'];
    suggested = suggested.filter(t => 
      quickTasks.some(quick => t.task.toLowerCase().includes(quick))
    );
  } else if (minutes > 15 && minutes <= 30) {
    // Medium tasks
    const mediumTasks = ['saugen', 'bad', 'küche', 'einkaufen'];
    suggested = suggested.filter(t => 
      mediumTasks.some(medium => t.task.toLowerCase().includes(medium))
    );
  }
  
  // Build response
  if (suggested.length === 0) {
    return `Hmm, ich finde keine passenden Aufgaben für ${timeAvailable || ''} ${location || ''}. Hier sind alle deine Aufgaben:\n\n${formatTaskList(tasks)}`;
  }
  
  let response = `💡 Vorschläge für ${timeAvailable || ''} ${location || ''}:\n\n`;
  
  suggested.forEach(t => {
    response += `• ${t.task}`;
    if (t.location) response += ` @${t.location}`;
    response += '\n';
  });
  
  if (suggested.length < active.length) {
    response += `\n(${active.length - suggested.length} weitere Aufgaben vorhanden)`;
  }
  
  return response;
}

// Message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  let text = msg.text?.trim();
  if (!text) return;
  
  const userName = msg.from.first_name || 'User';
  const isGroup = msg.chat.type !== 'private';
  let isMentioned = false;
  
  // Check if bot is mentioned
  if (isGroup) {
    const botUsername = (await bot.getMe()).username;
    isMentioned = text.includes(`@${botUsername}`);
    if (isMentioned) {
      // Remove bot mention from text for cleaner processing
      text = text.replace(`@${botUsername}`, '').trim();
    }
  }
  
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
• "Lösche Bad putzen"

📊 Sheet: ${process.env.GOOGLE_SHEET_URL || 'Not set'}`);
      return;
    }
    
    // Try AI first
    if (openai) {
      const aiResponse = await handleAI(text, tasks, userName, false); // Always respond, don't check group status
      if (aiResponse) {
        await bot.sendMessage(chatId, aiResponse);
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
// bot.js - Clean version without HTTP server
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { google } = require('googleapis');

// Initialize
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Sheets auth
let auth;
if (process.env.GOOGLE_CREDENTIALS) {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
} else {
  auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

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
    console.error('Error getting tasks:', error);
    return [];
  }
}

// Remove duplicates
async function removeDuplicates() {
  try {
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
  } catch (error) {
    console.error('Error removing duplicates:', error);
    return 0;
  }
}

// Update existing task
async function updateTask(oldTaskName, newData) {
  const tasks = await getAllTasks();
  const task = tasks.find(t => 
    t.task.toLowerCase().includes(oldTaskName.toLowerCase()) && 
    t.status !== 'done'
  );
  
  if (task) {
    const updatedRow = [
      task.date,
      task.person,
      newData.task || task.task,
      newData.location !== undefined ? newData.location : task.location,
      newData.when !== undefined ? newData.when : task.when,
      newData.category || task.category,
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

// Add tasks
async function addTasks(tasks, userName) {
  const existingTasks = await getAllTasks();
  const date = new Date().toISOString().split('T')[0];
  const newTasks = [];
  const duplicates = [];
  
  for (const task of tasks) {
    const exists = existingTasks.some(existing => 
      existing.task.toLowerCase() === task.task.toLowerCase() &&
      existing.status !== 'done'
    );
    
    if (exists) {
      duplicates.push(task.task);
    } else {
      newTasks.push([
        date,
        userName,
        task.task,
        task.location || '',
        task.when || '',
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
  
  return { added: newTasks.length, duplicates: duplicates.length };
}

// Mark task as done
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

// Format task list
function formatTaskList(tasks) {
  const active = tasks.filter(t => t.status !== 'done');
  
  if (active.length === 0) return 'Alles erledigt! 🎉 Keine aktiven Aufgaben.';
  
  const byCategory = active.reduce((acc, t) => {
    const cat = t.category || 'general';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(t);
    return acc;
  }, {});
  
  let response = `Du hast ${active.length} Aufgaben:\n\n`;
  
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

// AI handler for natural language
async function handleMessage(text, userName) {
  try {
    const tasks = await getAllTasks();
    
    const context = `
Aktuelle Aufgaben:
${tasks.filter(t => t.status !== 'done').map(t => `- ${t.task} (${t.location || ''}, ${t.when || ''})`).join('\n')}

User sagt: "${text}"

Verstehe was der User will und führe die passende Aktion aus.
Antworte KURZ und DIREKT auf Deutsch.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        { 
          role: 'system', 
          content: 'Du bist ein direkter Aufgaben-Bot. Keine langen Erklärungen, nur kurze hilfreiche Antworten.' 
        },
        { role: 'user', content: context }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'task_action',
          description: 'Perform task actions',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['show_tasks', 'add_tasks', 'complete_task', 'update_task', 'conversation']
              },
              tasks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    task: { type: 'string' },
                    location: { type: 'string' },
                    when: { type: 'string' },
                    category: { type: 'string' }
                  }
                }
              },
              complete: {
                type: 'string',
                description: 'Task name to complete'
              },
              update: {
                type: 'object',
                properties: {
                  old_task: { type: 'string' },
                  new_task: { type: 'string' },
                  new_location: { type: 'string' },
                  new_when: { type: 'string' }
                }
              }
            }
          }
        }
      }],
      temperature: 0.5
    });

    const message = response.choices[0].message;
    
    // Handle tool calls
    if (message.tool_calls) {
      const toolCall = message.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);
      
      if (args.action === 'show_tasks') {
        return formatTaskList(tasks);
      }
      
      if (args.action === 'add_tasks' && args.tasks) {
        const result = await addTasks(args.tasks, userName);
        if (result.added > 0) {
          return `✅ ${result.added} neue Aufgaben hinzugefügt`;
        }
        if (result.duplicates > 0) {
          return `Diese Aufgaben hast du schon.`;
        }
        return 'Keine neuen Aufgaben.';
      }
      
      if (args.action === 'complete_task' && args.complete) {
        const completed = await completeTask(args.complete);
        if (completed) {
          return `✅ "${completed}" erledigt!`;
        }
        return `Finde "${args.complete}" nicht.`;
      }
      
      if (args.action === 'update_task' && args.update) {
        const success = await updateTask(args.update.old_task, {
          task: args.update.new_task,
          location: args.update.new_location,
          when: args.update.new_when
        });
        if (success) {
          return `✅ Geändert!`;
        }
        return `Konnte "${args.update.old_task}" nicht finden.`;
      }
    }
    
    return message.content || 'Was meinst du?';
    
  } catch (error) {
    console.error('AI Error:', error);
    // Fallback ohne AI
    if (text.match(/aufgabe|liste|zeige|was muss|was soll/i)) {
      const tasks = await getAllTasks();
      return formatTaskList(tasks);
    }
    if (text.match(/erledigt|fertig|done/i)) {
      const taskName = text.replace(/erledigt|fertig|done/gi, '').trim();
      if (taskName) {
        const completed = await completeTask(taskName);
        if (completed) {
          return `✅ "${completed}" erledigt!`;
        }
        return `Finde "${taskName}" nicht.`;
      }
      return 'Was ist erledigt?';
    }
    if (text.match(/änder|umbenenn|statt/i)) {
      return 'Zum Ändern sage: "Ändere X zu Y"';
    }
    return 'Verstehe ich nicht. Versuch: "zeige aufgaben" oder "X erledigt"';
  }
}

// Main message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;
  
  const userName = msg.from.first_name || 'User';
  
  try {
    bot.sendChatAction(chatId, 'typing');
    
    // Remove duplicates silently
    await removeDuplicates();
    
    // Help command
    if (text === '/start' || text === '/help') {
      bot.sendMessage(chatId, 
`Hey! Schreib einfach normal mit mir:

- "Was muss ich machen?"
- "Müll ist erledigt"
- "Ändere X zu Y"
- "Ich muss morgen einkaufen"

📊 Sheet: ${process.env.GOOGLE_SHEET_URL}`);
      return;
    }
    
    // Direct sheet link
    if (text.match(/^(link|sheet|edit)$/i)) {
      bot.sendMessage(chatId, `📊 ${process.env.GOOGLE_SHEET_URL}`);
      return;
    }
    
    // Natural language processing
    const response = await handleMessage(text, userName);
    bot.sendMessage(chatId, response);
    
  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, 'Fehler. Nochmal versuchen!');
  }
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Clean duplicates on startup
removeDuplicates().then(count => {
  if (count > 0) {
    console.log(`🧹 ${count} Duplikate entfernt`);
  }
});

// Startup
console.log('🚀 Bot läuft mit GPT-4!');
console.log(`📊 Sheet: ${process.env.GOOGLE_SHEET_URL}`);

// WICHTIG: Prevent process from exiting
// This keeps the bot running on Railway
require('events').EventEmitter.defaultMaxListeners = 0;
process.stdin.resume();
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nBot stopping...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nBot stopping...');
  bot.stopPolling();
  process.exit(0);
});
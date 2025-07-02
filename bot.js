// bot.js - With Railway HTTP server fix (using Webhooks)
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { google } = require('googleapis');
const express = require('express');

// --- 1. Basic Setup ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
// This is the public URL of your Railway deployment.
// Railway provides this as an environment variable.
const RAILWAY_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`; 

// --- 2. Initialize Bot (WITHOUT POLLING) ---
const bot = new TelegramBot(TOKEN);

// --- 3. Set up Webhook ---
// We create a secret path to ensure only Telegram can reach our bot.
const webhookPath = `/telegram/${TOKEN}`;
const webhookUrl = `${RAILWAY_URL}${webhookPath}`;

// Tell Telegram where to send updates.
bot.setWebHook(webhookUrl).then(() => {
    console.log(`🚀 Webhook set to ${webhookUrl}`);
}).catch(console.error);

// --- 4. Initialize Express Server ---
const app = express();
// Use express.json() to parse incoming webhook requests from Telegram
app.use(express.json()); 

// Health check endpoints
app.get('/', (req, res) => {
  res.send('Task Bot is running!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// --- 5. Create a POST route to receive updates from Telegram ---
app.post(webhookPath, (req, res) => {
  // This function processes the update and emits events like 'message'
  bot.processUpdate(req.body);
  // Respond to Telegram immediately to acknowledge receipt
  res.sendStatus(200); 
});

// Start HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP Server listening on port ${PORT}`);
});

// Initialize APIs
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Sheets auth (same as your code)
let auth;
if (process.env.GOOGLE_CREDENTIALS) {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
} else {
  // This fallback might not work on Railway unless you upload the file
  auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}
const sheets = google.sheets({ version: 'v4', auth });

// --- All your helper functions (getAllTasks, addTasks, etc.) remain here ---
// ... I've included them below with bug fixes ...

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

    if (toDelete.length === 0) return 0;
    
    // Deleting rows one by one is inefficient. Better to create a batch request.
    // However, for simplicity and to stick to your original logic:
    toDelete.sort((a, b) => b - a); // Delete from bottom to top to not mess up row indices
    for (const row of toDelete) {
      // FIX: Range was incorrect `A$:G$` -> `A${row}:G${row}`
      await sheets.spreadsheets.values.clear({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `A${row}:G${row}`, // This is not the best way, see below *
      });
      // * A better approach is batchUpdate with deleteDimension requests,
      // but clearing values works if you don't mind empty rows.
    }
    return toDelete.length;
  } catch (error) {
    console.error('Error removing duplicates:', error);
    return 0;
  }
}

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
        // FIX: String interpolation
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
      // Consider a cheaper/faster model like gpt-4o or gpt-3.5-turbo if latency is an issue
      model: 'gpt-4o', 
      messages: [
        { role: 'system', content: 'Du bist ein direkter Aufgaben-Bot. Keine langen Erklärungen, nur kurze hilfreiche Antworten.' },
        { role: 'user', content: context }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'task_action',
          description: 'Perform task actions like showing, adding, completing, or updating tasks.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['show_tasks', 'add_tasks', 'complete_task', 'update_task', 'conversation'] },
              tasks: { type: 'array', items: { type: 'object', properties: { task: { type: 'string' }, location: { type: 'string' }, when: { type: 'string' }, category: { type: 'string' } } } },
              complete: { type: 'string', description: 'Task name to complete' },
              update: { type: 'object', properties: { old_task: { type: 'string' }, new_task: { type: 'string' }, new_location: { type: 'string' }, new_when: { type: 'string' } } }
            },
            required: ["action"]
          }
        }
      }],
      temperature: 0.5
    });

    const message = response.choices[0].message;
    if (message.tool_calls) {
      const toolCall = message.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);
      if (args.action === 'show_tasks') {
        return formatTaskList(tasks);
      }
      if (args.action === 'add_tasks' && args.tasks) {
        const result = await addTasks(args.tasks, userName);
        let responseText = '';
        if (result.added > 0) responseText += `✅ ${result.added} neue Aufgabe(n) hinzugefügt.`;
        if (result.duplicates > 0) responseText += ` (${result.duplicates} war(en) bereits vorhanden.)`;
        return responseText.trim() || 'Keine Aufgaben zum Hinzufügen gefunden.';
      }
      if (args.action === 'complete_task' && args.complete) {
        const completed = await completeTask(args.complete);
        // FIX: String interpolation
        if (completed) return `✅ "${completed}" erledigt!`;
        return `Konnte die Aufgabe "${args.complete}" nicht finden.`;
      }
      if (args.action === 'update_task' && args.update) {
        const success = await updateTask(args.update.old_task, { task: args.update.new_task, location: args.update.new_location, when: args.update.new_when });
        if (success) return `✅ Geändert!`;
        return `Konnte "${args.update.old_task}" nicht finden zum Ändern.`;
      }
    }
    return message.content || 'Ich bin mir nicht sicher, was du meinst. Kannst du es anders formulieren?';
  } catch (error) {
    console.error('AI Error:', error);
    // AI Fallback logic... (same as your code)
    if (text.match(/aufgabe|liste|zeige|was muss|was soll/i)) {
      const tasks = await getAllTasks();
      return formatTaskList(tasks);
    }
    return 'Entschuldigung, es gab einen Fehler mit der AI. Bitte versuche es einfacher oder später noch einmal.';
  }
}

// Main message handler (now works with webhooks automatically)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;
  const userName = msg.from.first_name || 'User';

  try {
    await bot.sendChatAction(chatId, 'typing');
    await removeDuplicates(); // Silently remove duplicates
    
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
    if (text.match(/^(link|sheet|edit)$/i)) {
      bot.sendMessage(chatId, `📊 ${process.env.GOOGLE_SHEET_URL}`);
      return;
    }
    const response = await handleMessage(text, userName);
    bot.sendMessage(chatId, response);
  } catch (error) {
    console.error('Main Error:', error);
    bot.sendMessage(chatId, 'Uff, da ist was schiefgelaufen. Bitte versuche es später noch einmal.');
  }
});

// --- 6. Remove Polling-specific error handling ---
// bot.on('polling_error', ...) is no longer needed.

bot.on('error', (error) => {
  console.error('General Bot Error:', error);
});

// Clean duplicates on startup
removeDuplicates().then(count => {
  if (count > 0) {
    // FIX: String interpolation
    console.log(`🧹 ${count} Duplikate beim Start entfernt.`);
  }
});

console.log('🚀 Bot läuft im Webhook-Modus!');
console.log(`📊 Sheet: ${process.env.GOOGLE_SHEET_URL}`);
// FIX: String interpolation
console.log(`🌐 Health endpoint: ${RAILWAY_URL}/health`);

// Keep-alive pings are not strictly necessary as the server itself proves it's alive,
// but it can be useful for logging.
setInterval(() => {
  console.log(`Bot is healthy at ${new Date().toISOString()}`);
}, 300000); // Every 5 minutes

// Graceful shutdown (simplified)
const gracefulShutdown = (signal) => {
    // FIX: String interpolation
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    // No need to stop polling. The server will just stop listening.
    process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

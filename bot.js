// bot.js - NO AI VERSION - Test first!
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const express = require('express');

// Express server
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Initialize Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

// Health check - log all requests
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get('/', (req, res) => res.send('Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

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
      task: row[2] || '',
      location: row[3] || '',
      when: row[4] || '',
      status: row[6] || 'pending'
    }));
  } catch (error) {
    console.error('Sheets error:', error.message);
    return [];
  }
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

// Message handler - SUPER SIMPLE
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;
  
  console.log(`Got message: ${text}`);
  
  try {
    // Test command
    if (text === '/test') {
      await bot.sendMessage(chatId, '✅ Bot works!');
      return;
    }
    
    // Show tasks
    if (text.match(/aufgabe|liste|zeige/i)) {
      const tasks = await getAllTasks();
      const active = tasks.filter(t => t.status !== 'done');
      
      if (active.length === 0) {
        await bot.sendMessage(chatId, 'Keine Aufgaben! 🎉');
      } else {
        let message = `📋 ${active.length} Aufgaben:\n\n`;
        active.forEach(t => {
          message += `• ${t.task}`;
          if (t.location) message += ` @${t.location}`;
          message += '\n';
        });
        await bot.sendMessage(chatId, message);
      }
      return;
    }
    
    // Complete task
    if (text.match(/erledigt|done/i)) {
      const taskName = text.replace(/erledigt|done/gi, '').trim();
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
    await bot.sendMessage(chatId, 'Commands:\n/test\nzeige aufgaben\nX erledigt');
    
  } catch (error) {
    console.error('Error:', error.message);
    await bot.sendMessage(chatId, '❌ Error: ' + error.message);
  }
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server on port ${PORT}`);
  
  // Set webhook after server is listening
  setTimeout(async () => {
    try {
      const WEBHOOK_URL = `https://task-bot-ai-production.up.railway.app/webhook`;
      
      // First delete any existing webhook
      console.log('Deleting old webhook...');
      await bot.deleteWebHook();
      
      // Then set new webhook
      console.log('Setting new webhook...');
      const result = await bot.setWebHook(WEBHOOK_URL);
      console.log('✅ Webhook set to:', WEBHOOK_URL, 'Result:', result);
      
      // Verify webhook
      const info = await bot.getWebHookInfo();
      console.log('Webhook info:', info);
      
    } catch (error) {
      console.error('❌ Webhook error:', error.message);
      // Don't exit on webhook error
    }
  }, 2000);
});

// Keep process alive
process.on('SIGTERM', async () => {
  console.log('SIGTERM received - ignoring to stay alive');
  // DON'T exit on SIGTERM in production
  // Railway sends these but we want to keep running
});

process.on('SIGINT', () => {
  console.log('SIGINT received - shutting down');
  process.exit(0);
});

// Prevent process from exiting
process.stdin.resume();

// Heartbeat
setInterval(() => {
  console.log('💓 Bot alive at', new Date().toISOString());
}, 30000); // Every 30 seconds

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

console.log('Starting bot WITHOUT AI...');
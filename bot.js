// bot.js - Robust version with better shared task handling
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

// Google Sheets setup with error handling
let sheets = null;
try {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  if (credentials.client_email) {
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log('✅ Google Sheets initialized');
  } else {
    console.error('❌ Invalid Google credentials');
  }
} catch (error) {
  console.error('❌ Google Sheets init error:', error.message);
}

// Track last action for undo
let lastAction = null;

// Constants for shared task handling
const SHARED_TASK_INDICATORS = ['both', 'beide', 'zusammen', 'gemeinsam', 'wir'];
const SHARED_PERSON_VALUE = 'Beide'; // Standardized value for shared tasks

// Helper to normalize person names
function normalizePerson(person) {
  if (!person) return SHARED_PERSON_VALUE; // Default to shared
  const lower = person.toLowerCase().trim();
  
  // Check if it's a shared indicator
  if (SHARED_TASK_INDICATORS.includes(lower)) {
    return SHARED_PERSON_VALUE;
  }
  
  // Normalize known names
  const nameMap = {
    'moana': 'Moana',
    'jeremy': 'Jeremy',
    'ich': null, // Will be replaced with userName in calling function
    'meine': null, // Will be replaced with userName in calling function
    'mir': null, // Will be replaced with userName in calling function
    'mich': null, // Will be replaced with userName in calling function
  };
  
  // If it's a known name, return the normalized version
  if (nameMap.hasOwnProperty(lower)) {
    return nameMap[lower];
  }
  
  // If it's not recognized, return the original (could be a name we don't know)
  return person;
}

// Helper to parse dates
function parseDate(dateStr) {
  if (!dateStr) return '';
  
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
  
  const lower = dateStr.toLowerCase().trim();
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

// Get all tasks with better empty row handling
async function getAllTasks() {
  if (!sheets) {
    console.error('Google Sheets not initialized');
    return [];
  }
  
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'A2:G1000', // Get more rows to ensure we don't miss any
    });
    
    const rows = response.data.values || [];
    const tasks = [];
    
    // Process rows and skip empty ones
    rows.forEach((row, index) => {
      // Skip completely empty rows or rows with only partial data
      if (row && row.length > 0 && (row[2] || '').trim() !== '') { // Check if task (column C) exists
        tasks.push({
          row: index + 2,
          date: row[0] || '',
          person: row[1] || '',
          task: row[2] || '',
          location: row[3] || '',
          when: row[4] || '',
          category: row[5] || 'general',
          status: row[6] || 'pending'
        });
      }
    });
    
    return tasks;
  } catch (error) {
    console.error('Sheets error:', error.message);
    return [];
  }
}

// Add tasks with better validation and proper sheets handling
async function addTasks(tasks, userName) {
  if (!sheets) {
    throw new Error('Google Sheets nicht verfügbar');
  }
  
  const existingTasks = await getAllTasks();
  const date = new Date().toISOString().split('T')[0];
  const newTasks = [];
  const addedTaskInfo = [];
  
  for (const task of tasks) {
    // Validate task
    if (!task.task || task.task.trim() === '') continue;
    
    // DEFAULT TO "BEIDE" - Only use individual assignment if explicitly stated
    let assignedPerson = SHARED_PERSON_VALUE; // Default to "Beide"
    
    if (task.assignedTo) {
      const normalized = normalizePerson(task.assignedTo);
      // Only assign to individual if it's not a shared indicator
      if (normalized && normalized !== SHARED_PERSON_VALUE) {
        assignedPerson = normalized === null ? userName : normalized;
      }
    }
    
    // Check for duplicates
    const exists = existingTasks.some(existing => 
      existing.task.toLowerCase() === task.task.toLowerCase() &&
      existing.person === assignedPerson &&
      existing.status !== 'done'
    );
    
    if (!exists) {
      // Ensure shared tasks have proper category
      let category = task.category || 'general';
      if (assignedPerson === SHARED_PERSON_VALUE && (category === 'general' || !category)) {
        category = 'both';
      }
      
      newTasks.push([
        date,
        assignedPerson,
        task.task.trim(),
        task.location || '',
        parseDate(task.when) || '',
        category,
        'pending'
      ]);
      
      addedTaskInfo.push({
        task: task.task.trim(),
        person: assignedPerson,
        isShared: assignedPerson === SHARED_PERSON_VALUE
      });
    }
  }
  
  if (newTasks.length > 0) {
    // Find the actual last row with data
    let lastRow = 2; // Start after header
    for (const task of existingTasks) {
      if (task.row > lastRow) {
        lastRow = task.row;
      }
    }
    lastRow = lastRow + 1; // Next available row
    
    // Use update instead of append for more control
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `A${lastRow}:G${lastRow + newTasks.length - 1}`,
      valueInputOption: 'RAW',
      resource: { values: newTasks }
    });
    
    console.log(`Added ${newTasks.length} tasks starting at row ${lastRow}`);
    
    // Track for undo
    lastAction = {
      type: 'add',
      tasks: addedTaskInfo.map(t => t.task),
      timestamp: Date.now()
    };
  }
  
  return { count: newTasks.length, addedInfo: addedTaskInfo };
}

// Complete task
async function completeTask(taskName) {
  if (!sheets) {
    throw new Error('Google Sheets nicht verfügbar');
  }
  
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
    
    lastAction = {
      type: 'complete',
      task: task.task,
      timestamp: Date.now()
    };
    
    return task.task;
  }
  return null;
}

// Update task
async function updateTask(taskName, updates) {
  if (!sheets) {
    throw new Error('Google Sheets nicht verfügbar');
  }
  
  const tasks = await getAllTasks();
  const task = tasks.find(t => 
    t.task.toLowerCase().includes(taskName.toLowerCase()) && 
    t.status !== 'done'
  );
  
  if (task) {
    // Normalize person if updating
    let person = task.person;
    if (updates.person) {
      person = normalizePerson(updates.person) || updates.person;
    }
    
    const updatedRow = [
      task.date,
      person,
      updates.task || task.task,
      updates.location || task.location,
      parseDate(updates.when) || task.when,
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
  if (!sheets) {
    throw new Error('Google Sheets nicht verfügbar');
  }
  
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
  if (!sheets) {
    throw new Error('Google Sheets nicht verfügbar');
  }
  
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
    
    lastAction = {
      type: 'delete',
      task: task.task,
      timestamp: Date.now()
    };
    
    return task.task;
  }
  return null;
}

// Delete all tasks
async function deleteAllTasks() {
  if (!sheets) {
    throw new Error('Google Sheets nicht verfügbar');
  }
  
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
  if (!sheets) return 0;
  
  const tasks = await getAllTasks();
  const seen = new Map();
  const toDelete = [];
  
  tasks.forEach(task => {
    if (task.status === 'done') return;
    const key = `${task.task.toLowerCase().trim()}_${task.person}_${task.location}_${task.when}`;
    
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

// Undo last action
async function undoLastAction() {
  if (!lastAction || Date.now() - lastAction.timestamp > 5 * 60 * 1000) {
    return 'Keine kürzliche Aktion zum Rückgängigmachen gefunden (oder älter als 5 Minuten)';
  }
  
  switch (lastAction.type) {
    case 'add':
      let deletedCount = 0;
      for (const taskName of lastAction.tasks) {
        const deleted = await deleteTask(taskName);
        if (deleted) deletedCount++;
      }
      lastAction = null;
      return deletedCount > 0 
        ? `✅ ${deletedCount} kürzlich hinzugefügte Aufgabe(n) gelöscht`
        : 'Konnte die Aufgaben nicht finden';
      
    case 'complete':
      return '⚠️ Erledigte Aufgaben können nicht rückgängig gemacht werden';
      
    case 'delete':
      return '⚠️ Gelöschte Aufgaben können nicht wiederhergestellt werden';
      
    default:
      return 'Keine Aktion zum Rückgängigmachen';
  }
}

// Format task list with better shared task handling
function formatTaskList(tasks, filterPerson = null) {
  const active = tasks.filter(t => t.status !== 'done');
  
  if (active.length === 0) return 'Alles erledigt! 🎉';
  
  // Normalize filter person
  const normalizedFilter = filterPerson ? normalizePerson(filterPerson) : null;
  
  // Filter by person if specified
  let filtered = active;
  if (normalizedFilter && normalizedFilter !== SHARED_PERSON_VALUE) {
    // When filtering by a specific person, include their tasks AND shared tasks
    filtered = active.filter(t => {
      const taskPerson = normalizePerson(t.person);
      return taskPerson === normalizedFilter || taskPerson === SHARED_PERSON_VALUE;
    });
  } else if (normalizedFilter === SHARED_PERSON_VALUE) {
    // When specifically asking for shared tasks, show only shared
    filtered = active.filter(t => normalizePerson(t.person) === SHARED_PERSON_VALUE);
  }
  
  if (normalizedFilter && filtered.length === 0) {
    return `Keine Aufgaben für ${filterPerson} gefunden.`;
  }
  
  // Group by category
  const byCategory = {};
  filtered.forEach(t => {
    const cat = t.category || 'general';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(t);
  });
  
  // Build response
  let response = '';
  if (normalizedFilter && normalizedFilter !== SHARED_PERSON_VALUE) {
    response = `📋 ${filterPerson}'s Aufgaben (${filtered.length}):\n\n`;
  } else if (normalizedFilter === SHARED_PERSON_VALUE) {
    response = `👥 Gemeinsame Aufgaben (${filtered.length}):\n\n`;
  } else {
    response = `📋 Alle Aufgaben (${active.length}):\n\n`;
  }
  
  // Show shared tasks first if they exist
  if (byCategory['both']) {
    response += `👥 GEMEINSAME AUFGABEN:\n`;
    byCategory['both'].forEach(t => {
      response += `• ${t.task}`;
      if (t.location) response += ` @${t.location}`;
      if (t.when) response += ` (${t.when})`;
      response += '\n';
    });
    response += '\n';
    delete byCategory['both'];
  }
  
  // Show other categories
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
      // Show person only if not filtered and not a shared task
      if (!normalizedFilter && t.person !== SHARED_PERSON_VALUE) {
        response += ` (nur ${t.person})`;
      }
      if (t.location) response += ` @${t.location}`;
      if (t.when) response += ` (${t.when})`;
      response += '\n';
    });
    response += '\n';
  });
  
  return response.trim();
}

// AI handler with better shared task detection
async function handleAI(text, tasks, userName, isGroup = false) {
  if (!openai) return null;
  
  try {
    const activeTasks = tasks.filter(t => t.status !== 'done');
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1', // or 'gpt-4-turbo' for faster GPT-4
      messages: [
        { 
          role: 'system', 
          content: `Du bist ein hilfreicher Aufgaben-Bot für ein Paar (Moana und Jeremy). 
          
WICHTIGSTE REGEL: ALLE AUFGABEN SIND STANDARDMÄSSIG FÜR BEIDE!

KRITISCHE REGELN:
1. DEFAULT = BEIDE: Jede Aufgabe ist automatisch für beide, es sei denn:
   - Jemand sagt explizit "ich muss", "für mich", "meine Aufgabe"
   - Eine spezifische Person wird genannt: "Jeremy muss", "Moana soll", "für Jeremy"
   
2. Diese Aufgaben sind FÜR BEIDE (Standard):
   - "Müll rausbringen" → assignedTo: "Beide", category: "both"
   - "Edeka - Milch" → assignedTo: "Beide", category: "shopping"
   - "Wohnung putzen" → assignedTo: "Beide", category: "both"
   - "Geschenke kaufen" → assignedTo: "Beide", category: "both"

3. Diese Aufgaben sind NUR für eine Person:
   - "Ich muss zum Arzt" → assignedTo: "${userName}"
   - "Für mich: Haare schneiden" → assignedTo: "${userName}"
   - "Jeremy muss zum Zahnarzt" → assignedTo: "Jeremy"
   - "Moana soll Yoga machen" → assignedTo: "Moana"

4. WICHTIG: Bei Aufgaben ohne Personenbezug → IMMER "Beide"!

5. Orte erkennen: "Edeka - Tofu" = Aufgabe "Tofu" mit location "Edeka"

6. "und aufgaben für beide?" ist eine FRAGE, keine neue Aufgabe!

Antworte immer auf Deutsch und sei freundlich.`
        },
        { 
          role: 'user', 
          content: `User (${userName}) sagt: "${text}"\n\nAktuelle Aufgaben: ${activeTasks.length}`
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'show_tasks',
            description: 'Zeige Aufgaben (für alle oder eine bestimmte Person)',
            parameters: {
              type: 'object',
              properties: {
                person: { 
                  type: 'string', 
                  description: 'Person filter: "Jeremy", "Moana", "Beide", oder leer für alle'
                }
              }
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'add_tasks',
            description: 'Füge neue Aufgaben hinzu (Standard: für beide)',
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
                      when: { type: 'string', description: 'Wann (optional)' },
                      category: { 
                        type: 'string', 
                        enum: ['shopping', 'household', 'personal', 'work', 'both', 'general'],
                        description: 'Kategorie (both für gemeinsame)'
                      },
                      assignedTo: { 
                        type: 'string', 
                        description: 'Person: "Jeremy", "Moana", oder "Beide" (Standard ist "Beide")'
                      }
                    },
                    required: ['task']
                  }
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
            description: 'Markiere Aufgabe als erledigt',
            parameters: {
              type: 'object',
              properties: {
                taskName: { type: 'string' }
              },
              required: ['taskName']
            }
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
                taskName: { type: 'string' }
              },
              required: ['taskName']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'update_task',
            description: 'Aktualisiere eine Aufgabe',
            parameters: {
              type: 'object',
              properties: {
                taskName: { type: 'string' },
                updates: {
                  type: 'object',
                  properties: {
                    when: { type: 'string' },
                    location: { type: 'string' },
                    person: { type: 'string' }
                  }
                }
              },
              required: ['taskName', 'updates']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'undo_last_action',
            description: 'Mache die letzte Aktion rückgängig'
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
        
        console.log(`Tool call: ${functionName}`, JSON.stringify(args, null, 2));
        
        switch (functionName) {
          case 'show_tasks':
            return formatTaskList(tasks, args.person);
            
          case 'add_tasks':
            const result = await addTasks(args.tasks, userName);
            if (result.count === 0) {
              return 'Diese Aufgaben existieren bereits';
            }
            
            // Build response based on what was added
            const sharedTasks = result.addedInfo.filter(t => t.isShared);
            const personalTasks = result.addedInfo.filter(t => !t.isShared);
            
            let response = '✅ ';
            if (sharedTasks.length > 0) {
              response += `${sharedTasks.length} gemeinsame Aufgabe${sharedTasks.length > 1 ? 'n' : ''} hinzugefügt`;
              if (personalTasks.length > 0) response += ' und ';
            }
            if (personalTasks.length > 0) {
              const persons = [...new Set(personalTasks.map(t => t.person))];
              response += `${personalTasks.length} Aufgabe${personalTasks.length > 1 ? 'n' : ''} für ${persons.join(', ')} hinzugefügt`;
            }
            response += '!';
            
            // Add details for single task
            if (result.count === 1) {
              const task = result.addedInfo[0];
              response = `✅ ${task.isShared ? 'Gemeinsame Aufgabe' : `Aufgabe für ${task.person}`} hinzugefügt: "${task.task}"`;
            }
            
            return response;
            
          case 'complete_task':
            const completed = await completeTask(args.taskName);
            return completed ? `✅ "${completed}" erledigt!` : `Nicht gefunden: "${args.taskName}"`;
            
          case 'delete_task':
            const deleted = await deleteTask(args.taskName);
            return deleted ? `🗑️ "${deleted}" gelöscht!` : `Nicht gefunden: "${args.taskName}"`;
            
          case 'update_task':
            const updated = await updateTask(args.taskName, args.updates);
            return updated ? `✅ Aufgabe aktualisiert!` : `Nicht gefunden: "${args.taskName}"`;
            
          case 'undo_last_action':
            return await undoLastAction();
            
          default:
            console.error(`Unknown function: ${functionName}`);
        }
      }
    }
    
    return message.content || 'Ich bin mir nicht sicher, was du meinst. Kannst du es anders formulieren?';
    
  } catch (error) {
    console.error('AI Error:', error);
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
    // Check if sheets is available
    if (!sheets) {
      await bot.sendMessage(chatId, '❌ Google Sheets ist nicht konfiguriert. Bitte überprüfe die Umgebungsvariablen.');
      return;
    }
    
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
`Hallo! Ich bin euer Aufgaben-Bot 🤖

Alle Aufgaben sind standardmäßig für BEIDE!

Ich verstehe:
• "Müll rausbringen" → Gemeinsame Aufgabe
• "Edeka - Milch" → Gemeinsame Einkaufsaufgabe
• "Ich muss zum Arzt" → Nur für dich
• "Moana muss X" → Nur für Moana
• "Was muss ich machen?" → Deine Aufgaben (inkl. gemeinsame)
• "Zeige gemeinsame Aufgaben" → Nur gemeinsame
• "Müll ist erledigt" → Aufgabe abhaken
• "Rückgängig" → Letzte Aktion rückgängig

📊 Sheet: ${process.env.GOOGLE_SHEET_URL || 'Nicht konfiguriert'}`);
      return;
    }
    
    // Try AI if available
    if (openai) {
      let cleanText = text;
      if (isGroup) {
        const botUsername = (await bot.getMe()).username;
        cleanText = text.replace(`@${botUsername}`, '').trim();
      }
      
      const aiResponse = await handleAI(cleanText, tasks, userName, isGroup);
      if (aiResponse) {
        await bot.sendMessage(chatId, aiResponse);
        return;
      }
    }
    
    // Fallback patterns if AI fails or is not available
    if (text.match(/aufgabe|liste|zeige|was muss/i)) {
      const personMatch = text.match(/(moana|jeremy|ich|meine|beide|gemeinsam)/i);
      let filterPerson = null;
      
      if (personMatch) {
        const person = personMatch[1].toLowerCase();
        if (person === 'ich' || person === 'meine') {
          filterPerson = userName;
        } else if (person === 'beide' || person === 'gemeinsam') {
          filterPerson = SHARED_PERSON_VALUE;
        } else {
          filterPerson = person.charAt(0).toUpperCase() + person.slice(1);
        }
      }
      
      await bot.sendMessage(chatId, formatTaskList(tasks, filterPerson));
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
    
    if (text.match(/rückgängig|undo|falsch/i)) {
      const result = await undoLastAction();
      await bot.sendMessage(chatId, result);
      return;
    }
    
    // Default message
    await bot.sendMessage(chatId, 
`Ich verstehe "${text}" nicht. 

Denk dran: Alle Aufgaben sind standardmäßig für beide!

Versuch:
• "Müll rausbringen" → Gemeinsame Aufgabe
• "Ich muss zum Arzt" → Nur für dich
• "Zeige Aufgaben" → Alle Aufgaben
• "Milch erledigt" → Aufgabe abhaken`);
    
  } catch (error) {
    console.error('Error:', error);
    await bot.sendMessage(chatId, `❌ Fehler: ${error.message}`);
  }
});

// Error handler for bot
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  
  // Set webhook after server is listening
  setTimeout(async () => {
    try {
      const webhookUrl = process.env.WEBHOOK_URL || `https://${process.env.RAILWAY_STATIC_URL || 'localhost'}/webhook`;
      
      console.log('Setting webhook to:', webhookUrl);
      await bot.deleteWebHook();
      const result = await bot.setWebHook(webhookUrl);
      console.log('✅ Webhook set:', result);
      
      const info = await bot.getWebHookInfo();
      console.log('Webhook info:', info);
      
    } catch (error) {
      console.error('❌ Webhook error:', error.message);
      console.log('Falling back to polling mode...');
      bot.startPolling();
    }
  }, 2000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received - shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received - shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

// Heartbeat
setInterval(() => {
  console.log(`💓 Bot alive - Tasks: ${sheets ? 'Connected' : 'Not connected'}, AI: ${openai ? 'Connected' : 'Not connected'}`);
}, 30000);

console.log('Starting bot...');
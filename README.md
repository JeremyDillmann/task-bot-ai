# Task Bot Clean

A Telegram bot for managing household tasks with Google Sheets.

## Features
- Natural language understanding (German/English)
- Google Sheets integration
- Automatic duplicate removal
- Task updates and completion
- GPT-4 powered conversations

## Setup

1. Clone the repo
2. Copy `.env.example` to `.env` and fill in your keys
3. Add `credentials.json` from Google Cloud Console
4. Run `npm install`
5. Run `npm start`

## Commands
- Just write naturally: "Was muss ich machen?"
- "Müll ist erledigt"
- "Ändere X zu Y"
- "Ich muss morgen einkaufen"

## Deployment
Deployed on Railway with environment variables.

## Environment Variables
- `TELEGRAM_BOT_TOKEN` - From @BotFather
- `OPENAI_API_KEY` - From OpenAI
- `GOOGLE_SHEET_ID` - Your Google Sheet ID
- `GOOGLE_SHEET_URL` - Full Sheet URL
- `GOOGLE_CREDENTIALS` - Service account JSON (for Railway)

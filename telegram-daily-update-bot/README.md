# Telegram Daily Update Bot

Sends a Morning Plan daily at 8:00 AM and an EOD Update at 5:00 PM (Asia/Kolkata). Includes a local dashboard to edit the three changing tasks and EOD progress.

## Setup
1. In Telegram, open **@BotFather**, send `/newbot`, follow the prompts, and copy the bot token.
2. Add the bot to your target group and make sure it can post messages.
3. In the group, send `/chatid`; the bot replies with that group’s chat ID. If it cannot see the command, send `/start` to the bot privately and retry, or adjust group privacy via @BotFather and re-add the bot.
4. Copy `.env.example` to `.env` and fill `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Keep the token private.
5. In PowerShell, from this folder run:

```powershell
Copy-Item .env.example .env
# Edit .env with Notepad, then:
npm install
npm start
```

6. Open http://localhost:3000, fill today’s tasks, click **Save today’s tasks**, and test the Morning/EOD buttons.

Keep the terminal running and your computer awake for the scheduled messages. If the computer sleeps or shuts down, the bot cannot send at those times; deploy to an always-on server for 24/7 scheduling. The dashboard has no login, so do not expose port 3000 publicly. If the bot token leaks, revoke it through @BotFather.

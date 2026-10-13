# Telegram Daily Update Bot

Sends a Morning Plan daily at 8:00 AM and an EOD Update at 5:00 PM (Asia/Kolkata). Includes a local dashboard to edit the changing tasks (including 8:00–9:00 AM) and EOD progress.

## Setup
1. In Telegram, open **@BotFather**, create your bot or get your bot token.
2. Add the bot to your target Telegram group:
   - Make sure the bot has permissions to send messages in the group.
   - When added, the bot will post a message in the group with the group's Chat ID (and log it in the console).
   - Alternatively, type `/chatid` or `/chatid@YourBotUsername` inside the group.
   - **Important:** Group IDs are **negative numbers** (e.g., `-100xxxxxxxxxx` or `-xxxxxxxx`). If your ID is a positive number (e.g. `1794177859`), that is your **private direct message ID**, not your group ID!
3. Copy `.env.example` to `.env` and configure:
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   TELEGRAM_CHAT_ID=-100xxxxxxxxxx
   PORT=3000
   TZ=Asia/Kolkata
   ```
4. Start the server:
   ```powershell
   npm install
   npm start
   ```
5. Open http://localhost:3000, verify the status displays your group name, and click **Send EOD Update** to test.

## Troubleshooting Group Messages
- **Bot sends to DM instead of Group:** Your `TELEGRAM_CHAT_ID` is a positive integer. Replace it with your group's negative Chat ID (e.g. `-100...`).
- **Bot does not reply to `/chatid` in Group:** Type `/chatid@YourBotUsername`. If BotFather privacy mode is on, bots ignore plain text messages, but always respond to commands targeting their username.
- **`Forbidden: bot is not a member of the group chat`:** Ensure the bot has been added to the group.
- **`Forbidden: not enough rights to send text messages`:** In group settings, ensure permissions allow members/bots to send messages, or promote the bot to Administrator.


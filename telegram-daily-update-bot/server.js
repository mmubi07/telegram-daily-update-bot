require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// ---------------------------------------------------------------------------
// Storage — writable in /tmp on Vercel, local file otherwise
// ---------------------------------------------------------------------------
const IS_VERCEL = !!process.env.VERCEL;
const DATA_FILE = IS_VERCEL
  ? '/tmp/data.json'
  : path.join(__dirname, 'data.json');
const SEED_FILE = path.join(__dirname, 'data.json'); // read-only seed on Vercel

const token = process.env.TELEGRAM_BOT_TOKEN;
const configuredChatId = (
  process.env.TELEGRAM_GROUP_CHAT_ID ||
  process.env.TELEGRAM_CHAT_ID ||
  ''
).trim();

// WEBHOOK_URL must be set in Vercel env vars, e.g. https://your-project.vercel.app
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const defaults = {
  tasks: {
    task0: 'CAMERA Setup',
    task1: 'Work on assigned tasks',
    task2: 'Continue project development',
    task3: 'Prepare content and complete pending work',
  },
  completed: "Completed today's planned tasks and reviewed progress.",
  tomorrow: 'Continue pending tasks and follow the next-day plan.',
};

function loadData() {
  for (const f of [DATA_FILE, SEED_FILE]) {
    try {
      if (fs.existsSync(f)) {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
        return {
          ...defaults,
          ...parsed,
          tasks: { ...defaults.tasks, ...(parsed.tasks || {}) },
        };
      }
    } catch (_) {}
  }
  return defaults;
}

let data = loadData();

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Storage Error]:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Bot state
// ---------------------------------------------------------------------------
let bot = null;
let botReady = false;
let botInfo = null;
let chatInfo = null;
let canSendMessages = null;
let lastError = '';
let lastSent = 'Not sent yet';

const tz = process.env.TZ || 'Asia/Kolkata';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatTelegramError(e) {
  const desc = e.response?.body?.description || e.message || 'Unknown Telegram error';
  const code = e.response?.body?.error_code || e.code || '';
  if (/chat not found/i.test(desc))
    return `Chat not found (${code || 400}): Telegram could not find chat '${configuredChatId}'. Ensure the bot is added to the group and the group ID is correct.`;
  if (/bot was blocked/i.test(desc))
    return `Bot was blocked (${code || 403}): The user blocked the bot.`;
  if (/bot is not a member/i.test(desc) || /bot was kicked/i.test(desc))
    return `Bot is not a member of the group (${code || 403}): Please add @${botInfo?.username || 'the bot'} to the Telegram group.`;
  if (/not enough rights/i.test(desc) || /have no rights to send/i.test(desc) || /forbidden/i.test(desc))
    return `Permission denied / Forbidden (${code || 403}): ${desc}. Ensure the bot has permission to send messages in the group.`;
  if (/chat_id is empty|invalid chat_id/i.test(desc))
    return `Invalid Chat ID (${code || 400}): '${configuredChatId}' is not a valid Telegram chat ID. Group IDs are negative numbers (e.g. -100xxxxxxxxxx).`;
  return `Telegram API error (${code}): ${desc}`;
}

function isTransientNetworkError(err) {
  const msg = `${err?.message || ''} ${err?.code || ''} ${err?.toString() || ''}`;
  return /ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ENETUNREACH/i.test(msg);
}

async function verifyTargetChat() {
  if (!bot || !configuredChatId || configuredChatId.includes('PASTE_')) return;
  const isGroup = configuredChatId.startsWith('-');
  if (!isGroup) {
    console.warn(`\n[CONFIG WARNING] TELEGRAM_CHAT_ID is POSITIVE (${configuredChatId}). Group IDs are negative.\n`);
  }
  try {
    const chat = await bot.getChat(configuredChatId);
    chatInfo = chat;
    const isChatGroup = ['group', 'supergroup'].includes(chat.type);
    if (isChatGroup) {
      console.log(`[Telegram] Target group verified: "${chat.title}" (ID: ${chat.id}, Type: ${chat.type})`);
      try {
        const member = await bot.getChatMember(chat.id, botInfo.id);
        const hasRights =
          member.status === 'creator' ||
          member.status === 'administrator' ||
          (member.status === 'member' && member.can_send_messages !== false);
        canSendMessages = hasRights;
        if (hasRights) {
          lastError = '';
          console.log(`[Telegram] Bot permissions verified in "${chat.title}" (Status: ${member.status})`);
        } else {
          lastError = `Bot lacks send permission in "${chat.title}". Please grant message permissions.`;
          console.warn(`[Telegram] ${lastError}`);
        }
      } catch (permErr) {
        console.warn(`[Telegram] Could not check bot member permissions: ${permErr.message}`);
      }
    } else if (chat.type === 'private') {
      console.log(`[Telegram] Target chat is PRIVATE chat with @${chat.username || chat.first_name || chat.id}`);
      canSendMessages = true;
    }
  } catch (e) {
    lastError = formatTelegramError(e);
    console.error(`[Telegram] Target chat check failed:`, lastError);
  }
}

function handleBotMessage(msg) {
  const text = msg.text?.trim() || '';
  const isChatIdCmd = /^\/(chatid|id|groupid)(@\w+)?(\s|$)/i.test(text);
  if (isChatIdCmd) {
    const isGroup = ['group', 'supergroup'].includes(msg.chat.type);
    if (isGroup) {
      const reply = `<b>Group Chat ID:</b>\n<code>${msg.chat.id}</code>\n\nGroup: <b>${msg.chat.title || 'Group'}</b> (${msg.chat.type})\n\nSet <code>TELEGRAM_CHAT_ID=${msg.chat.id}</code> in your Vercel env vars and redeploy.`;
      bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' }).catch(console.error);
    } else {
      const reply = `<b>Your Private Chat ID:</b>\n<code>${msg.chat.id}</code>\n\nGroup IDs are <b>negative numbers</b> (e.g. <code>-100xxxxxxxxxx</code>). Add @${botInfo?.username || 'this bot'} to a group and send <code>/chatid</code> there.`;
      bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' }).catch(console.error);
    }
    return;
  }
  if (msg.new_chat_members && botInfo) {
    const addedBot = msg.new_chat_members.some((m) => m.id === botInfo.id || m.username === botInfo.username);
    if (addedBot) {
      console.log(`[Telegram] Bot added to group "${msg.chat.title}" (ID: ${msg.chat.id})`);
      const welcome = `Hello! I've been added to <b>${msg.chat.title}</b>.\n\n<b>Group Chat ID:</b>\n<code>${msg.chat.id}</code>\n\nSet <code>TELEGRAM_CHAT_ID=${msg.chat.id}</code> in your Vercel env vars and redeploy.`;
      bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' }).catch(console.error);
    }
  }
}

// ---------------------------------------------------------------------------
// Bot initialisation — webhook on Vercel, polling locally
// ---------------------------------------------------------------------------
if (token && !token.includes('PASTE_')) {
  if (IS_VERCEL) {
    // Vercel: always use no-polling mode to avoid serverless crashes
    // Bot is used only for sending messages (via API calls), not receiving
    bot = new TelegramBot(token, { polling: false });

    if (WEBHOOK_URL) {
      // Register webhook so Telegram pushes updates to our endpoint
      const webhookEndpoint = `${WEBHOOK_URL}/webhook/${token}`;
      bot.setWebHook(webhookEndpoint)
        .then(() => console.log(`[Telegram] Webhook set to ${webhookEndpoint}`))
        .catch((e) => console.error('[Telegram] Failed to set webhook:', e.message));

      app.post(`/webhook/${token}`, (req, res) => {
        try { bot.processUpdate(req.body); } catch (_) {}
        res.sendStatus(200);
      });

      bot.on('message', handleBotMessage);
    } else {
      console.warn('[Telegram] WEBHOOK_URL not set — bot will only send messages, not receive commands.');
    }

    bot.getMe()
      .then(async (me) => {
        botInfo = me;
        botReady = true;
        lastError = '';
        console.log(`[Telegram] Connected as @${me.username} (Vercel/no-polling mode)`);
        await verifyTargetChat();
      })
      .catch((e) => {
        lastError = formatTelegramError(e);
        console.error('[Telegram] Failed to connect:', lastError);
      });

  } else {
    // Local dev: polling mode
    bot = new TelegramBot(token, {
      polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
    });

    bot.on('polling_error', (e) => {
      if (e.message?.includes('409 Conflict')) {
        lastError = 'Telegram conflict (409): Another bot instance is running with this token.';
        console.warn('[Telegram Polling Warning]:', lastError);
        return;
      }
      if (isTransientNetworkError(e)) {
        console.warn(`[Telegram Polling Warning]: Transient network dropout (${e.code || e.message}), retrying...`);
        return;
      }
      lastError = formatTelegramError(e);
      console.error('[Telegram Polling Error]:', lastError);
    });

    bot.on('message', handleBotMessage);

    bot.getMe()
      .then(async (me) => {
        botInfo = me;
        botReady = true;
        lastError = '';
        console.log(`[Telegram] Connected as @${me.username} (polling mode)`);
        await verifyTargetChat();
      })
      .catch((e) => {
        lastError = formatTelegramError(e);
        console.error('[Telegram] Failed to connect:', lastError);
      });
  }
} else {
  lastError = 'Add TELEGRAM_BOT_TOKEN to .env (or Vercel env vars) and restart.';
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------
function dateLabel() {
  return new Date().toLocaleDateString('en-IN', {
    timeZone: tz, day: '2-digit', month: 'short', year: 'numeric',
  });
}

function morning() {
  const t = data.tasks;
  return `\u{1F305} GOOD MORNING \u2014 DAILY PLAN\n\u{1F4C5} ${dateLabel()}\n\n\u{1F557} 8:00\u20139:00 AM \u2014 ${t.task0 || 'CAMERA Setup'}\n\u{1F558} 9:00\u20139:30 AM \u2014 SecondShift AI Solutions Meeting\n\u{1F564} 9:30\u201310:00 AM \u2014 ${t.task1}\n\u{1F559} 10:00\u201310:30 AM \u2014 KTS Team Meeting\n\u{1F565} 10:30 AM\u20131:00 PM \u2014 ${t.task2}\n\u{1F371} 1:00\u20132:00 PM \u2014 Lunch Break\n\u{1F551} 2:00\u20134:00 PM \u2014 ${t.task3}\n\u{1F553} 4:00\u20135:00 PM \u2014 Daily Updates & Tomorrow's Planning\n\nLet's have a productive day! \u{1F4AA}`;
}

function eod() {
  return `\u{1F319} END-OF-DAY UPDATE\n\u{1F4C5} ${dateLabel()}\n\n\u2705 TODAY'S WORK\n\u2022 8:00\u20139:00 AM \u2014 ${data.tasks.task0 || 'CAMERA Setup'}\n\u2022 9:00\u20139:30 AM \u2014 SecondShift AI Solutions Meeting\n\u2022 9:30\u201310:00 AM \u2014 ${data.tasks.task1}\n\u2022 10:00\u201310:30 AM \u2014 KTS Team Meeting\n\u2022 10:30 AM\u20131:00 PM \u2014 ${data.tasks.task2}\n\u2022 1:00\u20132:00 PM \u2014 Lunch Break\n\u2022 2:00\u20134:00 PM \u2014 ${data.tasks.task3}\n\u2022 4:00\u20135:00 PM \u2014 Daily Updates & Tomorrow's Planning\n\n\u{1F4CC} COMPLETED / PROGRESS\n${data.completed || 'Progress updated.'}\n\n\u27A1\uFE0F TOMORROW'S PLAN\n${data.tomorrow || 'Continue pending tasks.'}\n\nHave a great evening!`;
}

async function send(kind) {
  if (!bot) throw Error('Bot token is not configured.');
  if (!configuredChatId || configuredChatId.includes('PASTE_'))
    throw Error('Group Chat ID is missing. Add TELEGRAM_CHAT_ID.');
  if (IS_VERCEL) data = loadData(); // re-read on stateless functions
  const label = kind === 'morning' ? 'Morning Plan' : 'EOD Update';
  console.log(`[Telegram] Sending ${label} to ${configuredChatId}...`);
  try {
    await bot.sendMessage(configuredChatId, kind === 'morning' ? morning() : eod(), {
      disable_web_page_preview: true,
    });
    lastSent = `${label} sent at ${new Date().toLocaleString('en-IN', { timeZone: tz })}`;
    lastError = '';
    console.log(`[Telegram] ${label} delivered to ${configuredChatId}`);
    return { ok: true, message: lastSent };
  } catch (e) {
    lastError = formatTelegramError(e);
    console.error(`[Telegram] Failed to send ${label}:`, lastError);
    throw Error(lastError);
  }
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.get('/api/status', (_q, r) => {
  const isGroup = chatInfo
    ? ['group', 'supergroup'].includes(chatInfo.type)
    : configuredChatId.startsWith('-');
  r.json({
    botConfigured: !!bot,
    botReady,
    botUsername: botInfo?.username || null,
    chatConfigured: !!configuredChatId && !configuredChatId.includes('PASTE_'),
    chatId: configuredChatId,
    chatType: chatInfo?.type || (configuredChatId.startsWith('-') ? 'group' : configuredChatId ? 'private' : 'unknown'),
    chatTitle: chatInfo?.title || chatInfo?.first_name || null,
    isGroup,
    canSendMessages,
    timezone: tz,
    mode: IS_VERCEL ? 'webhook' : 'polling',
    lastSent,
    lastError,
  });
});

app.get('/api/tasks', (_q, r) => {
  if (IS_VERCEL) data = loadData();
  r.json(data);
});

app.post('/api/tasks', (q, r) => {
  if (IS_VERCEL) data = loadData();
  data = {
    ...data,
    ...q.body,
    tasks: { ...data.tasks, ...(q.body.tasks || {}) },
  };
  save();
  r.json({ ok: true, data });
});

app.post('/api/send/:kind', async (q, r) => {
  if (!['morning', 'eod'].includes(q.params.kind))
    return r.status(400).json({ error: 'Unknown update type' });
  try {
    r.json(await send(q.params.kind));
  } catch (e) {
    r.status(400).json({ error: e.message });
  }
});

// Vercel Cron Job endpoints — called by vercel.json schedule
app.get('/api/cron/:kind', async (q, r) => {
  const { kind } = q.params;
  if (!['morning', 'eod'].includes(kind))
    return r.status(400).json({ error: 'Unknown update type' });
  const cronSecret = process.env.CRON_SECRET || '';
  const authHeader = q.headers['authorization'] || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`)
    return r.status(401).json({ error: 'Unauthorized' });
  try {
    r.json(await send(kind));
  } catch (e) {
    r.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Local cron jobs (only when NOT on Vercel)
// ---------------------------------------------------------------------------
if (!IS_VERCEL) {
  cron.schedule('0 8 * * *', () =>
    send('morning').catch((e) => { lastError = e.message; console.error(e.message); }),
    { timezone: tz }
  );
  cron.schedule('0 17 * * *', () =>
    send('eod').catch((e) => { lastError = e.message; console.error(e.message); }),
    { timezone: tz }
  );
}

app.listen(PORT, () =>
  console.log(`Dashboard running at http://localhost:${PORT} [${IS_VERCEL ? 'Vercel webhook' : 'local polling'} mode]`)
);

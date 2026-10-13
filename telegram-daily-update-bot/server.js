require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, 'data.json');
const token = process.env.TELEGRAM_BOT_TOKEN;
// Support TELEGRAM_GROUP_CHAT_ID or TELEGRAM_CHAT_ID
const configuredChatId = (process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').trim();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const defaults = {
  tasks: {
    task0: 'CAMERA Setup',
    task1: 'Work on assigned tasks',
    task2: 'Continue project development',
    task3: 'Prepare content and complete pending work',
  },
  completed: 'Completed today’s planned tasks and reviewed progress.',
  tomorrow: 'Continue pending tasks and follow the next-day plan.',
};

let data = defaults;
try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    data = {
      ...defaults,
      ...parsed,
      tasks: {
        ...defaults.tasks,
        ...(parsed.tasks || {}),
      },
    };
  }
} catch (e) {
  console.error('[Storage Error]:', e.message);
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let bot = null;
let botReady = false;
let botInfo = null;
let chatInfo = null;
let canSendMessages = null;
let lastError = '';
let lastSent = 'Not sent yet';

const tz = process.env.TZ || 'Asia/Kolkata';

function formatTelegramError(e) {
  const desc = e.response?.body?.description || e.message || 'Unknown Telegram error';
  const code = e.response?.body?.error_code || e.code || '';

  if (/chat not found/i.test(desc)) {
    return `Chat not found (${code || 400}): Telegram could not find chat '${configuredChatId}'. Ensure the bot is added to the group and the group ID is correct.`;
  }
  if (/bot was blocked/i.test(desc)) {
    return `Bot was blocked (${code || 403}): The user blocked the bot.`;
  }
  if (/bot is not a member/i.test(desc) || /bot was kicked/i.test(desc)) {
    return `Bot is not a member of the group (${code || 403}): Please add @${botInfo?.username || 'the bot'} to the Telegram group.`;
  }
  if (/not enough rights/i.test(desc) || /have no rights to send/i.test(desc) || /forbidden/i.test(desc)) {
    return `Permission denied / Forbidden (${code || 403}): ${desc}. Ensure the bot has permission to send messages in the group.`;
  }
  if (/chat_id is empty|invalid chat_id/i.test(desc)) {
    return `Invalid Chat ID (${code || 400}): '${configuredChatId}' is not a valid Telegram chat ID. Telegram group IDs are negative numbers (e.g. -100xxxxxxxxxx).`;
  }
  return `Telegram API error (${code}): ${desc}`;
}

async function verifyTargetChat() {
  if (!bot || !configuredChatId || configuredChatId.includes('PASTE_')) {
    return;
  }

  const isGroup = configuredChatId.startsWith('-');
  if (!isGroup) {
    console.warn(`\n⚠️  [CONFIG WARNING] TELEGRAM_CHAT_ID is set to a POSITIVE ID (${configuredChatId}).`);
    console.warn(`   In Telegram, positive numbers are PRIVATE user chats.`);
    console.warn(`   Telegram group chats have NEGATIVE IDs (e.g. -100xxxxxxxxxx).`);
    console.warn(`   Updates are currently going to a private chat instead of your group!`);
    console.warn(`   To fix: Add @${botInfo?.username || 'the bot'} to your group, send /chatid inside the group, and update .env.\n`);
  }

  try {
    const chat = await bot.getChat(configuredChatId);
    chatInfo = chat;
    const isChatGroup = ['group', 'supergroup'].includes(chat.type);

    if (isChatGroup) {
      console.log(`[Telegram] ✅ Target group verified: "${chat.title}" (ID: ${chat.id}, Type: ${chat.type})`);
      try {
        const member = await bot.getChatMember(chat.id, botInfo.id);
        const hasRights =
          member.status === 'creator' ||
          member.status === 'administrator' ||
          (member.status === 'member' && member.can_send_messages !== false);

        canSendMessages = hasRights;
        if (hasRights) {
          console.log(`[Telegram] ✅ Bot permissions verified in "${chat.title}" (Status: ${member.status})`);
        } else {
          const warning = `Bot status in "${chat.title}" is '${member.status}', but it lacks permission to send messages. Please grant message permissions.`;
          lastError = warning;
          console.warn(`[Telegram] ⚠️ ${warning}`);
        }
      } catch (permErr) {
        console.warn(`[Telegram] Note: Could not check bot member permissions: ${permErr.message}`);
      }
    } else if (chat.type === 'private') {
      console.log(`[Telegram] ℹ️ Target chat is PRIVATE chat with @${chat.username || chat.first_name || chat.id}`);
      canSendMessages = true;
    } else {
      console.log(`[Telegram] Target chat: ${chat.type} (${chat.title || chat.id})`);
    }
  } catch (e) {
    const err = formatTelegramError(e);
    lastError = err;
    console.error(`[Telegram] ❌ Target chat check failed:`, err);
  }
}

if (token && !token.includes('PASTE_')) {
  bot = new TelegramBot(token, { polling: true });

  bot.on('polling_error', (e) => {
    const err = formatTelegramError(e);
    if (!e.message?.includes('409 Conflict')) {
      lastError = err;
      console.error('[Telegram Polling Error]:', err);
    }
  });

  bot.on('message', async (msg) => {
    const text = msg.text?.trim() || '';
    const isChatIdCmd = /^\/(chatid|id|groupid)(@\w+)?(\s|$)/i.test(text);

    if (isChatIdCmd) {
      const isGroup = ['group', 'supergroup'].includes(msg.chat.type);
      if (isGroup) {
        console.log(`[Telegram] 📢 /chatid received in group "${msg.chat.title}" (ID: ${msg.chat.id})`);
        const reply = `📌 <b>Group Chat ID:</b>\n<code>${msg.chat.id}</code>\n\nGroup Title: <b>${msg.chat.title || 'Group'}</b>\nType: <i>${msg.chat.type}</i>\n\n✅ <b>To send daily updates here:</b>\n1. Copy this ID: <code>${msg.chat.id}</code>\n2. In your <code>.env</code> file, set:\n<code>TELEGRAM_CHAT_ID=${msg.chat.id}</code>\n3. Restart the bot server.`;
        bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' }).catch(console.error);
      } else {
        console.log(`[Telegram] 👤 /chatid received in private chat from @${msg.from?.username || msg.from?.id} (ID: ${msg.chat.id})`);
        const reply = `👤 <b>Your Private Chat ID:</b>\n<code>${msg.chat.id}</code>\n\n⚠️ <b>Notice:</b> This is a PRIVATE user chat ID (positive number).\nTelegram group IDs are <b>negative numbers</b> (e.g. <code>-100xxxxxxxxxx</code>).\n\n<b>To send updates to a Telegram group:</b>\n1. Add @${botInfo?.username || 'this bot'} to your group.\n2. In that group, send <code>/chatid</code>.\n3. The bot will reply with the group's negative Chat ID.\n4. Put that negative ID in your <code>.env</code> file under <code>TELEGRAM_CHAT_ID</code>!`;
        bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' }).catch(console.error);
      }
      return;
    }

    if (msg.new_chat_members && botInfo) {
      const addedBot = msg.new_chat_members.some((m) => m.id === botInfo.id || m.username === botInfo.username);
      if (addedBot) {
        console.log(`\n🎉 [Telegram] Bot added to group "${msg.chat.title}"!`);
        console.log(`   Group Title: ${msg.chat.title}`);
        console.log(`   GROUP CHAT ID: ${msg.chat.id}`);
        console.log(`   👉 Set in .env: TELEGRAM_CHAT_ID=${msg.chat.id}\n`);

        const welcome = `👋 Hello! I've been added to <b>${msg.chat.title}</b>.\n\n📌 <b>This group's Chat ID is:</b>\n<code>${msg.chat.id}</code>\n\nTo send EOD and Morning updates to this group:\nSet <code>TELEGRAM_CHAT_ID=${msg.chat.id}</code> in your <code>.env</code> file and restart the bot.`;
        bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' }).catch(console.error);
      }
    }
  });

  bot
    .getMe()
    .then(async (me) => {
      botInfo = me;
      botReady = true;
      console.log(`[Telegram] Connected to @${me.username} (ID: ${me.id})`);
      await verifyTargetChat();
    })
    .catch((e) => {
      const err = formatTelegramError(e);
      lastError = err;
      console.error('[Telegram] Failed to connect:', err);
    });
} else {
  lastError = 'Add TELEGRAM_BOT_TOKEN to .env and restart the server.';
}

function dateLabel() {
  return new Date().toLocaleDateString('en-IN', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function morning() {
  const t = data.tasks;
  return `🌅 GOOD MORNING — DAILY PLAN\n📅 ${dateLabel()}\n\n🕗 8:00–9:00 AM — ${t.task0 || 'CAMERA Setup'}\n🕘 9:00–9:30 AM — SecondShift AI Solutions Meeting\n🕤 9:30–10:00 AM — ${t.task1}\n🕙 10:00–10:30 AM — KTS Team Meeting\n🕥 10:30 AM–1:00 PM — ${t.task2}\n🍱 1:00–2:00 PM — Lunch Break\n🕑 2:00–4:00 PM — ${t.task3}\n🕓 4:00–5:00 PM — Daily Updates & Tomorrow’s Planning\n\nLet’s have a productive day! 💪`;
}

function eod() {
  return `🌙 END-OF-DAY UPDATE\n📅 ${dateLabel()}\n\n✅ TODAY’S WORK\n• 8:00–9:00 AM — ${data.tasks.task0 || 'CAMERA Setup'}\n• 9:00–9:30 AM — SecondShift AI Solutions Meeting\n• 9:30–10:00 AM — ${data.tasks.task1}\n• 10:00–10:30 AM — KTS Team Meeting\n• 10:30 AM–1:00 PM — ${data.tasks.task2}\n• 1:00–2:00 PM — Lunch Break\n• 2:00–4:00 PM — ${data.tasks.task3}\n• 4:00–5:00 PM — Daily Updates & Tomorrow’s Planning\n\n📌 COMPLETED / PROGRESS\n${data.completed || 'Progress updated.'}\n\n➡️ TOMORROW’S PLAN\n${data.tomorrow || 'Continue pending tasks.'}\n\nHave a great evening!`;
}

async function send(kind) {
  if (!bot) {
    throw Error('Bot token is not configured. Add TELEGRAM_BOT_TOKEN in .env and restart.');
  }
  if (!configuredChatId || configuredChatId.includes('PASTE_')) {
    throw Error('Group Chat ID is missing. Add TELEGRAM_CHAT_ID in .env and restart.');
  }

  const isGroup = configuredChatId.startsWith('-');
  const label = kind === 'morning' ? 'Morning Plan' : 'EOD Update';
  console.log(`[Telegram] Sending ${label} to ${isGroup ? 'Group' : 'Private Chat'} (${configuredChatId})...`);

  try {
    await bot.sendMessage(configuredChatId, kind === 'morning' ? morning() : eod(), {
      disable_web_page_preview: true,
    });

    lastSent = `${label} sent at ${new Date().toLocaleString('en-IN', { timeZone: tz })}`;
    lastError = '';
    console.log(`[Telegram] ✅ ${label} successfully delivered to ${configuredChatId}`);
    return { ok: true, message: lastSent };
  } catch (e) {
    const formatted = formatTelegramError(e);
    lastError = formatted;
    console.error(`[Telegram] ❌ Failed to send ${label}:`, formatted);
    throw Error(formatted);
  }
}

app.get('/api/status', (_q, r) => {
  const isGroup = chatInfo ? ['group', 'supergroup'].includes(chatInfo.type) : configuredChatId.startsWith('-');
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
    lastSent,
    lastError,
  });
});

app.get('/api/tasks', (_q, r) => r.json(data));

app.post('/api/tasks', (q, r) => {
  data = {
    ...data,
    ...q.body,
    tasks: {
      ...data.tasks,
      ...(q.body.tasks || {}),
    },
  };
  save();
  r.json({ ok: true, data });
});

app.post('/api/send/:kind', async (q, r) => {
  if (!['morning', 'eod'].includes(q.params.kind)) {
    return r.status(400).json({ error: 'Unknown update type' });
  }
  try {
    r.json(await send(q.params.kind));
  } catch (e) {
    r.status(400).json({ error: e.message });
  }
});

cron.schedule(
  '0 8 * * *',
  () =>
    send('morning').catch((e) => {
      lastError = e.message;
      console.error(e.message);
    }),
  { timezone: tz }
);

cron.schedule(
  '0 17 * * *',
  () =>
    send('eod').catch((e) => {
      lastError = e.message;
      console.error(e.message);
    }),
  { timezone: tz }
);

app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));


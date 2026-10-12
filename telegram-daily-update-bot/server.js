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
const chatId = process.env.TELEGRAM_CHAT_ID;

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
  console.error(e.message);
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let bot = null;
let botReady = false;
let lastError = '';
let lastSent = 'Not sent yet';

if (token && !token.includes('PASTE_')) {
  bot = new TelegramBot(token, { polling: true });

  bot.on('polling_error', (e) => {
    lastError = e.message;
    console.error('Telegram polling error:', e.message);
  });

  bot.on('message', (msg) => {
    if (msg.text?.trim() === '/chatid') {
      bot
        .sendMessage(msg.chat.id, `This chat ID is: ${msg.chat.id}`)
        .catch(console.error);
    }
  });

  bot
    .getMe()
    .then((me) => {
      botReady = true;
      console.log(`Connected to @${me.username}`);
    })
    .catch((e) => {
      lastError = e.message;
      console.error(e.message);
    });
} else {
  lastError = 'Add TELEGRAM_BOT_TOKEN to .env and restart the server.';
}

const tz = process.env.TZ || 'Asia/Kolkata';

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
  if (!chatId || chatId.includes('PASTE_')) {
    throw Error('Group ID missing. Add TELEGRAM_CHAT_ID in .env and restart.');
  }

  await bot.sendMessage(chatId, kind === 'morning' ? morning() : eod(), {
    disable_web_page_preview: true,
  });

  lastSent = `${kind === 'morning' ? 'Morning Update' : 'EOD Update'} sent at ${new Date().toLocaleString('en-IN', { timeZone: tz })}`;
  lastError = '';
  return { ok: true, message: lastSent };
}

app.get('/api/status', (_q, r) =>
  r.json({
    botConfigured: !!bot,
    botReady,
    chatConfigured: !!chatId && !chatId.includes('PASTE_'),
    timezone: tz,
    lastSent,
    lastError,
  })
);

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
    lastError = e.message;
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

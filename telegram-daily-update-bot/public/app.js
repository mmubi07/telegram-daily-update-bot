const $ = (id) => document.getElementById(id);

async function api(url, options = {}) {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
}

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    $('statusText').textContent = `${
      s.botReady
        ? 'Connected to Telegram'
        : s.botConfigured
        ? 'Connecting to Telegram…'
        : 'Bot token not configured'
    } · ${
      s.chatConfigured ? 'Group ID configured' : 'Group ID missing'
    } · Timezone: ${s.timezone}`;
    $('errorText').textContent = s.lastError || '';
  } catch (e) {
    $('statusText').textContent = e.message;
  }
}

async function loadTasks() {
  const d = await api('/api/tasks');
  $('task0').value = d.tasks?.task0 || '';
  $('task1').value = d.tasks?.task1 || '';
  $('task2').value = d.tasks?.task2 || '';
  $('task3').value = d.tasks?.task3 || '';
  $('completed').value = d.completed || '';
  $('tomorrow').value = d.tomorrow || '';
}

$('saveBtn').onclick = async () => {
  $('saveBtn').disabled = true;
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        tasks: {
          task0: $('task0').value.trim(),
          task1: $('task1').value.trim(),
          task2: $('task2').value.trim(),
          task3: $('task3').value.trim(),
        },
        completed: $('completed').value.trim(),
        tomorrow: $('tomorrow').value.trim(),
      }),
    });
    $('saveStatus').textContent = 'Saved successfully ✓';
  } catch (e) {
    $('saveStatus').textContent = e.message;
  } finally {
    $('saveBtn').disabled = false;
  }
};

async function send(kind, id) {
  $(id).disabled = true;
  $('sendStatus').textContent = 'Sending…';
  try {
    await api(`/api/send/${kind}`, {
      method: 'POST',
      body: '{}',
    });
    $('sendStatus').textContent = 'Message sent successfully ✓';
    await refreshStatus();
  } catch (e) {
    $('sendStatus').textContent = e.message;
  } finally {
    $(id).disabled = false;
  }
}

$('morningBtn').onclick = () => send('morning', 'morningBtn');
$('eodBtn').onclick = () => send('eod', 'eodBtn');
$('refreshBtn').onclick = refreshStatus;

Promise.all([loadTasks(), refreshStatus()]).catch((e) => {
  $('statusText').textContent = e.message;
});

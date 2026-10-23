const origin = process.env.PUBLIC_ORIGIN;
const secret = process.env.CRON_SECRET;
if (!origin?.startsWith('https://') || !secret || secret.length < 32) throw new Error('Задайте HTTPS PUBLIC_ORIGIN и CRON_SECRET в окружении задачи');
const response = await fetch(new URL('/internal/reminders/run', origin), { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
if (!response.ok) throw new Error(`Планировщик: HTTP ${response.status}`);
const result = await response.json();
console.log(JSON.stringify({ ok: result.ok, changedProfiles: result.changedProfiles, transport: 'local-simulator' }));

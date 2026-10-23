const origin = process.env.PUBLIC_ORIGIN;
const secret = process.env.CRON_SECRET;
if (!origin?.startsWith('https://') || !secret || secret.length < 32) throw new Error('Задайте HTTPS PUBLIC_ORIGIN и CRON_SECRET в окружении задачи');
let result;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const response = await fetch(new URL('/internal/reminders/run', origin), { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error('Планировщик: сервер не подтвердил обработку');
    result = await response.json();
    if (result.ok) break;
  } catch { if (attempt === 2) throw new Error('Планировщик: обработка не подтверждена после повторных обращений'); }
  await new Promise(resolve => setTimeout(resolve, 10000));
}
if (!result?.ok) throw new Error('Планировщик: обработка не подтверждена');
console.log(JSON.stringify({ ok: true, changedProfiles: result.changedProfiles }));

const origin = process.argv[2] || process.env.PUBLIC_ORIGIN || 'http://localhost:4173';
for (const path of ['/healthz', '/', '/patient/', '/psychiatrist/', '/bot/']) {
  const response = await fetch(new URL(path, origin), { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Проверка ${path}: HTTP ${response.status}`);
  if (path === '/healthz') {
    if ((await response.json()).ok !== true) throw new Error('Сервер не подтвердил готовность');
  } else await response.arrayBuffer();
  console.log(`OK ${path}`);
}

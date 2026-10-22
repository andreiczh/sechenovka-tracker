import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from './lib/store.mjs';
import { createPatient, createHistory, snapshot, applyAction, deliverReminders, botKeyboard } from './lib/patient.mjs';
import { demoNow } from './lib/time.mjs';
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'", 'Cache-Control': 'no-cache' };
function json(res, status, body, extra = {}) { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(body)); }
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('Слишком большой запрос'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Некорректный JSON'); }
}
export function createAppServer({ storePath = resolve(directory, '.data/demo.sqlite'), wallClock = () => Date.now() } = {}) {
  const store = createStore(storePath);
  const server = createServer(async (req, res) => {
    const host = req.headers.host;
    if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { json(res, 403, { error: 'Доступен только локальный адрес' }); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, `http://${host}`).pathname); } catch { json(res, 400, { error: 'Некорректный адрес' }); return; }
    if (pathname.startsWith('/api/')) {
      if (!['GET', 'POST'].includes(req.method)) { json(res, 405, { error: 'Метод не поддерживается' }, { Allow: 'GET, POST' }); return; }
      if (req.headers.origin && req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: 'Запрос с другого сайта запрещён' }); return; }
      if (req.method === 'POST' && (req.headers['x-demo-client'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))) { json(res, 403, { error: 'Требуется локальный JSON-клиент' }); return; }
      const cookieId = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('sechenovka_demo='))?.slice('sechenovka_demo='.length);
      const id = cookieId && /^[a-f0-9-]{36}$/.test(cookieId) ? cookieId : randomUUID();
      let state = store.get(id);
      const extra = !state ? { 'Set-Cookie': `sechenovka_demo=${id}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=2592000` } : {};
      if (!state) { state = createPatient(wallClock()); store.save(id, state); }
      try {
        if (req.method === 'GET' && pathname === '/api/state') { json(res, 200, { ...snapshot(state, wallClock()), keyboard: botKeyboard(state, demoNow(state, wallClock())) }, extra); return; }
        if (req.method === 'POST' && pathname === '/api/action') {
          const action = await readJson(req);
          state = store.get(id);
          if (action.revision !== state.revision) { json(res, 409, { error: 'Данные изменились в другом окне. Продолжите с актуального вопроса.', state: { ...snapshot(state, wallClock()), keyboard: botKeyboard(state, demoNow(state, wallClock())) } }, extra); return; }
          if (action.type === 'reset') state = createPatient(wallClock());
          else if (action.type === 'seed') state = createHistory(wallClock());
          else state = applyAction(structuredClone(state), action, wallClock());
          if (['reset', 'seed'].includes(action.type)) state.revision = action.revision + 1;
          store.save(id, state);
          json(res, 200, { ...snapshot(state, wallClock()), keyboard: botKeyboard(state, demoNow(state, wallClock())) }, extra); return;
        }
        json(res, 404, { error: 'Метод не найден' }, extra);
      } catch (error) { json(res, 400, { error: error.message }, extra); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }); res.end('Method not allowed'); return; }
    try {
      let file = resolve(root, '.' + pathname);
      if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403, headers); res.end('Forbidden'); return; }
      const info = await stat(file);
      if (info.isDirectory()) file = resolve(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { ...headers, 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': body.length }); res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Страница не найдена'); }
  });
  const timer = setInterval(() => { for (const { id, state } of store.all()) { if (deliverReminders(state, demoNow(state, wallClock()))) { state.revision++; store.save(id, state); } } }, 15000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); store.close(); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4173);
  const server = createAppServer();
  server.on('error', error => { console.error(`Сервер не запущен: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Трекер Сеченовка\nВОП: http://localhost:${port}/\nПациент: http://localhost:${port}/patient/\nДиалог бота: http://localhost:${port}/bot/`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createStore } from './lib/store.mjs';
import { createPostgresStore } from './lib/postgres-store.mjs';
import { readConfig, acceptsHost, acceptsOrigin } from './lib/config.mjs';
import { createPatient, createHistory, snapshot, applyAction, deliverReminders, botKeyboard } from './lib/patient.mjs';
import { demoNow } from './lib/time.mjs';
import { createClinicianWorkspace, clinicianList, clinicianPatient, saveClinicalReview, patientCarePlan } from './lib/clinician.mjs';
import { createTelegram } from './lib/telegram.mjs';
import { secretMatches, telegramSessionId, verifyTelegramInitData } from './lib/telegram-auth.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, 'public');
const { version } = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'", 'Cache-Control': 'no-cache' };
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(res, status, body, extra = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Некорректный JSON'); }
}
function authorizedJob(req, secret) {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return secret.length >= 32 && actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createAppServer({ config = readConfig(), storePath = config.storePath, storage = null, wallClock = () => Date.now(), logger = entry => console.error(JSON.stringify(entry)), telegramApi = null } = {}) {
  const store = storage || (config.databaseUrl ? createPostgresStore(config.databaseUrl) : createStore(storePath));
  const telegram = config.telegramToken ? createTelegram({ config, store, wallClock, logger, callApi: telegramApi }) : null;
  async function tick() {
    let profiles = 0;
    for (const { id } of await store.all()) {
      if (id.startsWith('tg-')) continue;
      await store.withSession(id, async transaction => {
        const state = await transaction.get(id);
        if (state && deliverReminders(state, demoNow(state, wallClock()))) {
          state.revision++;
          await transaction.save(id, state);
          profiles++;
        }
      });
    }
    return profiles + (telegram ? await telegram.tick() : 0);
  }
  async function view(state, id, transaction) {
    const inTelegram = id?.startsWith('tg-') || false;
    const chat = inTelegram ? await transaction.getTelegram(id) : null;
    return { ...snapshot(state, wallClock()), keyboard: botKeyboard(state, demoNow(state, wallClock())), carePlan: patientCarePlan(!inTelegram && id ? await transaction.getWorkspace(id) : null, state), telegram: { available: Boolean(telegram), authenticated: inTelegram, messagesEnabled: Boolean(chat && !chat.blocked), remindersScheduled: Boolean(telegram && config.scheduler === 'external'), username: config.telegramUsername || 'sechenov_track_bot' } };
  }
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const host = req.headers.host;
    let pathname = '';
    function fail(status, message, extra = {}) {
      // Never log cookies, authorization, answer bodies, notes or query strings.
      logger({ event: 'http_error', at: new Date().toISOString(), requestId, method: req.method, route: pathname.startsWith('/api/clinician/') ? '/api/clinician' : ['/api/state', '/api/action', '/internal/reminders/run', '/healthz'].includes(pathname) ? pathname : 'other', status });
      json(res, status, { error: message, requestId }, extra);
    }
    try {
      if (!acceptsHost(config, host)) { fail(403, 'Адрес сайта не разрешён'); return; }
      try { pathname = decodeURIComponent(new URL(req.url, config.publicOrigin || `http://${host}`).pathname); }
      catch { fail(400, 'Некорректный адрес'); return; }

      if (pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { fail(405, 'Метод не поддерживается', { Allow: 'GET, HEAD' }); return; }
        json(res, 200, req.method === 'HEAD' ? undefined : { ok: true, version, mode: 'synthetic-demo', telegram: telegram?.status || { enabled: false, ready: false } });
        return;
      }
      if (pathname === '/telegram/webhook') {
        if (!telegram) { fail(404, 'Метод не найден'); return; }
        if (req.method !== 'POST') { fail(405, 'Метод не поддерживается', { Allow: 'POST' }); return; }
        if (!secretMatches(req.headers['x-telegram-bot-api-secret-token'], config.telegramWebhookSecret)) { fail(403, 'Нет доступа'); return; }
        if (!req.headers['content-type']?.startsWith('application/json')) { fail(400, 'Требуется JSON'); return; }
        const result = await telegram.handleUpdate(await readJson(req));
        json(res, result.ok === false ? 503 : 200, { ok: result.ok !== false });
        return;
      }
      if (pathname === '/internal/reminders/run') {
        if (config.scheduler !== 'external') { fail(404, 'Метод не найден'); return; }
        if (req.method !== 'POST') { fail(405, 'Метод не поддерживается', { Allow: 'POST' }); return; }
        if (!authorizedJob(req, config.cronSecret)) { fail(403, 'Нет доступа'); return; }
        json(res, 200, { ok: true, changedProfiles: await tick() });
        return;
      }
      if (pathname.startsWith('/api/')) {
        if (!['GET', 'POST'].includes(req.method)) { fail(405, 'Метод не поддерживается', { Allow: 'GET, POST' }); return; }
        if (!acceptsOrigin(config, host, req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') { fail(403, 'Запрос с другого сайта запрещён'); return; }
        if (req.method === 'POST' && (req.headers['x-demo-client'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))) { fail(403, 'Требуется JSON-клиент приложения'); return; }
        const doctorRoute = /^\/api\/clinician\/patients(?:\/([a-z0-9-]+)(?:\/(review|events))?)?$/.exec(pathname);
        if (!(req.method === 'GET' && pathname === '/api/state' || req.method === 'POST' && pathname === '/api/action' || doctorRoute && (req.method === 'GET' && !doctorRoute[2] || req.method === 'POST' && doctorRoute[1] && doctorRoute[2]))) { fail(404, 'Метод не найден'); return; }
        const initData = req.headers['x-telegram-init-data'];
        const telegramLaunch = Boolean(initData || req.headers['x-telegram-launch'] === '1');
        let telegramIdentity;
        if (telegramLaunch) {
          if (!telegram) { fail(503, 'Подключение Telegram временно недоступно'); return; }
          try { telegramIdentity = verifyTelegramInitData(initData, config.telegramToken, wallClock()); }
          catch (error) { fail(401, error.message); return; }
          if (doctorRoute) { fail(403, 'Врачебный доступ из пациентского Telegram-профиля не подключён'); return; }
        }
        const cookieId = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('sechenovka_demo='))?.slice('sechenovka_demo='.length);
        const id = telegramIdentity ? telegramSessionId(telegramIdentity.userId, config.telegramIdentitySecret) : cookieId && /^[a-f0-9-]{36}$/.test(cookieId) ? cookieId : randomUUID();
        const action = req.method === 'POST' ? await readJson(req) : null;
        const outcome = await store.withSession(id, async transaction => {
          const reply = (status, data, extra = {}) => ({ status, data, extra });
          let state = await transaction.get(id);
          const extra = !state && !telegramIdentity ? { 'Set-Cookie': `sechenovka_demo=${id}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=2592000${config.publicOrigin?.startsWith('https:') ? '; Secure' : ''}` } : {};
          if (!state) { state = createPatient(wallClock()); await transaction.save(id, state); }
          if (!state.episodeId) { state.episodeId = randomUUID(); await transaction.save(id, state); }
          if (doctorRoute) {
            let workspace = await transaction.getWorkspace(id);
            if (!workspace) { workspace = createClinicianWorkspace(wallClock()); await transaction.saveWorkspace(id, workspace); }
            const patientId = doctorRoute[1];
            if (req.method === 'GET') {
              if (!patientId) return reply(200, { patients: clinicianList(workspace, state, wallClock()), demo: true }, extra);
              const patient = clinicianPatient(workspace, patientId, state, wallClock());
              if (!patient) throw new HttpError(404, 'Пациент не найден в этом демонстрационном кабинете');
              return reply(200, patient, extra);
            }
            const patient = clinicianPatient(workspace, patientId, state, wallClock());
            if (!patient) throw new HttpError(404, 'Пациент не найден в этом демонстрационном кабинете');
            if (!action || typeof action !== 'object' || Array.isArray(action)) throw new HttpError(400, 'Некорректное действие врача');
            if (doctorRoute[2] === 'events') {
              if (!['overview', 'assessments', 'diary', 'dynamics', 'plan', 'summary'].includes(action.view) || action.sourceRevision !== patient.sourceRevision) throw new HttpError(400, 'Показ данных не подтверждён актуальной версией');
              workspace.audit.push({ id: randomUUID(), event: 'view-presented', patientId, view: action.view, sourceRevision: patient.sourceRevision, at: new Date(wallClock()).toISOString() });
              workspace.audit = workspace.audit.slice(-200); await transaction.saveWorkspace(id, workspace);
              return reply(200, { ok: true }, extra);
            }
            const result = saveClinicalReview(workspace, patientId, state, action, wallClock());
            if (result.status !== 200) return reply(result.status, { error: result.error }, extra);
            await transaction.saveWorkspace(id, workspace);
            return reply(200, clinicianPatient(workspace, patientId, state, wallClock()), extra);
          }
          if (req.method === 'GET') return reply(200, await view(state, id, transaction), extra);

          if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string') throw new HttpError(400, 'Некорректное действие');
          if (action.revision !== state.revision) {
            return reply(409, { error: 'Данные изменились в другом окне. Продолжите с актуального вопроса.', state: await view(state, id, transaction) }, extra);
          }
          try {
            if (action.type === 'reset') state = createPatient(wallClock());
            else if (action.type === 'seed') state = createHistory(wallClock());
            else state = applyAction(structuredClone(state), action, wallClock());
          } catch (error) { throw new HttpError(400, error.message); }
          if (['reset', 'seed'].includes(action.type)) state.revision = action.revision + 1;
          await transaction.save(id, state);
          return reply(200, await view(state, id, transaction), extra);
        });
        // Respond only after the database transaction is committed successfully.
        json(res, outcome.status, outcome.data, outcome.extra);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { fail(405, 'Метод не поддерживается', { Allow: 'GET, HEAD' }); return; }
      try {
        let file = resolve(root, '.' + pathname);
        if (file !== root && !file.startsWith(root + sep)) { fail(403, 'Нет доступа'); return; }
        const info = await stat(file);
        if (info.isDirectory()) file = resolve(file, 'index.html');
        const body = await readFile(file);
        const pageHeaders = pathname.startsWith('/patient') ? { ...headers, 'Content-Security-Policy': headers['Content-Security-Policy'].replace("script-src 'self'", "script-src 'self' https://telegram.org").replace("frame-ancestors 'self'", "frame-ancestors 'self' https://web.telegram.org") } : headers;
        res.writeHead(200, { ...pageHeaders, 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch { res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Страница не найдена'); }
    } catch (error) { fail(error.status || 500, error.status ? error.message : 'Сервер временно недоступен. Повторите действие позже.'); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 15000;
  const timer = config.scheduler === 'local' ? setInterval(() => {
    tick().catch(() => logger({ event: 'reminder_error', at: new Date().toISOString() }));
  }, 15000) : null;
  timer?.unref();
  server.on('close', () => { clearInterval(timer); Promise.resolve(store.close()).catch(() => {}); });
  server.ready = store.ready;
  server.telegram = telegram;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = readConfig();
  const server = createAppServer({ config });
  server.on('error', error => { console.error(`Сервер не запущен: ${error.message}`); process.exitCode = 1; });
  server.ready.then(() => server.listen(config.port, config.host, () => {
    const origin = config.publicOrigin || `http://localhost:${config.port}`;
    console.log(`Трекер Сеченовка\nВОП: ${origin}/\nПациент: ${origin}/patient/\nПсихиатр: ${origin}/psychiatrist/\nДиалог бота: ${origin}/bot/\nПроверка: ${origin}/healthz`);
    server.telegram?.configure().catch(() => console.error(JSON.stringify({ event: 'telegram_setup_error', at: new Date().toISOString() })));
  })).catch(() => { console.error('Сервер не запущен: не удалось подключить постоянное хранилище. Проверьте серверные настройки.'); process.exitCode = 1; server.close(); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => server.close(() => process.exit(0)));
}

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createStore } from './lib/store.mjs';
import { createPostgresStore } from './lib/postgres-store.mjs';
import { readConfig, acceptsHost, acceptsOrigin } from './lib/config.mjs';
import { createPatient, createHistory, snapshot, applyAction, deliverReminders, botKeyboard } from './lib/patient.mjs';
import { demoNow } from './lib/time.mjs';
import { createClinicianWorkspace, clinicianList, clinicianListItem, clinicianPatient, saveClinicalReview, patientCarePlan } from './lib/clinician.mjs';
import { connectedCase, isSharedPatient, clinicWorkspaceId, emptyClinicWorkspace } from './lib/care-link.mjs';
import { createClinicianAuth } from './lib/clinician-auth.mjs';
import { aiView, createAiSummaryService } from './lib/ai-summary.mjs';
import { buildPatientSupport, selectedSupportStep, supportWindowText } from './lib/insights.mjs';
import { createPatientAiService, patientAiView, patientAiWorkspaceId, supportFingerprint } from './lib/patient-ai.mjs';
import { saveTherapyContext } from './lib/therapy-support.mjs';
import { createTelegram } from './lib/telegram.mjs';
import { secretMatches, telegramSessionId, verifyTelegramInitData } from './lib/telegram-auth.mjs';
import { createVoiceService } from './lib/voice.mjs';
import { createVoiceAssets } from './lib/voice-assets.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, 'public');
const { version } = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'", 'Cache-Control': 'no-cache' };
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(res, status, body, extra = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
async function readJson(req, maximum = 32768) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new HttpError(413, 'Слишком большой запрос');
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

export function createAppServer({ config = readConfig(), storePath = config.storePath, storage = null, wallClock = () => Date.now(), logger = entry => console.error(JSON.stringify(entry)), telegramApi = null, telegramFileFetch = undefined, aiFetch = undefined } = {}) {
  const store = storage || (config.databaseUrl ? createPostgresStore(config.databaseUrl) : createStore(storePath));
  const clinicianAuth = createClinicianAuth({ config, store, wallClock });
  const generateAiSummary = createAiSummaryService({ config, store, wallClock, logger, fetchImpl: aiFetch });
  const generatePatientAi = createPatientAiService({ config, store, wallClock, logger, fetchImpl: aiFetch });
  const voiceService = createVoiceService({ config, store, wallClock, logger, fetchImpl: aiFetch });
  const voiceAssets = createVoiceAssets();
  const telegram = config.telegramToken ? createTelegram({ config, store, wallClock, logger, callApi: telegramApi, generatePatientAi, fileFetch: telegramFileFetch }) : null;
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
    const link = state.careConnection;
    const carePlan = link ? patientCarePlan(await transaction.getWorkspace(clinicWorkspaceId(id)), state, link.id) : patientCarePlan(!inTelegram && id ? await transaction.getWorkspace(id) : null, state);
    const snap = snapshot(state, wallClock()), support = buildPatientSupport(snap, carePlan);
    const aiSupport = patientAiView(await transaction.getWorkspace(patientAiWorkspaceId(id)), support, config, wallClock());
    support.suggested = selectedSupportStep(support, !aiSupport.stale ? aiSupport.draft : null);
    return { ...snap, support: { ...support, sourceHash: supportFingerprint(support) }, aiSupport, keyboard: botKeyboard(state, demoNow(state, wallClock())), carePlan, connection: { available: Boolean(config.clinicianAccessKey), enabled: Boolean(isSharedPatient(state)), code: link?.code || null, name: link?.name || '', connectedAt: link?.connectedAt || null }, telegram: { available: Boolean(telegram), authenticated: inTelegram, messagesEnabled: Boolean(chat && !chat.blocked), remindersScheduled: Boolean(telegram && config.scheduler === 'external'), username: config.telegramUsername || 'sechenov_track_bot' } };
  }
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const host = req.headers.host;
    let pathname = '';
    function fail(status, message, extra = {}) {
      // Never log cookies, authorization, answer bodies, notes or query strings.
      logger({ event: 'http_error', at: new Date().toISOString(), requestId, method: req.method, route: pathname.startsWith('/api/clinic/') ? '/api/clinic' : pathname.startsWith('/api/clinician/') ? '/api/clinician' : ['/api/state', '/api/action', '/internal/reminders/run', '/healthz'].includes(pathname) ? pathname : 'other', status });
      json(res, status, { error: message, requestId }, extra);
    }
    try {
      if (!acceptsHost(config, host)) { fail(403, 'Адрес сайта не разрешён'); return; }
      try { pathname = decodeURIComponent(new URL(req.url, config.publicOrigin || `http://${host}`).pathname); }
      catch { fail(400, 'Некорректный адрес'); return; }

      if (pathname.startsWith('/voice-assets/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { fail(405, 'Метод не поддерживается', { Allow:'GET, HEAD' }); return; }
        const asset = await voiceAssets(pathname.slice('/voice-assets/'.length));
        if (!asset) { fail(404, 'Файл речевого модуля не найден'); return; }
        const type = pathname.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(pathname) ? 'text/javascript; charset=utf-8' : pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': asset.size, 'Cache-Control': 'public, max-age=86400', ETag: '"' + asset.sha + '"' });
        if(req.method==='HEAD'){res.end();return;}
        const stream = createReadStream(asset.file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }

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
        const doctorRoute = /^\/api\/clinician\/patients(?:\/([a-z0-9-]+)(?:\/(review|events|therapy-context|voice))?)?$/.exec(pathname);
        const clinicRoute = /^\/api\/clinic\/patients(?:\/(care-[a-f0-9-]{36})(?:\/(review|events|ai-summary|therapy-context|voice))?)?$/.exec(pathname);
        const clinicSession = pathname === '/api/clinic/session';
        const clinicLogout = req.method === 'POST' && pathname === '/api/clinic/logout';
        const patientRouteAllowed = route => route && (req.method === 'GET' && (!route[2] || route[2] === 'voice') || req.method === 'POST' && route[1] && route[2]);
        if (!(req.method === 'GET' && pathname === '/api/state' || req.method === 'POST' && ['/api/action', '/api/ai-support', '/api/voice'].includes(pathname) || req.method === 'GET' && ['/api/voice', '/api/voice/inbox', '/api/voice/audio'].includes(pathname) || patientRouteAllowed(doctorRoute) || patientRouteAllowed(clinicRoute) || clinicSession || clinicLogout)) { fail(404, 'Метод не найден'); return; }
        const initData = req.headers['x-telegram-init-data'];
        const telegramLaunch = Boolean(initData || req.headers['x-telegram-launch'] === '1');
        let telegramIdentity;
        if (telegramLaunch) {
          if (!telegram) { fail(503, 'Подключение Telegram временно недоступно'); return; }
          try { telegramIdentity = verifyTelegramInitData(initData, config.telegramToken, wallClock()); }
          catch (error) { fail(401, error.message); return; }
          if (doctorRoute || clinicRoute || clinicSession || clinicLogout) { fail(403, 'Войдите в кабинет отдельно от пациентского Telegram-профиля'); return; }
        }
        if (clinicSession || clinicLogout || clinicRoute) {
          if (clinicSession) {
            if (req.method === 'GET') {
              const session = await clinicianAuth.authenticate(req);
              json(res, 200, { enabled: Boolean(config.clinicianAccessKey), authenticated: Boolean(session), expiresAt: session?.expiresAt || null, aiEnabled: config.aiEnabled }); return;
            }
            const action = await readJson(req);
            const result = await clinicianAuth.login(req, action?.key);
            if (result.status !== 200) { fail(result.status, result.error); return; }
            json(res, 200, result.data, { 'Set-Cookie': result.setCookie }); return;
          }
          if (clinicLogout) {
            await readJson(req);
            json(res, 200, { ok: true }, { 'Set-Cookie': await clinicianAuth.logout(req) }); return;
          }
          if (!await clinicianAuth.authenticate(req)) { fail(401, 'Войдите в учебный кабинет психиатра'); return; }
          const rows = (await store.all()).filter(row => isSharedPatient(row.state));
          const patientId = clinicRoute[1];
          if (!patientId) {
            const patients = [];
            for (const row of rows) {
              const item = await store.withSession(row.id, async transaction => {
                const state = await transaction.get(row.id);
                if (!isSharedPatient(state)) return null;
                const workspace = await transaction.getWorkspace(clinicWorkspaceId(row.id)) || emptyClinicWorkspace(wallClock());
                return clinicianListItem(clinicianPatient(workspace, state.careConnection.id, state, wallClock(), connectedCase(state, row.id)));
              });
              if (item) patients.push(item);
            }
            json(res, 200, { patients, demo: true, workspace: 'connected' }); return;
          }
          const row = rows.find(row => row.state.careConnection.id === patientId);
          if (!row) { fail(404, 'Профиль не найден или пациент отключил передачу'); return; }
          const action = req.method === 'POST' ? await readJson(req, pathname.endsWith('/voice') ? 1048576 : 32768) : null;
          if (clinicRoute[2] === 'voice') {
            const result = await voiceService({ sessionId: row.id, patientId, scope: 'psychiatrist', clinic: true, action: action || { op: 'list' }, authorize: () => clinicianAuth.authenticate(req) });
            json(res, 200, result); return;
          }
          if (clinicRoute[2] === 'ai-summary') {
            const result = await generateAiSummary({ sessionId: row.id, patientId, action, authorize: () => clinicianAuth.authenticate(req) });
            json(res, 200, result); return;
          }
          const outcome = await store.withSession(row.id, async transaction => {
            const state = await transaction.get(row.id);
            if (!isSharedPatient(state) || state.careConnection.id !== patientId) throw new HttpError(404, 'Профиль не найден или пациент отключил передачу');
            const workspaceId = clinicWorkspaceId(row.id);
            const workspace = await transaction.getWorkspace(workspaceId) || emptyClinicWorkspace(wallClock());
            const entry = connectedCase(state, row.id);
            const project = () => { const p = clinicianPatient(workspace, patientId, state, wallClock(), entry); p.ai = aiView(workspace, p, config, wallClock()); return p; };
            if (req.method === 'GET') return { status: 200, data: project() };
            if (!action || typeof action !== 'object' || Array.isArray(action)) throw new HttpError(400, 'Некорректное действие врача');
            if (clinicRoute[2] === 'events') {
              const patient = project();
              if (!['overview', 'assessments', 'diary', 'dynamics', 'plan', 'summary', 'support', 'voice'].includes(action.view) || action.sourceRevision !== patient.sourceRevision) throw new HttpError(409, 'Данные пациента изменились. Обновите карточку.');
              workspace.audit.push({ id: randomUUID(), event: 'view-presented', patientId, view: action.view, sourceRevision: patient.sourceRevision, at: new Date(wallClock()).toISOString() });
              workspace.audit = workspace.audit.slice(-200);
            } else if (clinicRoute[2] === 'therapy-context') {
              const result = saveTherapyContext(workspace, project(), action, wallClock());
              if (result.status !== 200) return { status: result.status, data: { error: result.error } };
            } else {
              const result = saveClinicalReview(workspace, patientId, state, action, wallClock(), entry);
              if (result.status !== 200) return { status: result.status, data: { error: result.error } };
            }
            await transaction.saveWorkspace(workspaceId, workspace);
            return { status: 200, data: clinicRoute[2] === 'events' ? { ok: true } : project() };
          });
          json(res, outcome.status, outcome.data); return;
        }
        const cookieId = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('sechenovka_demo='))?.slice('sechenovka_demo='.length);
        const id = telegramIdentity ? telegramSessionId(telegramIdentity.userId, config.telegramIdentitySecret) : cookieId && /^[a-f0-9-]{36}$/.test(cookieId) ? cookieId : randomUUID();
        const action = req.method === 'POST' ? await readJson(req, pathname.endsWith('/voice') ? 1048576 : 32768) : null;
        if (doctorRoute?.[2] === 'voice') {
          json(res, 200, await voiceService({ sessionId: id, patientId: doctorRoute[1], scope: 'psychiatrist', action: action || { op: 'list' } })); return;
        }
        if (pathname === '/api/voice') {
          const scope = action?.scope || new URL(req.url, 'http://localhost').searchParams.get('scope') || 'patient';
          if (!['patient', 'vop'].includes(scope)) throw new HttpError(400, 'Invalid voice scope');
          json(res, 200, await voiceService({ sessionId: id, scope, action: action || { op: 'list' } })); return;
        }
        if (pathname === '/api/voice/inbox' || pathname === '/api/voice/audio') {
          if (!telegramIdentity || !telegram) throw new HttpError(401, 'Open the voice note from Telegram');
          const result = await telegram.readVoice(id, pathname.endsWith('/audio'));
          if (result.bytes) { res.writeHead(200, { ...headers, 'Content-Type': result.contentType || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(result.bytes); }
          else json(res, 200, result);
          return;
        }
        if (pathname === '/api/ai-support') {
          const result = await generatePatientAi({ sessionId: id, action });
          json(res, 200, result); return;
        }
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
              if (!['overview', 'assessments', 'diary', 'dynamics', 'plan', 'summary', 'support', 'voice'].includes(action.view) || action.sourceRevision !== patient.sourceRevision) throw new HttpError(400, 'Показ данных не подтверждён актуальной версией');
              workspace.audit.push({ id: randomUUID(), event: 'view-presented', patientId, view: action.view, sourceRevision: patient.sourceRevision, at: new Date(wallClock()).toISOString() });
              workspace.audit = workspace.audit.slice(-200); await transaction.saveWorkspace(id, workspace);
              return reply(200, { ok: true }, extra);
            }
            const result = doctorRoute[2] === 'therapy-context' ? saveTherapyContext(workspace, patient, action, wallClock()) : saveClinicalReview(workspace, patientId, state, action, wallClock());
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
            if (action.type === 'connect-doctor' && !config.clinicianAccessKey) throw new Error('Учебный кабинет пока не подключён');
            if (action.type === 'reset') state = { ...createPatient(wallClock()), careConnection: state.careConnection || null };
            else if (action.type === 'seed') state = { ...createHistory(wallClock()), careConnection: state.careConnection || null };
            else if (action.type === 'bot' && typeof action.text === 'string' && ['/insights', '/ai', '/aiconsent'].includes(action.text.trim())) {
              const current = await view(state, id, transaction), at = demoNow(state, wallClock());
              const text = action.text.trim() === '/insights' ? supportWindowText(current.support) : 'В браузерном симуляторе откройте «Мой разбор» в Mini App: там можно подтвердить обработку вымышленных данных и подготовить короткий ИИ-разбор. Здесь /insights покажет тот же сохранённый результат. В настоящем Telegram доступны /ai и /aiconsent.';
              state.messages.push({ id: randomUUID(), role: 'user', text: action.text.trim(), at }, { id: randomUUID(), role: 'bot', text, at }); state.messages = state.messages.slice(-320); state.revision++;
            }
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
  server.warmVoice = async () => {
    const manifest = JSON.parse(await readFile(resolve(directory, 'docs/evidence/voice-assets.json'), 'utf8'));
    const paths = Object.keys(manifest.assets);
    for (let i = 0; i < paths.length; i += 2) await Promise.all(paths.slice(i, i + 2).map(path => voiceAssets(path)));
    logger({ event: 'voice_assets_ready', assets: paths.length, version: manifest.version });
  };
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
    if (process.env.RENDER) void server.warmVoice().catch(() => console.error(JSON.stringify({ event: 'voice_assets_retry_on_demand' })));
  })).catch(() => { console.error('Сервер не запущен: не удалось подключить постоянное хранилище. Проверьте серверные настройки.'); process.exitCode = 1; server.close(); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => server.close(() => process.exit(0)));
}

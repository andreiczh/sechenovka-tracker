import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { readConfig } from '../lib/config.mjs';
import { createAppServer } from '../server.mjs';
import { CLINICIAN_SESSION_MS } from '../lib/clinician-auth.mjs';
import { scoreAssessment } from '../public/shared/clinical.js';

const TOKEN = '123456:synthetic_token_for_clinic_integration';
const SECRET = 'synthetic_clinic_webhook_12345678901234';
const KEY = 'synthetic-clinic-access-key-123456789';
const USER = 123456789;
function signed(userId, now) {
  const data = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: userId, first_name: 'Never copied to doctor' }) });
  const check = [...data].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  data.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(TOKEN).digest()).update(check).digest('hex'));
  return data.toString();
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sechenovka-linked-'));
  let now = Date.parse('2026-10-23T10:00:00Z'), server, messageId = 0, clinicianCookie, accessKey = KEY;
  const calls = [], logs = [];
  const start = async () => {
    const config = readConfig({ PUBLIC_ORIGIN: 'https://clinic.example', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_IDENTITY_SECRET: SECRET, CLINICIAN_ACCESS_KEY: accessKey, REMINDER_SCHEDULER: 'off' });
    server = createAppServer({ config, storePath: join(dir, 'demo.sqlite'), wallClock: () => now, logger: entry => logs.push(entry), telegramApi: async (method, payload) => { calls.push({ method, payload }); return { message_id: calls.length }; } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  };
  const stop = async () => { server.close(); await once(server, 'close'); };
  const request = (path, { body, cookie, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method: body === undefined ? 'GET' : 'POST', headers: { Host: 'clinic.example', ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Demo-Client': '1' }), ...headers } }, res => {
      const parts = []; res.on('data', chunk => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';')[0], cookieHeader: res.headers['set-cookie']?.[0], data: JSON.parse(Buffer.concat(parts).toString()) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const patient = async (id = USER) => { const r = await request('/api/state', { headers: { 'X-Telegram-Init-Data': signed(id, now) } }); assert.equal(r.status, 200); return r.data; };
  const action = async (body, id = USER) => request('/api/action', { headers: { 'X-Telegram-Init-Data': signed(id, now) }, body: { revision: (await patient(id)).revision, ...body } });
  const send = async text => { const id = ++messageId; const r = await request('/telegram/webhook', { headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: { update_id: id, message: { message_id: id, from: { id: USER, is_bot: false }, chat: { id: USER, type: 'private' }, text } } }); assert.equal(r.status, 200); };
  const login = async key => { const r = await request('/api/clinic/session', { body: { key: key || accessKey } }); if (r.status === 200) clinicianCookie = r.cookie; return r; };
  const doctor = (path = '', body) => request('/api/clinic/patients' + path, { cookie: clinicianCookie, body });
  await start();
  t.after(async () => { if (server.listening) await stop(); await rm(dir, { recursive: true, force: true }); });
  return { request, patient, action, send, login, doctor, calls, logs, cookie: () => clinicianCookie, restart: async key => { await stop(); if (key) accessKey = key; await start(); }, advance: ms => { now += ms; } };
}

test('bot → Mini App → protected clinic: consent, two questionnaires, diary, dynamics, private review, returned plan, restart and revocation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/clinic/patients')).status, 401);
  assert.equal((await f.login('wrong')).status, 401);
  const login = await f.login(); assert.match(login.cookieHeader, /HttpOnly; SameSite=Strict/); assert.match(login.cookieHeader, /Secure/); assert.doesNotMatch(JSON.stringify(login.data), /synthetic-clinic-access/);
  assert.deepEqual((await f.doctor()).data.patients, []);
  await f.send('/start'); await f.send('/share'); // age not confirmed
  assert.deepEqual((await f.doctor()).data.patients, []);
  await f.send('Мне 18+, начать'); await f.send('/doctor');
  assert.equal((await f.patient()).connection.enabled, false);
  await f.send('/share');
  let p = await f.patient(); const id = p.careConnection.id;
  let d = (await f.doctor('/' + id)).data;
  assert.equal(d.identity.code, p.connection.code); assert.equal(d.assessments.length, 0);
  assert.equal(d.draft.scores.phq.answered, 0); assert.equal(d.draft.scores.phq.score, null);
  assert.doesNotMatch(JSON.stringify(d), /Never copied to doctor|"chatId"|tg-[a-f0-9]{64}/);
  const phq = [1, 2, 1, 1, 0, 1, 1, 0, 1], gad = [1, 2, 1, 1, 1, 0, 1];
  let i = 0;
  while ((p = await f.patient()).flow) {
    const q = p.flow.question;
    const value = q.id === 'safety' ? q.options.find(o => /Сейчас нет/.test(o.label)).value : q.id.startsWith('phq-') ? phq[Number(q.id.slice(4))] : q.id.startsWith('gad-') ? gad[Number(q.id.slice(4))] : q.type === 'text' ? 'Вымышленная цель для интеграционного теста' : q.options[0].value;
    if (i++ % 2) { await f.send('Продолжить'); const current = (await f.patient()).flow.question; await f.send(current.options?.find(o => o.value === value)?.label || String(value)); }
    else assert.equal((await f.action({ type: 'answer', questionId: q.id, value })).status, 200);
    if (i > 30) throw new Error('Question flow did not terminate');
  }
  d = (await f.doctor('/' + id)).data;
  assert.equal(d.assessments[0].id, p.assessments[0].id);
  assert.deepEqual(d.assessments[0].scores, scoreAssessment(p.assessments[0]));
  assert.equal(d.assessments[0].scores.phq.score, 8); assert.equal(d.safety.needsClarification, true);
  for (const advance of [0, 1, 3]) {
    if (advance) assert.equal((await f.action({ type: 'advance', days: advance })).status, 200);
    assert.equal((await f.action({ type: 'start', kind: 'diary' })).status, 200);
    while ((p = await f.patient()).flow) {
      const q = p.flow.question;
      const value = q.type === 'sleep' ? advance ? null : 0 : q.type === 'text' ? 'Синтетическая заметка' : q.id === 'mood' ? 5 : q.id === 'anxiety' ? 4 : q.options[0].value;
      assert.equal((await f.action({ type: 'answer', questionId: q.id, value })).status, 200);
    }
  }
  assert.equal((await f.action({ type: 'advance', days: 10 })).status, 200);
  assert.equal((await f.action({ type: 'start' })).status, 200);
  while ((p = await f.patient()).flow) {
    const q = p.flow.question; assert.equal((await f.action({ type: 'answer', questionId: q.id, value: q.type === 'text' ? 'Контрольная цель' : q.options[0].value })).status, 200);
  }
  d = (await f.doctor('/' + id)).data;
  assert.equal(d.assessments.length, 2); assert.deepEqual(d.diary.map(e => e.id), p.diary.map(e => e.id));
  assert.equal(d.stats.recorded, 3); assert.equal(d.stats.sleep, 0); assert.equal(d.stats.sleepCount, 1);
  assert.equal(d.delta.phq, -8); assert.equal(d.delta.gad, -7); assert.ok(d.stats.missing > 0);
  assert.match(d.summary, /Синтетическая заметка/);
  const values = { clinicalNote: 'PRIVATE-CLINIC-NOTE', safetyNote: 'PRIVATE-SAFETY-NOTE', goal: 'Понятная цель', plan: 'Согласованный тестовый план', watch: 'Дневник', earlyContact: 'Обсудить ухудшение', nextDate: '2026-12-01', nextTime: '12:00' };
  const review = (state, type, extra = {}) => f.doctor('/' + id + '/review', { type, values, episodeId: state.episodeId, sourceRevision: state.sourceRevision, revision: state.review.revision, reviewed: true, ...extra });
  const draft = await review(d, 'draft'); assert.equal(draft.status, 200); assert.equal((await f.patient()).carePlan, null);
  assert.equal((await review(d, 'confirm')).status, 409);
  const fresh = draft.data;
  await f.action({ type: 'appointment', date: '', time: '13:00', question: 'Новый вопрос' });
  assert.equal((await review(fresh, 'confirm')).status, 409);
  d = (await f.doctor('/' + id)).data;
  const confirmed = await review(d, 'confirm'); assert.equal(confirmed.status, 200);
  p = await f.patient(); assert.equal(p.carePlan.plan, values.plan);
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE-CLINIC|PRIVATE-SAFETY/);
  assert.equal((await f.patient(USER + 1)).carePlan, null);
  await f.send('/doctor'); assert.ok(f.calls.some(c => c.payload?.text?.includes(values.plan)));
  assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE-CLINIC|PRIVATE-SAFETY/);
  const latest = (await f.doctor('/' + id)).data;
  const longValues = { ...values, goal: 'Ц'.repeat(900), plan: 'П'.repeat(1800), watch: 'Н'.repeat(900), earlyContact: 'К'.repeat(900) };
  assert.equal((await review(latest, 'confirm', { values: longValues })).status, 200);
  const beforeLong = f.calls.length; await f.send('/doctor');
  const chunks = f.calls.slice(beforeLong).filter(c => c.method === 'sendMessage').map(c => c.payload.text);
  assert.ok(chunks.length >= 2); assert.ok(chunks.every(text => text.length <= 3500)); assert.ok(chunks.join('').includes(longValues.plan));
  p = await f.patient();
  const ordinary = await f.request('/api/clinician/patients/live'); assert.equal(ordinary.status, 200); assert.equal(ordinary.data.review.confirmed, null);
  assert.equal((await f.request('/api/clinic/patients', { headers: { 'X-Telegram-Init-Data': signed(USER, Date.parse('2026-10-23T10:00:00Z')) } })).status, 403);
  const before = p.carePlan.id;
  await f.restart(); assert.equal((await f.patient()).carePlan.id, before); assert.equal((await f.doctor('/' + id)).data.diary.length, 3);
  await f.send('/unshare'); assert.equal((await f.doctor('/' + id)).status, 404); assert.equal((await f.doctor()).data.patients.length, 0);
  assert.equal((await f.patient()).carePlan.id, before);
  assert.equal((await f.action({ type: 'connect-doctor', name: 'Вымышленный пациент', consent: true })).status, 200);
  assert.equal((await f.patient()).careConnection.id, id); assert.equal((await f.doctor('/' + id)).data.identity.name, 'Вымышленный пациент');
  const stolenCookie = f.cookie(); assert.equal((await f.request('/api/clinic/logout', { cookie: stolenCookie, body: {} })).status, 200);
  assert.equal((await f.request('/api/clinic/patients', { cookie: stolenCookie })).status, 401);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE-|synthetic-clinic-access|sechenovka_clinician|Never copied/);
});

test('clinic access expires, revokes on key change, and throttles wrong keys without exposing patient data', async t => {
  const f = await fixture(t);
  await f.login(); const old = f.cookie();
  f.advance(CLINICIAN_SESSION_MS + 1); assert.equal((await f.doctor()).status, 401);
  await f.login(); await f.restart('another-synthetic-key-123456789012'); assert.equal((await f.doctor()).status, 401);
  assert.equal((await f.request('/api/clinic/session', { cookie: old })).data.authenticated, false);
  for (let i = 0; i < 8; i++) assert.equal((await f.login('incorrect')).status, 401);
  assert.equal((await f.login()).status, 429);
  f.advance(900001); assert.equal((await f.login()).status, 200);
  assert.equal((await f.request('/api/clinic/session', { body: { key: KEY }, headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('browser sharing is explicit; an open demo doctor cannot see the protected clinic notes; concurrent confirms conflict', async t => {
  const f = await fixture(t); await f.login();
  const first = await f.request('/api/state'), cookie = first.cookie;
  const action = async body => f.request('/api/action', { cookie, body: { revision: (await f.request('/api/state', { cookie })).data.revision, ...body } });
  assert.equal((await action({ type: 'connect-doctor', consent: true })).status, 400);
  await action({ type: 'join', adult: true });
  assert.equal((await f.doctor()).data.patients.length, 0);
  assert.equal((await action({ type: 'connect-doctor', name: 'X' })).status, 400);
  await action({ type: 'connect-doctor', name: 'Браузерный пример', consent: true });
  const p = (await f.request('/api/state', { cookie })).data, id = p.careConnection.id;
  let d = (await f.doctor('/' + id)).data;
  const values = { clinicalNote: 'SECRET-INTERNAL-REVIEW', safetyNote: '', goal: 'Цель', plan: 'Тестовый план', watch: 'Дневник', earlyContact: 'Связаться', nextDate: '2026-11-01', nextTime: '15:00' };
  const write = () => f.doctor('/' + id + '/review', { type: 'confirm', values, episodeId: d.episodeId, sourceRevision: d.sourceRevision, revision: d.review.revision, reviewed: true });
  const results = await Promise.all([write(), write()]); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const publicDoctor = await f.request('/api/clinician/patients/live', { cookie }); assert.doesNotMatch(JSON.stringify(publicDoctor), /SECRET-INTERNAL-REVIEW/);
  assert.doesNotMatch(JSON.stringify((await f.request('/api/state', { cookie })).data), /SECRET-INTERNAL-REVIEW/);
  await action({ type: 'reset' }); await action({ type: 'join', adult: true });
  assert.equal((await f.request('/api/state', { cookie })).data.carePlan, null);
  d = (await f.doctor('/' + id)).data; assert.equal(d.review.confirmed, null);
});

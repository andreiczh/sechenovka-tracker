import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createAppServer } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { verifyTelegramInitData, telegramSessionId } from '../lib/telegram-auth.mjs';
import { scoreAssessment } from '../public/shared/clinical.js';
import { createPatient } from '../lib/patient.mjs';
import { createTelegram } from '../lib/telegram.mjs';

const TOKEN = '123456:synthetic_token_for_tests_not_a_real_key';
const SECRET = 'synthetic_webhook_secret_123456789012';
const IDENTITY = 'synthetic_identity_secret_123456789012';
const WALL = Date.parse('2026-10-23T05:59:00Z');
const USER = 123456789;

test('an incomplete transport fixture cannot stop the reminder scheduler or send a message', async () => {
  const patient = createPatient(WALL), calls = [];
  const rows = { incomplete: { state: { count: 2 }, chat: { outbox: [{ status: 'pending', id: 'synthetic-message' }] } }, real: { state: patient, chat: { chatId: USER, outbox: [], seen: [] } } };
  const store = { allTelegram: async () => Object.keys(rows).map(id => ({ id })), withSession: async (id, fn) => fn({ get: async () => rows[id].state, getTelegram: async () => rows[id].chat, saveTelegram: async () => {} }) };
  const bot = createTelegram({ config: { publicOrigin: 'https://bot.example' }, store, wallClock: () => WALL, callApi: async (...args) => calls.push(args) });
  assert.equal(await bot.tick(), 0);
  assert.deepEqual(await bot.flush('incomplete'), { sent: 0 });
  assert.equal(calls.length, 0);
  assert.equal(rows.incomplete.chat.outbox[0].status, 'pending');
});
function signed(id = USER, now = WALL, extra = {}) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id, first_name: 'Синтетический' }), ...extra });
  const check = [...params].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}

test('Telegram validates HMAC, all signed fields, timestamp, unique keys and a real user ID', () => {
  assert.equal(verifyTelegramInitData(signed(), TOKEN, WALL).userId, USER);
  assert.equal(verifyTelegramInitData(signed(USER, WALL, { signature: 'unused-third-party-signature' }), TOKEN, WALL).userId, USER);
  for (const data of ['', signed().replace(String(USER), '987654321'), signed() + '&user=bad', signed(USER, WALL - 86400001), signed(USER, WALL + 120000), signed(0)]) assert.throws(() => verifyTelegramInitData(data, TOKEN, WALL));
  assert.throws(() => verifyTelegramInitData(signed(), TOKEN + 'wrong', WALL));
  assert.notEqual(telegramSessionId(USER, IDENTITY), telegramSessionId(USER + 1, IDENTITY));
  assert.match(telegramSessionId(USER, IDENTITY), /^tg-[a-f0-9]{64}$/);
});

async function fixture(t, customApi) {
  const dir = await mkdtemp(join(tmpdir(), 'sechenovka-telegram-'));
  let now = WALL, messageId = 0, updateId = 0, server, url;
  const calls = [];
  const api = async (method, payload) => {
    if (customApi) await customApi(method, payload);
    calls.push({ method, payload: structuredClone(payload) });
    return method === 'getMe' ? { username: 'sechenov_track_bot', is_bot: true } : { message_id: calls.length };
  };
  const config = readConfig({ PUBLIC_ORIGIN: 'https://bot.example', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_IDENTITY_SECRET: IDENTITY, REMINDER_SCHEDULER: 'external', CRON_SECRET: SECRET });
  const start = async () => {
    server = createAppServer({ config, storePath: join(dir, 'demo.sqlite'), wallClock: () => now, logger: () => {}, telegramApi: api });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { server.close(); await once(server, 'close'); };
  await start();
  t.after(async () => { if (server.listening) await stop(); await rm(dir, { recursive: true, force: true }); });
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: new URL(url).port, path, method: options.method || 'GET', headers: { Host: 'bot.example', ...options.headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject); req.end(options.body);
  });
  const auth = id => ({ 'X-Telegram-Init-Data': signed(id, now), 'X-Telegram-Launch': '1' });
  const state = async (id = USER) => { const r = await request('/api/state', { headers: auth(id) }); assert.equal(r.status, 200); return r.json(); };
  const update = text => ({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(now / 1000), from: { id: USER, is_bot: false }, chat: { id: USER, type: 'private' }, text } });
  const webhook = (data, secret = SECRET) => request('/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(data) });
  const send = async text => { const data = update(text); const response = await webhook(data); assert.equal(response.status, 200); return data; };
  const action = async body => { const s = await state(); return request('/api/action', { method: 'POST', headers: { ...auth(USER), 'Content-Type': 'application/json', 'X-Demo-Client': '1' }, body: JSON.stringify({ revision: s.revision, ...body }) }); };
  const tick = () => request('/internal/reminders/run', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } });
  return { calls, request, state, action, auth, update, webhook, send, tick, setNow: value => { now = value; }, restart: async () => { await stop(); await start(); }, server: () => server };
}

test('Telegram start, reply keyboard and Mini App share answers; duplicates, stale revisions and other identities cannot change them', async t => {
  const f = await fixture(t);
  await f.server().telegram.configure();
  const setup = f.calls.find(c => c.method === 'setWebhook').payload;
  assert.equal(setup.max_connections, 1); assert.equal(setup.drop_pending_updates, false);
  const first = await f.send('/start');
  assert.equal(f.calls.filter(c => c.method === 'sendPhoto').length, 1);
  assert.match(f.calls.find(c => c.method === 'sendPhoto').payload.caption, /вымышленные|демонстрационная/);
  assert.equal(f.calls.find(c => c.method === 'sendPhoto').payload.reply_markup.keyboard[0][0].text, 'Мне 18+, начать');
  assert.ok(f.calls.some(c => c.payload?.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url === 'https://bot.example/patient/'));
  const count = f.calls.length; assert.equal((await f.webhook(first)).status, 200); assert.equal(f.calls.length, count);
  await f.send('Мне 18+, начать');
  assert.equal((await f.state()).flow.question.id, 'phq-0');
  await f.send('1'); assert.equal((await f.state()).flow.question.id, 'phq-1');
  await f.send('/start'); assert.equal((await f.state()).flow.question.id, 'phq-1');
  const stale = (await f.state()).revision;
  assert.equal((await f.action({ type: 'answer', questionId: 'phq-1', value: 2 })).status, 200);
  const conflict = await f.request('/api/action', { method: 'POST', headers: { ...f.auth(USER), 'Content-Type': 'application/json', 'X-Demo-Client': '1' }, body: JSON.stringify({ type: 'answer', questionId: 'phq-2', value: 0, revision: stale }) });
  assert.equal(conflict.status, 409);
  await f.send('Назад'); assert.equal((await f.state()).flow.question.id, 'phq-1');
  await f.send('2'); await f.send('Пауза'); const cursor = (await f.state()).flow.cursor;
  await f.send('Продолжить'); assert.equal((await f.state()).flow.cursor, cursor);
  await f.send('Это не ответ на шкалу'); assert.equal((await f.state()).flow.cursor, cursor);
  while ((await f.state()).flow) {
    const question = (await f.state()).flow.question;
    await f.send(question.type === 'text' ? 'Придуманная цель' : question.id === 'phq-8' ? '0' : question.options[0].label);
  }
  const completed = await f.state();
  assert.equal(completed.assessments.length, 1);
  const scores = scoreAssessment(completed.assessments[0]); assert.equal(scores.phq.score, 3); assert.equal(scores.gad.score, 0);
  assert.ok(f.calls.some(c => c.payload?.text?.includes('PHQ-9: 3 из 27')));
  const serialized = JSON.stringify(completed);
  for (const privateValue of [SECRET, IDENTITY, TOKEN, 'chatId', 'outbox', 'lastMessageId']) assert.ok(!serialized.includes(privateValue));
  assert.equal((await f.state(USER + 1)).joined, false);
  assert.equal((await (await f.request('/api/state')).json()).joined, false);
  assert.equal((await f.request('/api/clinician/patients', { headers: f.auth(USER) })).status, 403);
  assert.equal((await f.request('/api/state', { headers: { 'X-Telegram-Init-Data': 'forged', 'X-Telegram-Launch': '1' } })).status, 401);
  assert.equal((await f.request('/api/state', { headers: { 'X-Telegram-Launch': '1' } })).status, 401);
  assert.equal((await f.webhook(f.update('/start'), 'wrong')).status, 403);
  const group = f.update('1'); group.message.chat.type = 'group';
  const before = f.calls.length; assert.equal((await f.webhook(group)).status, 200); assert.equal(f.calls.length, before);
  await f.restart(); assert.equal((await f.state()).assessments[0].id, completed.assessments[0].id);
  assert.equal((await f.webhook(first)).status, 200); assert.equal((await f.state()).assessments.length, 1);
});

test('a positive PHQ item 9 interrupts Telegram and does not count the safety clarification in the scale', async t => {
  const f = await fixture(t); await f.send('/start'); await f.send('Мне 18+, начать');
  for (let i = 0; i < 8; i++) await f.send('0');
  await f.send('1'); const safety = await f.state();
  assert.equal(safety.flow.kind, 'safety'); assert.equal(safety.assessments.length, 0);
  assert.ok(f.calls.at(-1).payload.reply_markup.keyboard.every(row => row.every(button => !/^0 ·/.test(button.text))));
  const label = safety.flow.question.options.find(o => o.value === 'contact').label;
  await f.send(label); assert.equal((await f.state()).flow.question.id, 'gad-0');
  assert.ok(f.calls.some(c => c.payload?.text?.includes('не подтверждает безопасность')));
});

test('after Mini App advances, a stale reply keyboard cannot answer a different question', async t => {
  const f = await fixture(t); await f.send('/start'); await f.send('Мне 18+, начать');
  assert.equal((await f.state()).flow.question.id, 'phq-0');
  await f.action({ type: 'answer', questionId: 'phq-0', value: 2 });
  assert.equal((await f.state()).flow.question.id, 'phq-1');
  await f.send('0');
  const protectedState = await f.state();
  assert.equal(protectedState.flow.question.id, 'phq-1');
  assert.equal(protectedState.active.values['phq-0'], 2);
  assert.equal(protectedState.active.values['phq-1'], undefined);
  assert.ok(f.calls.some(c => c.payload?.text?.includes('Этот ответ пока не сохранён')));
  await f.send('1'); assert.equal((await f.state()).flow.question.id, 'phq-2');
  await f.action({ type: 'answer', questionId: 'phq-2', value: 2 });
  await f.send('Продолжить'); assert.equal((await f.state()).flow.question.id, 'phq-3');
  await f.send('0'); assert.equal((await f.state()).flow.question.id, 'phq-4');
});

test('an unsent Telegram question is refreshed if Mini App advances during an outage', async t => {
  let fail = false;
  const f = await fixture(t, async (_method, payload) => { if (fail && payload?.text?.startsWith('Вопрос')) throw new Error('synthetic outage'); });
  await f.send('/start'); fail = true;
  const join = f.update('Мне 18+, начать'); assert.equal((await f.webhook(join)).status, 503);
  await f.action({ type: 'answer', questionId: 'phq-0', value: 1 });
  fail = false; f.setNow(WALL + 6000);
  assert.equal((await f.webhook(join)).status, 200);
  assert.match(f.calls.at(-1).payload.text, /^Вопрос 2 из 19/);
  await f.send('0'); assert.equal((await f.state()).flow.question.id, 'phq-2');
});

test('an unconfirmed Telegram send remains durable; retry and server restart do not replay the answer', async t => {
  let fail = true;
  const f = await fixture(t, async method => { if (method === 'sendPhoto' && fail) throw Object.assign(new Error('synthetic outage'), { transient: true }); });
  const start = f.update('/start'); assert.equal((await f.webhook(start)).status, 503);
  assert.equal((await f.state()).joined, false);
  await f.restart(); fail = false; f.setNow(WALL + 6000);
  assert.equal((await f.webhook(start)).status, 200);
  assert.equal(f.calls.filter(c => c.method === 'sendPhoto').length, 1);
  await f.send('Мне 18+, начать'); const answer = f.update('2');
  await Promise.all([f.webhook(answer), f.webhook(answer)]);
  const s = await f.state(); assert.equal(s.flow.cursor, 1); assert.equal(s.active.values['phq-0'], 2);
});

test('real Telegram reminders are confirmed once, cancel after completion, and /stop disables subsequent deliveries', async t => {
  const f = await fixture(t); await f.send('/start'); await f.send('Мне 18+, начать');
  await f.action({ type: 'reminders', settings: { enabled: true, times: ['09:00', '14:00', '20:00'], timeZone: 'Europe/Moscow' } });
  f.setNow(Date.parse('2026-10-23T06:15:00Z'));
  assert.equal((await f.tick()).status, 200); const first = await f.state();
  assert.equal(first.deliveries.length, 1); assert.equal(first.deliveries[0].transport, 'telegram');
  await f.tick(); assert.equal((await f.state()).deliveries.length, 1);
  while ((await f.state()).flow) { const q = (await f.state()).flow.question; await f.send(q.type === 'text' ? 'Придуманная цель' : q.options[0].label); }
  f.setNow(Date.parse('2026-10-23T11:15:00Z')); await f.tick(); assert.equal((await f.state()).deliveries.length, 1);
  f.setNow(Date.parse('2026-10-24T06:15:00Z')); await f.tick(); assert.equal((await f.state()).deliveries.length, 2);
  await f.send('/stop'); assert.equal((await f.state()).reminders.enabled, false);
  f.setNow(Date.parse('2026-10-24T11:15:00Z')); await f.tick(); assert.equal((await f.state()).deliveries.length, 2);
});

test('a reminder queued during a network outage is cancelled if the patient finishes before retry', async t => {
  let failure = false;
  const f = await fixture(t, async (_method, payload) => { if (failure && payload?.text?.startsWith('Время короткой записи')) throw new Error('synthetic outage'); });
  await f.send('/start'); await f.send('Мне 18+, начать');
  await f.action({ type: 'reminders', settings: { enabled: true, times: ['09:00'], timeZone: 'Europe/Moscow' } });
  failure = true; f.setNow(WALL + 120000); await f.tick(); assert.equal((await f.state()).deliveries.length, 0);
  // Complete through the app while the transport is unavailable.
  while ((await f.state()).flow) { const q = (await f.state()).flow.question; await f.action({ type: 'answer', questionId: q.id, value: q.type === 'text' ? 'Цель' : q.options[0].value }); }
  failure = false; f.setNow(WALL + 180000); await f.tick();
  assert.equal((await f.state()).deliveries.length, 0);
  assert.ok(!f.calls.some(c => c.payload?.text?.startsWith('Время короткой записи')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreScale, scoreAssessment, assessmentSteps, diarySteps } from '../public/shared/clinical.js';
import { createPatient, createHistory, applyAction, snapshot, currentTask, flowView, deliverReminders, reminderSlots, botKeyboard } from '../lib/patient.mjs';
import { localParts, zonedInstant, validateReminders } from '../lib/time.mjs';
import { telegramReplyPayload } from '../lib/telegram-adapter.mjs';
const WALL = Date.parse('2026-10-23T05:30:00Z'); // 08:30 Moscow
const action = (state, value) => applyAction(state, value, WALL);
function finish(state, kind = 'assessment', override = {}) {
  action(state, { type: 'start', kind });
  for (let guard = 0; flowView(state) && guard < 25; guard++) {
    const q = flowView(state).question;
    let value = Object.hasOwn(override, q.id) ? override[q.id] : q.type === 'sleep' ? null : q.type === 'text' ? '' : q.options[0].value;
    action(state, { type: 'answer', questionId: q.id, value });
  }
}
function baseline() { const state = createPatient(WALL); action(state, { type: 'join', adult: true }); finish(state); return state; }
test('PHQ-9 and GAD-7 score every severity boundary without diagnostic probability', () => {
  for (const [kind, max, length, boundaries] of [['phq', 27, 9, [0, 5, 10, 15, 20]], ['gad', 21, 7, [0, 5, 10, 15]]]) {
    for (let total = 0; total <= max; total++) {
      let remaining = total;
      const answers = Array.from({ length }, () => { const v = Math.min(3, remaining); remaining -= v; return v; });
      const result = scoreScale(kind, answers);
      assert.equal(result.score, total);
      assert.equal(result.level, boundaries.filter(v => total >= v).length - 1);
      assert.equal('probability' in result, false);
    }
  }
});
test('missing, out-of-range and string answers never become zeros', () => {
  for (const answers of [Array(9).fill(null), Array(9).fill('1'), [1], [...Array(8).fill(0), -1], [...Array(8).fill(0), 4]]) assert.equal(scoreScale('phq', answers).score, null);
  assert.equal(assessmentSteps().filter(s => s.kind === 'phq').length, 9);
  assert.equal(assessmentSteps().filter(s => s.kind === 'gad').length, 7);
});
test('baseline produces dated two-week windows, separate scores, no new full survey before day 14', () => {
  const state = baseline(), s = snapshot(state, WALL);
  assert.deepEqual(state.assessments[0].window, { start: '2026-10-10', end: '2026-10-23', days: 14 });
  assert.equal(scoreAssessment(state.assessments[0]).phq.score, 0);
  assert.equal(s.task.kind, 'done');
  action(state, { type: 'advance', days: 1 });
  assert.equal(snapshot(state, WALL).task.kind, 'diary');
  assert.throws(() => action(state, { type: 'start', kind: 'assessment' }), /не запланированы/);
  action(state, { type: 'advance', days: 13 });
  assert.equal(snapshot(state, WALL).task.mode, 'repeat');
  finish(state);
  assert.equal(state.assessments.length, 2);
  action(state, { type: 'advance', days: 1 });
  assert.equal(snapshot(state, WALL).task.kind, 'review');
});
test('positive PHQ item 9 interrupts before GAD even when total PHQ is only one', () => {
  const state = createPatient(WALL); action(state, { type: 'join', adult: true }); action(state, { type: 'start' });
  for (let i = 0; i < 9; i++) action(state, { type: 'answer', questionId: `phq-${i}`, value: i === 8 ? 1 : 0 });
  assert.equal(flowView(state).kind, 'safety');
  assert.equal(state.active.cursor, 9);
  assert.equal(state.assessments.length, 0);
  action(state, { type: 'answer', questionId: 'safety', value: 'urgent' });
  assert.equal(snapshot(state, WALL).recommendation.tone, 'red');
  assert.match(snapshot(state, WALL).recommendation.text, /112/);
  assert.deepEqual(reminderSlots(state, new Date(WALL).toISOString()), []);
  assert.equal(state.safety.needsGuidance, true);
  assert.deepEqual(botKeyboard(state), [['Нужна помощь'], ['Вернуться к заданию']]);
  assert.throws(() => action(state, { type: 'answer', questionId: 'gad-0', value: 0 }), /паузу/);
  action(state, { type: 'resumeAfterHelp' });
  assert.equal(state.safety.level, 'urgent');
  action(state, { type: 'answer', questionId: 'gad-0', value: 0 });
  assert.equal(state.active.cursor, 10);
});
test('unknown safety answer preserves help; no-current-thoughts still suggests clinician contact', () => {
  for (const value of ['unknown', 'contact']) {
    const state = baseline(); action(state, { type: 'help' }); action(state, { type: 'answer', questionId: 'safety', value });
    assert.equal(state.safetyEvents.length, 1);
    assert.equal(snapshot(state, WALL).recommendation.tone, 'red');
    assert.match(snapshot(state, WALL).recommendation.text, value === 'contact' ? /врачом/ : /112/);
  }
});
test('daily change review starts on day 1; sleep can be missing and 0 is a real value', () => {
  assert.equal(diarySteps(0).some(s => s.id === 'change'), false);
  assert.equal(diarySteps(1).some(s => s.id === 'change'), true);
  assert.equal(diarySteps(7).some(s => s.id === 'change'), true);
  const state = baseline(); action(state, { type: 'advance', days: 7 });
  finish(state, 'diary', { mood: 0, anxiety: 0, sleep: null, change: 'Стало хуже' });
  const s = snapshot(state, WALL);
  assert.equal(s.stats.mood, 0); assert.equal(s.stats.sleep, null); assert.equal(s.stats.sleepCount, 0);
  assert.equal(s.stats.missing, 6); assert.equal(s.task.kind, 'done');
  assert.equal(s.recommendation.title, 'Стоит связаться с врачом');
});
test('invalid and stale answers cannot advance a question; back preserves previous value', () => {
  const state = createPatient(WALL); action(state, { type: 'join', adult: true }); action(state, { type: 'start' });
  assert.throws(() => action(state, { type: 'answer', questionId: 'phq-0', value: 9 }), /Выберите/);
  assert.equal(state.active.cursor, 0);
  action(state, { type: 'answer', questionId: 'phq-0', value: 2 });
  assert.throws(() => action(state, { type: 'answer', questionId: 'phq-0', value: 1 }), /изменился/);
  action(state, { type: 'back' }); assert.equal(flowView(state).selected, 2);
  assert.throws(() => applyAction(state, { type: 'answer', questionId: 'phq-0', value: 0 }, WALL + 86400001), /сутки/);
});
test('three reminders are idempotent, stop after completion, start again next local day', () => {
  const state = baseline(); action(state, { type: 'advance', days: 1 });
  action(state, { type: 'reminders', settings: { enabled: true, times: ['09:00', '14:00', '20:00'], timeZone: 'Europe/Moscow' } });
  const first = '2026-10-24T06:00:00Z';
  assert.equal(deliverReminders(state, first), true);
  assert.equal(deliverReminders(state, first), false);
  assert.equal(state.deliveries.length, 1);
  finish(state, 'diary');
  assert.equal(deliverReminders(state, '2026-10-24T11:00:00Z'), false);
  assert.equal(deliverReminders(state, '2026-10-24T17:00:00Z'), false);
  assert.equal(deliverReminders(state, '2026-10-25T06:00:00Z'), true);
});
test('reminders have no catch-up storm, respect activation time, disabled settings and timezone', () => {
  const state = createPatient(WALL); action(state, { type: 'join', adult: true });
  action(state, { type: 'reminders', settings: { enabled: true, times: ['08:00', '09:00'], timeZone: 'Europe/Moscow' } });
  assert.equal(reminderSlots(state, new Date(WALL).toISOString()).some(s => s.date === '2026-10-23' && s.time === '08:00'), false);
  assert.equal(deliverReminders(state, '2026-10-23T06:05:00Z'), false);
  assert.equal(deliverReminders(state, '2026-10-23T06:00:10Z'), true);
  state.reminders.enabled = false; assert.equal(reminderSlots(state, '2026-10-24T05:00:00Z').length, 0);
  assert.deepEqual(localParts('2026-10-23T22:30:00Z', 'Europe/Moscow').date, '2026-10-24');
  assert.equal(new Date(zonedInstant('2026-10-24', '09:00', 'Asia/Vladivostok')).toISOString(), '2026-10-23T23:00:00.000Z');
  assert.equal(zonedInstant('2026-03-08', '02:30', 'America/New_York'), null);
});
test('invalid duplicate reminder times and unknown timezone are rejected', () => {
  for (const value of [{ enabled: true, times: [], timeZone: 'Europe/Moscow' }, { enabled: true, times: ['09:00', '09:00'], timeZone: 'Europe/Moscow' }, { enabled: true, times: ['25:00'], timeZone: 'Europe/Moscow' }, { enabled: true, times: ['09:00'], timeZone: 'Mars/Foo' }]) assert.throws(() => validateReminders(value));
});
test('bot text and bottom buttons use the same saved answers as Mini App', () => {
  const state = createPatient(WALL);
  action(state, { type: 'bot', text: 'Мне 18+, начать' });
  assert.match(botKeyboard(state, new Date(WALL).toISOString())[0][0], /^0 · Совсем нет$/);
  action(state, { type: 'bot', text: '2' }); assert.equal(state.active.values['phq-0'], 2);
  action(state, { type: 'bot', text: 'не понимаю' }); assert.equal(state.active.cursor, 1);
  action(state, { type: 'answer', questionId: 'phq-1', value: 1 });
  assert.equal(state.active.cursor, 2);
  action(state, { type: 'bot', text: 'В течение нескольких дней' });
  assert.equal(state.active.values['phq-2'], 1);
  const payload = telegramReplyPayload(state, 12345, new Date(WALL).toISOString());
  assert.equal(payload.reply_markup.resize_keyboard, true);
  assert.equal(payload.reply_markup.keyboard[0][0].text, '0 · Совсем нет');
  assert.throws(() => telegramReplyPayload(state, 'unverified'));
  action(state, { type: 'bot', text: 'Пауза' });
  assert.deepEqual(botKeyboard(state, new Date(WALL).toISOString())[0], ['Продолжить']);
  const cursor = state.active.cursor;
  action(state, { type: 'bot', text: 'Продолжить' });
  assert.equal(state.active.cursor, cursor);
  assert.equal(state.botPaused, false);
});
test('synthetic history reports exact denominators, source, and no fabricated missing days', () => {
  const state = createHistory(WALL), s = snapshot(state, WALL);
  assert.equal(s.day, 13); assert.equal(s.stats.recorded, 10); assert.equal(s.stats.expected, 13); assert.equal(s.stats.missing, 3);
  assert.equal(s.stats.sleepCount, 9);
  assert.equal(s.diary.some(e => e.day === 4), false);
  assert.equal(s.task.kind, 'diary');
  assert.equal(scoreAssessment(s.assessments[0]).phq.score, 12);
  assert.equal(s.diary.every(e => e.source === 'synthetic-example'), true);
});
test('attended appointment stops reminder stage without declaring remission', () => {
  const state = createHistory(WALL); action(state, { type: 'attended' });
  assert.equal(currentTask(state, new Date(WALL).toISOString()).kind, 'handoff');
  assert.equal(state.reminders.enabled, false);
  assert.equal(state.assessments.length, 1);
  assert.throws(() => action(state, { type: 'start', kind: 'diary' }), /завершён/);
});
test('impossible appointment dates are rejected, dates remain self-reported', () => {
  const state = baseline();
  assert.throws(() => action(state, { type: 'appointment', date: '2026-02-31', time: '12:00', question: '' }), /Проверьте/);
  action(state, { type: 'appointment', date: '2026-10-26', time: '12:00', question: 'Сон' });
  assert.equal(state.appointment.date, '2026-10-26');
  assert.equal('clinicianConfirmed' in state.appointment, false);
});
test('bot can restart a stale assessment instead of mixing two-week windows', () => {
  const state = createPatient(WALL); action(state, { type: 'bot', text: 'Мне 18+, начать' });
  action(state, { type: 'bot', text: '1' });
  const later = WALL + 86400001;
  assert.equal(botKeyboard(state, new Date(later).toISOString())[0][0], 'Начать заново');
  applyAction(state, { type: 'bot', text: 'Начать заново' }, later);
  assert.equal(state.active.cursor, 0); assert.deepEqual(state.active.values, {});
  assert.equal(state.active.date, '2026-10-24');
  applyAction(state, { type: 'bot', text: '/start' }, later);
  assert.match(state.messages.at(-1).text, /Снижение интереса/);
});

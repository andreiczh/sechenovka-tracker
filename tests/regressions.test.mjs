import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatient, applyAction, snapshot, flowView } from '../lib/patient.mjs';
import { diarySteps } from '../public/shared/clinical.js';

const WALL = Date.parse('2026-10-23T05:30:00Z');
const act = (state, action, time = WALL) => applyAction(state, action, time);
function finish(state, kind = 'assessment', values = {}, time = WALL) {
  act(state, { type: 'start', kind }, time);
  for (let i = 0; i < 30; i++) {
    const flow = flowView(state, new Date(time + state.clockOffsetMs).toISOString());
    if (!flow) return;
    const q = flow.question;
    const value = Object.hasOwn(values, q.id) ? values[q.id] : q.type === 'text' ? '' : q.type === 'sleep' ? null : q.options[0].value;
    act(state, { type: 'answer', questionId: q.id, value }, time);
  }
  throw new Error('Flow did not complete');
}
function baseline(values = {}) {
  const state = createPatient(WALL);
  act(state, { type: 'join', adult: true });
  finish(state, 'assessment', values);
  return state;
}

test('F01: a day-14 diary cannot satisfy the outstanding repeat assessment', () => {
  const state = baseline();
  act(state, { type: 'advance', days: 14 });
  finish(state, 'diary');
  let view = snapshot(state, WALL);
  assert.equal(view.assessments.length, 1);
  assert.equal(view.task.kind, 'assessment');
  assert.equal(view.task.mode, 'repeat');
  act(state, { type: 'reminders', settings: { enabled: true, times: ['09:00'], timeZone: 'Europe/Moscow' } });
  assert.equal(snapshot(state, WALL).nextReminder.taskId, 'repeat');
  finish(state);
  view = snapshot(state, WALL);
  assert.equal(view.assessments.length, 2);
  assert.equal(view.task.kind, 'review');
  assert.equal(view.nextReminder, null);
});

test('F02: requesting help with negative PHQ item 9 never invents reported thoughts', () => {
  const state = baseline();
  act(state, { type: 'help' });
  act(state, { type: 'answer', questionId: 'safety', value: 'contact' });
  const view = snapshot(state, WALL);
  assert.equal(view.assessments[0].answers[8], 0);
  assert.doesNotMatch(view.recommendation.text, /Вы (отметили|сообщили) мысли|Обсудите отмеченные мысли/);
  assert.doesNotMatch(view.messages.at(-1).text, /отмеченные мысли/);
  assert.match(view.recommendation.text, /помощ|врач/);
});

test('F02: a genuine positive PHQ item 9 remains represented after a later generic help request', () => {
  const state = baseline({ 'phq-8': 1, safety: 'contact' });
  act(state, { type: 'help' });
  act(state, { type: 'answer', questionId: 'safety', value: 'contact' });
  assert.match(snapshot(state, WALL).recommendation.text, /мысли/);
  assert.equal(state.assessments[0].answers[8], 1);
});

test('F03: new daily functional difficulties and explicit worsening affect feedback from day 1', () => {
  for (const values of [{ function: 3, mood: 0, anxiety: 10 }, { function: 0, change: 'Стало хуже' }]) {
    const state = baseline();
    act(state, { type: 'advance', days: 1 });
    assert.equal(diarySteps(1).some(q => q.id === 'change'), true);
    finish(state, 'diary', values);
    const view = snapshot(state, WALL);
    assert.equal(view.recommendation.tone, 'red');
    assert.match(view.recommendation.text, /врач|консультац/);
    assert.doesNotMatch(view.recommendation.text, /диагноз установлен|112/);
  }
});

test('F04: an optional day-0 entry participates in counts and numeric summaries', () => {
  const state = baseline();
  finish(state, 'diary', { mood: 4, anxiety: 6, sleep: 0 });
  const view = snapshot(state, WALL);
  assert.equal(view.diary.length, 1);
  assert.equal(view.stats.recorded, 1);
  assert.equal(view.stats.expected, 1);
  assert.equal(view.stats.baselineRecorded, true);
  assert.equal(view.stats.mood, 4);
  assert.equal(view.stats.anxiety, 6);
  assert.equal(view.stats.sleep, 0);
  assert.equal(view.stats.missing, 0);
  act(state, { type: 'advance', days: 1 });
  assert.equal(snapshot(state, WALL).stats.expected, 2);
  assert.equal(snapshot(state, WALL).stats.missing, 1);
});

test('F05: an old diary requires an explicit date choice and uses dated questions when resumed', () => {
  const state = baseline();
  act(state, { type: 'advance', days: 1 });
  act(state, { type: 'start', kind: 'diary' });
  act(state, { type: 'answer', questionId: 'mood', value: 3 });
  const later = WALL + 2 * 86400000;
  const view = snapshot(state, later);
  assert.equal(view.flow.kind, 'diary-date');
  assert.match(view.flow.question.text, /24 октября/);
  act(state, { type: 'answer', questionId: view.flow.question.id, value: 'finish' }, later);
  const resumed = snapshot(state, later);
  assert.equal(resumed.flow.date, '2026-10-24');
  assert.match(resumed.flow.question.window, /24 октября/);
  assert.doesNotMatch(resumed.flow.question.text, /сегодня/);
  finish(state, 'diary', {}, later);
  assert.equal(state.diary[0].date, '2026-10-24');
  assert.equal(state.diary[0].mood, 3);
  assert.equal(state.diary[0].retrospective, true);
  assert.equal(snapshot(state, later).task.kind, 'diary');
});

test('F05: choosing today explicitly replaces the unsaved draft without backdating new answers', () => {
  const state = baseline();
  act(state, { type: 'advance', days: 1 });
  act(state, { type: 'start', kind: 'diary' });
  act(state, { type: 'answer', questionId: 'mood', value: 3 });
  const later = WALL + 2 * 86400000;
  act(state, { type: 'answer', questionId: snapshot(state, later).flow.question.id, value: 'today' }, later);
  assert.equal(state.diaryDraft.date, '2026-10-26');
  assert.equal(state.diaryDraft.cursor, 0);
  assert.deepEqual(state.diaryDraft.values, {});
  finish(state, 'diary', { mood: 8 }, later);
  assert.equal(state.diary.length, 1);
  assert.equal(state.diary[0].date, '2026-10-26');
  assert.equal(state.diary[0].retrospective, false);
});

test('F06: repeat completion explains the consultation step, not a new day-14 promise', () => {
  const state = baseline();
  act(state, { type: 'advance', days: 14 });
  finish(state);
  assert.match(state.messages.at(-1).text, /сводк|Обсудите/);
  assert.doesNotMatch(state.messages.at(-1).text, /Следующий плановый повтор|через 14 дней после исходного/);
});

test('an old diary after day 14 offers an explicit exit to the due assessment', () => {
  const state = baseline();
  act(state, { type: 'advance', days: 1 });
  act(state, { type: 'start', kind: 'diary' });
  const later = WALL + 15 * 86400000;
  const question = snapshot(state, later).flow.question;
  assert.equal(question.options.some(o => o.value === 'today'), false);
  act(state, { type: 'answer', questionId: question.id, value: 'skip' }, later);
  assert.equal(state.diaryDraft, null);
  assert.equal(state.active.mode, 'repeat');
  assert.equal(state.diary.length, 0);
});

test('F07: after an attended visit the diary is unavailable, including an empty diary', () => {
  const state = baseline();
  act(state, { type: 'attended' });
  const view = snapshot(state, WALL);
  assert.equal(view.diaryAvailable, false);
  assert.equal(view.flow, null);
  assert.equal(view.task.kind, 'handoff');
  assert.throws(() => act(state, { type: 'start', kind: 'diary' }), /завершён/);
});

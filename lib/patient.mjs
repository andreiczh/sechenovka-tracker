import { randomUUID } from 'node:crypto';
import { assessmentSteps, diarySteps, scoreAssessment, patientRecommendation, contactGuidance, SAFETY_QUESTION, SAFETY_OPTIONS, URGENT_TEXT, FORM_VERSION } from '../public/shared/clinical.js';
import { addDays, daysBetween, localParts, zonedInstant, demoNow, validateReminders } from './time.mjs';

export function createPatient(wallNow = Date.now()) {
  const now = new Date(wallNow).toISOString();
  return {
    schema: 1, episodeId: randomUUID(), revision: 0, createdAt: now, clockOffsetMs: 0, joined: false,
    reminders: { enabled: false, times: ['19:00'], timeZone: 'Europe/Moscow', activatedAt: now },
    assessments: [], active: null, diary: [], diaryDraft: null, completedDates: [], safety: null, safetyEvents: [],
    appointment: { date: '', time: '12:00', question: '', attended: false },
    messages: [{ id: randomUUID(), role: 'bot', text: 'Это демонстрационная версия «Трекера Сеченовка». Здесь можно пройти исходные PHQ-9 и GAD-7, а затем делать короткие записи. Используйте только вымышленные данные. Врач не следит за перепиской. Чтобы начать, подтвердите, что вам 18 лет или больше.', at: now }],
    deliveries: [], botPaused: false,
  };
}
export function todayOf(state, now) { return localParts(now, state.reminders.timeZone).date; }
export function monitoringDay(state, now) {
  return state.assessments.length ? Math.max(0, daysBetween(state.assessments[0].date, todayOf(state, now))) : 0;
}
export function currentTask(state, now) {
  const date = todayOf(state, now);
  if (!state.joined) return { kind: 'join', title: 'Знакомство', date };
  if (state.appointment.attended) return { kind: 'handoff', title: 'Сводка к приёму сохранена', date };
  if (!state.assessments.length) return { kind: 'assessment', mode: 'baseline', title: 'Первичный скрининг', id: 'baseline', date };
  const day = monitoringDay(state, now);
  if (day >= 14 && !state.assessments.some(a => a.mode === 'repeat')) return { kind: 'assessment', mode: 'repeat', title: 'Повтор PHQ-9 и GAD-7', id: 'repeat', date };
  if (day >= 14) return { kind: 'review', title: 'Обсудить итоги с врачом', date };
  // Completion belongs to an actual task. A diary never satisfies a due repeat.
  if (state.assessments.some(a => a.date === date) || state.diary.some(e => e.date === date)) return { kind: 'done', title: 'На сегодня всё', date };
  return { kind: 'diary', title: day >= 7 && !state.diary.some(e => e.day >= 7) ? 'Дневник и проверка изменений' : 'Дневник самочувствия', id: `diary-${date}`, date, day };
}
export function diaryAvailable(state, now) {
  return state.joined && state.assessments.length > 0 && !state.appointment.attended && monitoringDay(state, now) <= 14 && !state.diary.some(e => e.date === todayOf(state, now));
}
export function flowView(state, now) {
  if (state.safety?.pending) return { kind: 'safety', cursor: 0, total: 1, question: { id: 'safety', text: SAFETY_QUESTION, type: 'choice', options: SAFETY_OPTIONS, window: 'Отдельное уточнение · в баллы не входит' } };
  if (state.appointment.attended) return null;
  const active = state.active || state.diaryDraft;
  if (!active) return null;
  const kind = state.active ? 'assessment' : 'diary';
  const staleDiary = kind === 'diary' && now && active.date !== todayOf(state, now);
  if (staleDiary && active.confirmedOn !== todayOf(state, now)) {
    const date = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${active.date}T12:00:00Z`));
    const alternative = diaryAvailable(state, now) ? { value: 'today', label: 'Начать сегодняшнюю запись вместо старого черновика' } : { value: 'skip', label: 'Удалить несохранённый черновик и вернуться к плану' };
    return { kind: 'diary-date', id: active.id, cursor: 0, total: 1, date: active.date, startedAt: active.startedAt, question: { id: 'diary-date', type: 'choice', text: `Осталась незаконченная запись за ${date}. Как продолжить?`, window: 'Выберите дату · старый черновик ещё не сохранён в дневнике', options: [{ value: 'finish', label: `Закончить запись за ${date}` }, alternative] } };
  }
  const steps = kind === 'assessment' ? assessmentSteps() : diarySteps(active.day, staleDiary ? active.date : null);
  const question = steps[active.cursor];
  return { kind, id: active.id, mode: active.mode, cursor: active.cursor, total: steps.length, question, selected: active.values[question.id] ?? null, date: active.date, startedAt: active.startedAt };
}
function pushMessage(state, role, text, now, extra = {}) {
  state.messages.push({ id: randomUUID(), role, text, at: now, ...extra });
  state.messages = state.messages.slice(-320);
}
function askCurrent(state, now) {
  const f = flowView(state, now);
  if (f) pushMessage(state, 'bot', `${f.question.window}\n${f.question.text}`, now, { questionId: f.question.id });
}
function startTask(state, now, requested) {
  if (!state.joined) throw new Error('Сначала подтвердите возраст и ознакомьтесь с условиями демонстрации');
  if (state.appointment.attended) throw new Error('Этот этап завершён. Дальнейший план нужно согласовать с врачом.');
  if (state.safety?.pending) return;
  const task = currentTask(state, now);
  if (state.active || state.diaryDraft) return;
  const kind = requested || task.kind;
  if (kind === 'assessment') {
    if (task.kind !== 'assessment') throw new Error('Сегодня полные анкеты не запланированы. Следующий повтор — на 14-й день.');
    state.active = { id: randomUUID(), mode: task.mode, date: task.date, startedAt: now, cursor: 0, values: {}, version: FORM_VERSION };
  } else if (kind === 'diary') {
    if (!state.assessments.length) throw new Error('Сначала завершите первичные анкеты');
    if (state.diary.some(d => d.date === todayOf(state, now))) throw new Error('Запись за сегодня уже есть');
    if (!diaryAvailable(state, now)) throw new Error('Двухнедельный этап завершён. Сохраните сводку и обсудите дальнейший план с врачом.');
    state.diaryDraft = { id: randomUUID(), date: todayOf(state, now), day: monitoringDay(state, now), startedAt: now, cursor: 0, values: {} };
  } else throw new Error('На сегодня нет незавершённой анкеты');
  askCurrent(state, now);
}
function validateAnswer(question, value) {
  if (question.type === 'text') {
    if (typeof value !== 'string' || value.length > 1000) throw new Error('Введите текст до 1000 символов');
    if (!question.optional && !value.trim()) throw new Error('Введите ответ');
    return value.trim();
  }
  if (question.type === 'sleep') {
    if (value === null && question.optional) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 24 || value * 2 !== Math.round(value * 2)) throw new Error('Укажите от 0 до 24 часов с шагом 0,5 или пропустите');
    return value;
  }
  if (!question.options.some(option => option.value === value)) throw new Error('Выберите один из предложенных вариантов');
  return value;
}
function completeFlow(state, now, kind) {
  const active = kind === 'assessment' ? state.active : state.diaryDraft;
  if (kind === 'assessment') {
    const steps = assessmentSteps();
    const answers = steps.slice(0, 16).map(q => active.values[q.id]);
    const entry = { id: active.id, mode: active.mode, version: active.version, startedAt: active.startedAt, completedAt: now, date: todayOf(state, now), window: { start: addDays(active.date, -13), end: active.date, days: 14 }, answers, context: { function: active.values.function, duration: active.values.duration, goal: active.values.goal } };
    const scores = scoreAssessment(entry);
    if (!scores.phq.complete || !scores.gad.complete) throw new Error('Остались вопросы без ответа');
    state.assessments.push(entry);
    state.active = null;
    const next = active.mode === 'repeat' ? 'Повторные анкеты готовы. Сохраните сводку и обсудите итоги и дальнейший план с врачом. Новые полные анкеты автоматически не назначены.' : 'Полные анкеты не нужно проходить каждый день. Следующий плановый повтор — через 14 дней после исходного скрининга.';
    pushMessage(state, 'bot', `Анкеты завершены. PHQ-9: ${scores.phq.score} из 27. GAD-7: ${scores.gad.score} из 21. Это выраженность симптомов, а не диагноз. ${patientRecommendation(state).text}\n${next}`, now);
  } else {
    state.diary.push({ ...active.values, id: active.id, date: active.date, day: active.day, recordedAt: now, source: 'self-report', retrospective: active.date !== todayOf(state, now) });
    state.diary.sort((a, b) => a.date.localeCompare(b.date));
    state.diaryDraft = null;
    pushMessage(state, 'bot', 'Запись сохранена. Вы отметили настроение, тревогу, сон и влияние на обычные дела. Посмотреть её и динамику можно в Mini App. Если состояние ухудшилось, не ждите следующего напоминания — свяжитесь с врачом.', now);
    if (currentTask(state, now).mode === 'repeat') pushMessage(state, 'bot', 'Повтор PHQ-9 и GAD-7 ещё не заполнен. Запись дневника его не заменяет. Напоминания о повторе остаются до его завершения.', now);
  }
  if (!state.completedDates.includes(active.date)) state.completedDates.push(active.date);
  // Completing a baseline or repeat today also stops all remaining prompts today.
  if (kind === 'assessment' && !state.completedDates.includes(todayOf(state, now))) state.completedDates.push(todayOf(state, now));
}
function answer(state, now, value, questionId) {
  const flow = flowView(state, now);
  if (!flow) throw new Error('Сначала начните запланированное задание');
  if (flow.question.id !== questionId) throw new Error('Вопрос уже изменился. Обновите страницу и продолжите.');
  value = validateAnswer(flow.question, value);
  state.botPaused = false;
  const label = flow.question.options?.find(o => o.value === value)?.label ?? (value === null || value === '' ? 'Пропустить' : String(value));
  pushMessage(state, 'user', label, now);
  if (flow.kind === 'diary-date') {
    if (value === 'skip') {
      state.diaryDraft = null;
      pushMessage(state, 'bot', 'Несохранённый черновик удалён по вашему выбору. Завершённые записи остались в истории.', now);
      if (currentTask(state, now).kind === 'assessment') startTask(state, now);
      return;
    } else if (value === 'today') {
      if (!diaryAvailable(state, now)) throw new Error('За сегодня уже есть запись или этап завершён. Можно закончить только прежнюю запись.');
      state.diaryDraft = { id: randomUUID(), date: todayOf(state, now), day: monitoringDay(state, now), startedAt: now, cursor: 0, values: {} };
    } else state.diaryDraft.confirmedOn = todayOf(state, now);
    askCurrent(state, now);
    return;
  }
  if (flow.kind === 'safety') {
    state.safety.level = value;
    state.safety.pending = false;
    state.safety.needsGuidance = value !== 'contact';
    state.safetyEvents.push({ source: state.safety.source, level: value, at: now });
    pushMessage(state, 'bot', value === 'contact' ? `${contactGuidance(state)} Ответ «сейчас нет» сам по себе не подтверждает безопасность. Если ситуация изменится, откройте «Нужна помощь». Врач не получает экстренное уведомление из этого прототипа.` : URGENT_TEXT, now);
    if (value === 'contact') askCurrent(state, now);
    return;
  }
  if (state.safety?.needsGuidance) throw new Error('Сначала откройте памятку помощи. Обычный опрос поставлен на паузу.');
  const active = flow.kind === 'assessment' ? state.active : state.diaryDraft;
  if (flow.kind === 'assessment' && Date.parse(now) - Date.parse(active.startedAt) > 86400000) throw new Error('С начала анкет прошли сутки. Начните их заново, чтобы сохранить единое окно ответов.');
  active.values[flow.question.id] = value;
  active.cursor++;
  if (flow.question.id === 'phq-8' && value > 0) {
    state.safety = { level: null, pending: true, source: 'PHQ-9, пункт 9', at: now };
    askCurrent(state, now);
    return;
  }
  if (active.cursor === flow.total) completeFlow(state, now, flow.kind);
  else askCurrent(state, now);
}
export function reminderSlots(state, now, horizon = 1) {
  if (!state.reminders.enabled || !state.joined || state.appointment.attended || state.safety?.pending || ['urgent', 'unknown'].includes(state.safety?.level)) return [];
  const local = localParts(now, state.reminders.timeZone);
  const slots = [];
  for (let n = 0; n <= horizon; n++) {
    const date = addDays(local.date, n);
    for (const time of state.reminders.times) {
      const at = zonedInstant(date, time, state.reminders.timeZone);
      if (at === null || at <= Date.parse(state.reminders.activatedAt)) continue;
      const task = currentTask(state, new Date(at).toISOString());
      if (!['assessment', 'diary'].includes(task.kind)) continue;
      const key = `${date}|${time}|${task.id}`;
      slots.push({ key, at: new Date(at).toISOString(), date, time, task: task.title, taskId: task.id });
    }
  }
  return slots;
}
export function deliverReminders(state, now) {
  let changed = false;
  const nowMs = Date.parse(now);
  for (const slot of reminderSlots(state, now, 0)) {
    if (nowMs < Date.parse(slot.at) || nowMs - Date.parse(slot.at) >= 90000 || state.deliveries.some(d => d.key === slot.key)) continue;
    const text = `Пора уделить себе пару минут: ${slot.task.toLowerCase()}. Можно ответить здесь или открыть Mini App. После завершения задания напоминаний сегодня больше не будет.`;
    state.deliveries.push({ ...slot, deliveredAt: now, transport: 'local-simulator' });
    pushMessage(state, 'bot', text, now, { reminder: true });
    changed = true;
  }
  return changed;
}
export function diaryStats(state, now) {
  const day = monitoringDay(state, now);
  const records = state.diary.filter(e => e.day >= 0 && e.day <= Math.min(day, 14));
  const baselineRecorded = records.some(e => e.day === 0);
  const expected = Math.min(day, 14) + Number(baselineRecorded);
  const mean = (entries, field) => {
    const values = entries.map(e => e[field]).filter(v => typeof v === 'number');
    return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null;
  };
  const recent = records.slice(-3), first = records.slice(0, 3);
  return { expected, baselineRecorded, recorded: records.length, missing: Math.max(0, expected - records.length), mood: mean(records, 'mood'), anxiety: mean(records, 'anxiety'), sleep: mean(records, 'sleep'), sleepCount: records.filter(e => typeof e.sleep === 'number').length,
    comparison: records.length >= 6 ? { firstMood: mean(first, 'mood'), recentMood: mean(recent, 'mood'), firstAnxiety: mean(first, 'anxiety'), recentAnxiety: mean(recent, 'anxiety'), firstDates: first.map(e => e.date), recentDates: recent.map(e => e.date) } : null };
}
export function snapshot(state, wallNow = Date.now()) {
  const now = demoNow(state, wallNow);
  const slots = reminderSlots(state, now).filter(s => s.at > now && !state.deliveries.some(d => d.key === s.key));
  return { ...state, now, today: todayOf(state, now), day: monitoringDay(state, now), task: currentTask(state, now), flow: flowView(state, now), diaryAvailable: diaryAvailable(state, now), recommendation: patientRecommendation(state), stats: diaryStats(state, now), nextReminder: slots[0] || null };
}
function parseText(question, text) {
  const trimmed = text.trim();
  if (question.type === 'text') return trimmed === 'Пропустить' ? '' : trimmed;
  if (question.type === 'sleep') return trimmed === 'Пропустить' ? null : Number(trimmed.replace(',', '.'));
  const opt = question.options.find(o => o.label.toLocaleLowerCase('ru') === trimmed.toLocaleLowerCase('ru') || `${o.value} · ${o.label}`.toLocaleLowerCase('ru') === trimmed.toLocaleLowerCase('ru') || typeof o.value === 'number' && String(o.value) === trimmed);
  if (!opt) throw new Error('Не получилось сопоставить ответ. Нажмите кнопку ниже или укажите её полный текст. Числа 0–3 соответствуют баллам ответа.');
  return opt.value;
}
export function botKeyboard(state, now = demoNow(state)) {
  if (!state.joined) return [['Мне 18+, начать']];
  if (state.safety?.needsGuidance && !state.safety.pending) return [['Нужна помощь'], ['Вернуться к заданию']];
  if (state.active && !state.safety?.pending && Date.parse(now) - Date.parse(state.active.startedAt) > 86400000) return [['Начать заново'], ['Открыть Mini App'], ['Нужна помощь']];
  if (state.botPaused && !state.safety?.pending) return [['Продолжить'], ['Результаты', 'Открыть Mini App'], ['Нужна помощь']];
  const flow = flowView(state, now);
  if (flow) {
    const q = flow.question;
    if (q.options) {
      const labels = q.options.map(o => typeof o.value === 'number' && flow.kind === 'assessment' && q.kind ? `${o.value} · ${o.label}` : o.label);
      const rows = q.type === 'number' ? labels.reduce((out, label, i) => { if (i % 4 === 0) out.push([]); out.at(-1).push(label); return out; }, []) : labels.map(label => [label]);
      return [...rows, ...(flow.kind === 'safety' ? [] : [['Назад', 'Пауза']]), ['Нужна помощь']];
    }
    return [...(q.optional ? [['Пропустить']] : []), ['Назад', 'Пауза'], ['Нужна помощь']];
  }
  return [['Продолжить'], ['Результаты', 'Открыть Mini App'], ['Нужна помощь']];
}
function botInput(state, now, text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Введите сообщение до 1000 символов');
  const t = text.trim();
  if (t === '/start') { pushMessage(state, 'bot', state.safety?.needsGuidance ? URGENT_TEXT : state.joined ? 'Можно продолжить задание здесь или посмотреть данные в Mini App.' : 'Для демонстрации используйте вымышленные данные. Подтвердите возраст кнопкой ниже.', now); if (state.joined && !state.safety?.needsGuidance) askCurrent(state, now); return; }
  if (t === 'Мне 18+, начать' && !state.joined) { state.joined = true; startTask(state, now); return; }
  if (!state.joined) throw new Error('Нажмите «Мне 18+, начать»');
  if (t === 'Начать заново' || t === '/restart') {
    if (state.safety?.pending || state.safety?.needsGuidance) throw new Error('Сначала откройте памятку помощи');
    state.active = null; state.diaryDraft = null; state.botPaused = false; startTask(state, now); return;
  }
  if (t === 'Нужна помощь' || t === '/help') { state.safety = { level: state.safety?.level ?? null, pending: true, source: 'Обращение пользователя', at: now }; askCurrent(state, now); return; }
  if (t === 'Вернуться к заданию') { state.safety.needsGuidance = false; pushMessage(state, 'bot', 'Памятка остаётся в истории. Обращение за помощью не отправлено автоматически. При опасности сейчас не ждите окончания анкет.', now); askCurrent(state, now); return; }
  if (t === 'Результаты') {
    const last = state.assessments.at(-1);
    if (!last) pushMessage(state, 'bot', 'Готового результата пока нет. Ответы сохраняются, можно продолжить с текущего вопроса.', now);
    else { const s = scoreAssessment(last); pushMessage(state, 'bot', `PHQ-9: ${s.phq.score}/27. GAD-7: ${s.gad.score}/21. ${patientRecommendation(state).text}`, now); }
    return;
  }
  if (t === 'Открыть Mini App') { pushMessage(state, 'bot', 'Mini App доступен в соседнем интерфейсе: /patient/. Здесь и там одна история.', now); return; }
  if (t === 'Пауза') { state.botPaused = true; pushMessage(state, 'bot', 'Ответы сохранены. Можно вернуться позже. Чтобы увидеть текущий вопрос, нажмите «Продолжить».', now); return; }
  if (t === 'Назад') { goBack(state, now); return; }
  if (t === 'Продолжить' || t === 'Начать скрининг' || t === 'Сегодняшняя запись') {
    if (state.safety?.needsGuidance) { pushMessage(state, 'bot', URGENT_TEXT, now); return; }
    state.botPaused = false;
    if (flowView(state, now)) askCurrent(state, now);
    else if (['assessment', 'diary'].includes(currentTask(state, now).kind)) startTask(state, now);
    else pushMessage(state, 'bot', 'На сегодня всё заполнено. Напоминания сегодня остановлены. Результаты и следующий шаг доступны в Mini App.', now);
    return;
  }
  const flow = flowView(state, now);
  if (!flow) throw new Error('Нажмите «Продолжить», чтобы начать сегодняшнее задание');
  try { answer(state, now, parseText(flow.question, t), flow.question.id); }
  catch (error) { pushMessage(state, 'bot', error.message, now); }
}
function goBack(state, now) {
  if (state.safety?.pending) throw new Error('Сначала ответьте на отдельный вопрос о безопасности или откройте помощь');
  if (state.safety?.needsGuidance) throw new Error('Обычный опрос поставлен на паузу. Сначала откройте памятку помощи.');
  const active = state.active || state.diaryDraft;
  if (!active) throw new Error('Нет текущего задания');
  active.cursor = Math.max(0, active.cursor - 1);
  askCurrent(state, now);
}
export function applyAction(state, action, wallNow = Date.now()) {
  const now = demoNow(state, wallNow);
  switch (action.type) {
    case 'join': if (action.adult !== true) throw new Error('Этот сценарий предназначен для взрослых 18+'); state.joined = true; break;
    case 'start': startTask(state, now, action.kind); break;
    case 'answer': answer(state, now, action.value, action.questionId); break;
    case 'back': goBack(state, now); break;
    case 'restart': state.active = null; state.diaryDraft = null; startTask(state, now); break;
    case 'bot': botInput(state, now, action.text); break;
    case 'help': state.safety = { level: state.safety?.level ?? null, pending: true, source: 'Обращение пользователя', at: now }; askCurrent(state, now); break;
    case 'resumeAfterHelp': if (state.safety) state.safety.needsGuidance = false; break;
    case 'reminders': {
      const settings = validateReminders(action.settings);
      state.reminders = { ...settings, activatedAt: now };
      break;
    }
    case 'appointment': {
      const { date, time, question } = action;
      const parsed = typeof date === 'string' && date ? Date.parse(`${date}T12:00:00Z`) : NaN;
      if (typeof date !== 'string' || date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) || typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || typeof question !== 'string' || question.length > 1000) throw new Error('Проверьте дату, время и текст вопроса');
      state.appointment = { ...state.appointment, date, time, question: question.trim() }; break;
    }
    case 'attended': state.appointment.attended = true; state.reminders.enabled = false; break;
    case 'advance': {
      if (!Number.isInteger(action.days) || action.days < 1 || action.days > 14) throw new Error('Можно переместить демонстрацию на 1–14 дней вперёд');
      if (state.active || state.diaryDraft) throw new Error('Закончите текущее задание перед сменой дня');
      state.clockOffsetMs += action.days * 86400000;
      break;
    }
    case 'simulateReminder': {
      const next = reminderSlots(state, now, 2).find(s => s.at > now && !state.deliveries.some(d => d.key === s.key));
      if (!next) throw new Error('Ближайшего напоминания нет: включите расписание или завершите сегодняшний день');
      state.clockOffsetMs += Date.parse(next.at) - Date.parse(now);
      deliverReminders(state, demoNow(state, wallNow));
      break;
    }
    default: throw new Error('Неизвестное действие');
  }
  state.revision++;
  return state;
}
export function createHistory(wallNow = Date.now()) {
  const state = createPatient(wallNow);
  state.joined = true;
  const now = new Date(wallNow).toISOString();
  const date = todayOf(state, now), anchor = addDays(date, -13);
  state.assessments = [{ id: randomUUID(), mode: 'baseline', version: FORM_VERSION, date: anchor, startedAt: `${anchor}T09:00:00Z`, completedAt: `${anchor}T09:07:00Z`, window: { start: addDays(anchor, -13), end: anchor, days: 14 }, answers: [2, 2, 2, 2, 1, 1, 2, 0, 0, 2, 2, 2, 1, 1, 1, 1], context: { function: 2, duration: 'От месяца до полугода', goal: 'Хочу лучше спать и снова спокойно работать' } }];
  const values = [[1, 3, 8, 5.5, 2], [2, 4, 7, 6, 2], [3, 3, 8, 5, 2], [5, 5, 6, 6.5, 1], [6, 4, 7, null, 2], [7, 5, 6, 7, 1], [9, 6, 5, 7, 1], [10, 5, 6, 6.5, 1], [11, 6, 5, 7.5, 1], [12, 7, 4, 7, 1]];
  state.diary = values.map(([day, mood, anxiety, sleep, fn]) => ({ id: randomUUID(), day, date: addDays(anchor, day), mood, anxiety, sleep, function: fn, change: day >= 7 ? 'Стало лучше' : undefined, note: day === 3 ? 'Напряжённый день на работе, поздно лёг.' : day === 9 ? 'Погулял вечером. Заснуть было легче.' : '', recordedAt: `${addDays(anchor, day)}T17:00:00Z`, retrospective: false, source: 'synthetic-example' }));
  state.completedDates = [anchor, ...state.diary.map(e => e.date)];
  state.appointment = { date: addDays(date, 2), time: '15:00', question: 'Как связаны плохой сон и тревога? Какие варианты помощи мне подойдут?', attended: false };
  pushMessage(state, 'bot', 'Загружен вымышленный пример: исходные анкеты и 10 записей за 13 дней. Сегодняшняя запись ещё не заполнена. Даты, приём и все показатели придуманы для демонстрации.', now);
  return state;
}

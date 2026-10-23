import { voiceText } from '../public/shared/voice-model.js';
import { randomUUID } from 'node:crypto';
import { createPatient, diaryStats, snapshot } from './patient.mjs';
import { addDays, daysBetween, localParts } from './time.mjs';
import { FORM_VERSION, FORMS, FREQUENCY, FUNCTION_LABELS, scoreAssessment, scoreScale } from '../public/shared/clinical.js';
import { buildPatientSupport } from './insights.mjs';
import { therapySupport } from './therapy-support.mjs';

export const INTAKE_FIELDS = [
  ['onset', 'Начало и течение'], ['functionExample', 'Что стало трудно делать'],
  ['previousEpisodes', 'Предыдущие эпизоды'], ['previousTreatment', 'Предыдущее лечение'],
  ['conditions', 'Соматические заболевания'], ['substances', 'Алкоголь и другие вещества'],
  ['activation', 'Необычная активность и снижение потребности во сне'], ['sleepQuality', 'Качество сна и отдых утром'],
];
const dateText = date => date ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`)) : 'нет данных';
const mean = (rows, field) => { const a = rows.map(r => r[field]).filter(Number.isFinite); return a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length * 10) / 10 : null; };
const maximumDate = values => values.filter(Boolean).sort().at(-1) || null;
export const episodeId = state => state.episodeId || state.assessments[0]?.id || state.createdAt;
const reviewKey = (id, state) => `${id}:${episodeId(state)}`;
export function emptyReview() { return { revision: 0, draft: null, confirmed: null, viewedAt: null, history: [] }; }
function assessment(date, mode, phq, gad, fn, goal) {
  return { id: randomUUID(), mode, version: FORM_VERSION, date, startedAt: `${date}T08:00:00Z`, completedAt: `${date}T08:07:00Z`, window: { start: addDays(date, -13), end: date, days: 14 }, answers: [...phq, ...gad], context: { function: fn, duration: 'От месяца до полугода', goal }, source: 'synthetic-self-report' };
}
function fixture({ id, name, age, days, baseline, repeat, recorded, sparse = false, worsening = false, safety = false, incomplete = false, intake = {}, medications = [], events = [], adherence = null }, wallNow) {
  const state = createPatient(wallNow); state.joined = true;
  const today = snapshot(state, wallNow).today, anchor = addDays(today, -days);
  const goal = worsening ? 'Снова справляться с работой и спать без частых пробуждений' : 'Спокойнее работать и высыпаться';
  if (!incomplete) state.assessments.push(assessment(anchor, 'baseline', baseline[0], baseline[1], worsening || safety ? 2 : 1, goal));
  else state.active = { id: randomUUID(), mode: 'baseline', date: today, startedAt: `${today}T07:00:00Z`, cursor: 8, values: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`phq-${i}`, i % 2])), version: FORM_VERSION };
  if (repeat) state.assessments.push(assessment(today, 'repeat', repeat[0], repeat[1], worsening ? 3 : 1, goal));
  state.diary = (recorded || []).map((day, i) => ({
    id: randomUUID(), date: addDays(anchor, day), day,
    mood: worsening ? Math.max(2, 6 - Math.floor(i / 3)) : Math.min(8, 3 + Math.floor(i / 3)),
    anxiety: worsening ? Math.min(9, 4 + Math.floor(i / 3)) : Math.max(2, 8 - Math.floor(i / 3)),
    sleep: i % 5 === 3 ? null : worsening ? 5 + (i % 2) / 2 : 5.5 + Math.min(2, Math.floor(i / 3) / 2),
    function: worsening ? (i > 5 ? 3 : 2) : (i < 4 ? 2 : 1),
    change: day >= 1 ? worsening ? 'Стало хуже' : i < 3 ? 'Примерно так же' : 'Стало лучше' : undefined,
    note: day === 3 ? 'Много задач на работе, позже обычного лёг спать.' : day === 9 ? 'Было легче выйти на прогулку.' : '',
    source: 'synthetic-self-report', recordedAt: addDays(anchor, day) === today ? new Date(wallNow).toISOString() : `${addDays(anchor, day)}T17:00:00Z`, retrospective: sparse && i === 0,
  }));
  if (safety) {
    state.safety = { source: 'PHQ-9, пункт 9', level: 'contact', pending: false, at: `${anchor}T08:06:00Z` };
    state.safetyEvents.push({ source: 'PHQ-9, пункт 9', level: 'contact', at: `${anchor}T08:06:00Z` });
  }
  state.appointment = { date: addDays(today, id === 'olga' ? 2 : id === 'anna' ? 0 : 1), time: id === 'anna' ? '15:00' : '12:30', question: worsening ? 'Что делать, если стало труднее справляться с делами?' : 'Как связаны тревога и плохой сон?', attended: false };
  return { id, identity: { name, age, code: `ТС-${{ anna: '1024', mikhail: '1031', olga: '1042', egor: '1056', irina: '1063' }[id]}`, synthetic: true }, state,
    referral: { reason: safety ? 'Уточнить ответ на пункт 9 PHQ-9 и выраженные затруднения' : incomplete ? 'Первичная оценка ещё не завершена' : 'Оценить тревожные и депрессивные симптомы, нарушения сна и влияние на дела', by: 'ВОП · вымышленное направление', at: `${anchor}T07:30:00Z`, confirmed: false },
    intake, medications, events: events.map(e => ({ id: randomUUID(), ...e, date: addDays(anchor, e.day), source: 'Со слов пациента · пример' })), adherence,
  };
}
export function createClinicianWorkspace(wallNow = Date.now()) {
  const common = { onset: 'Изменения начались около двух месяцев назад, заметнее в рабочие дни.', functionExample: 'Стало труднее сосредоточиться на обычных задачах и общаться после работы.' };
  return { schema: 1, revision: 0, createdAt: new Date(wallNow).toISOString(), reviews: {}, audit: [], patients: [
    fixture({ id: 'anna', name: 'Анна Петрова', age: 29, days: 14, baseline: [[1, 2, 2, 2, 1, 1, 2, 1, 0], [2, 2, 2, 1, 1, 1, 1]], repeat: [[1, 1, 1, 1, 1, 0, 1, 1, 0], [1, 1, 1, 1, 1, 1, 0]], recorded: [1, 2, 3, 5, 6, 7, 9, 10, 11, 12, 14], intake: { ...common, previousEpisodes: 'Ранее похожего не отмечала.', previousTreatment: 'Психиатрическое лечение ранее не проходила.' } }, wallNow),
    fixture({ id: 'mikhail', name: 'Михаил Орлов', age: 34, days: 5, baseline: [[2, 3, 3, 2, 1, 2, 2, 2, 1], [3, 2, 3, 2, 2, 2, 2]], recorded: [1, 2, 4], safety: true, intake: { ...common, functionExample: 'Пропустил рабочую встречу, сложно заниматься бытовыми делами.' } }, wallNow),
    fixture({ id: 'olga', name: 'Ольга Соколова', age: 41, days: 13, baseline: [[1, 1, 2, 1, 1, 0, 1, 0, 0], [1, 1, 1, 1, 1, 0, 1]], recorded: [1, 3, 5], sparse: true, intake: { onset: 'Срок начала пока не уточнён.' } }, wallNow),
    fixture({ id: 'egor', name: 'Егор Волков', age: 23, days: 0, incomplete: true, recorded: [], intake: {} }, wallNow),
    fixture({ id: 'irina', name: 'Ирина Морозова', age: 52, days: 14, baseline: [[1, 2, 2, 2, 1, 1, 2, 1, 0], [1, 1, 1, 1, 2, 1, 1]], repeat: [[2, 3, 2, 2, 2, 2, 2, 2, 0], [2, 2, 2, 2, 1, 2, 1]], recorded: [1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 13, 14], worsening: true,
      intake: { ...common, conditions: 'Гипотиреоз со слов пациента; медицинские документы и результаты обследований не представлены.', sleepQuality: 'Частые пробуждения, утром не чувствует отдыха.' },
      medications: [{ name: 'Авиандр', regimen: 'Доза, кратность, дата начала и назначивший врач не уточнены', verified: false }, { name: 'БАД, название не помнит', regimen: 'Состав и режим неизвестны', verified: false }],
      adherence: { label: 'Условное назначение №1 из демонстрационного плана', unit: 'плановых отметок', statuses: ['taken', 'taken', 'unknown', 'missed', 'taken', 'taken', 'unknown', 'taken', 'missed', 'taken', 'unknown', 'taken', 'unknown', 'taken'], reason: 'Часть пропусков связывает с неудобным временем. Схема и лекарственный препарат в этом условном примере не заданы.' },
      events: [{ day: 8, title: 'Тошнота', severity: 'Умеренно мешает', impact: 'Мешало завтракать', note: 'Пациент связывает по времени с началом нового средства. Причинная связь не установлена.' }, { day: 12, title: 'Дневная сонливость', severity: 'Немного мешает', impact: 'Сложнее читать рабочие документы', note: 'Нужно уточнить время появления, другие лекарства и режим сна.' }],
    }, wallNow),
  ] };
}
function liveCase(state) {
  return { id: 'live', identity: { name: 'Пациент из миниаппа', age: null, code: 'ТС-LOCAL', synthetic: true }, state,
    referral: { reason: 'Связанный тестовый профиль этого браузера. Основание направления ВОП отдельно не внесено.', by: 'Тестовая привязка', at: state.createdAt, confirmed: false }, intake: {}, medications: [], events: [], adherence: null };
}
function evaluated(a) {
  return { ...a, scores: scoreAssessment(a), answered: a.answers.filter(v => Number.isInteger(v)).length };
}
function pendingAssessment(state) {
  if (!state.active) return null;
  const values = state.active.values;
  return { id: state.active.id, startedAt: state.active.startedAt, date: state.active.date, mode: state.active.mode, version: state.active.version, draft: true,
    answers: [...Array.from({ length: 9 }, (_, i) => values[`phq-${i}`] ?? null), ...Array.from({ length: 7 }, (_, i) => values[`gad-${i}`] ?? null)],
    scores: Object.fromEntries([['phq', 9], ['gad', 7]].map(([kind, size]) => { const a = Array.from({ length: size }, (_, i) => values[`${kind}-${i}`] ?? null); return [kind, { ...scoreScale(kind, a), answered: a.filter(Number.isInteger).length }]; })) };
}
function adherenceStats(plan) {
  if (!plan) return null;
  return { label: plan.label, unit: plan.unit, reason: plan.reason, planned: plan.statuses.length, taken: plan.statuses.filter(v => v === 'taken').length, missed: plan.statuses.filter(v => v === 'missed').length, unknown: plan.statuses.filter(v => v === 'unknown').length };
}
function weeklyRows(state, day) {
  return [[1, 7], [8, 14]].map(([start, end]) => { const rows = state.diary.filter(e => e.day >= start && e.day <= Math.min(end, day)); return { start, end, expected: Math.max(0, Math.min(end, day) - start + 1), recorded: rows.length, mood: mean(rows, 'mood'), anxiety: mean(rows, 'anxiety'), sleep: mean(rows, 'sleep'), sleepCount: rows.filter(r => Number.isFinite(r.sleep)).length, functionDifficult: rows.filter(r => r.function >= 2).length }; });
}
export function clinicianPatient(workspace, id, liveState, wallNow = Date.now(), connectedEntry = null) {
  const entry = connectedEntry?.id === id ? connectedEntry : id === 'live' ? liveCase(liveState) : workspace.patients.find(p => p.id === id);
  if (!entry) return null;
  const state = entry.state, snap = snapshot(state, wallNow), assessments = state.assessments.map(evaluated), last = assessments.at(-1), first = assessments[0], draft = pendingAssessment(state);
  const review = workspace.reviews[reviewKey(id, state)] || emptyReview();
  const voiceKey = `${id}:${episodeId(state)}`, voiceNotes = [...(state.voiceNotes || []), ...(workspace.voices?.[voiceKey] || [])];
  const latestAt = maximumDate([...assessments.map(a => a.completedAt), ...state.diary.map(e => e.recordedAt), ...(state.treatmentCheckins || []).map(c => c.at), ...state.safetyEvents.map(e => e.at), state.healthContext?.at, ...voiceNotes.filter(n => !n.archivedAt).map(n => n.at), state.active?.startedAt]);
  const daysAgo = latestAt ? Math.max(0, daysBetween(localParts(latestAt, state.reminders.timeZone).date, snap.today)) : null;
  const phq9 = last?.answers[8] ?? state.active?.values['phq-8'] ?? null;
  const safetyEvents = [...state.safetyEvents];
  const safety = { phq9, events: safetyEvents, needsClarification: assessments.some(a => a.answers[8] > 0) || state.active?.values['phq-8'] > 0 || safetyEvents.length > 0, clinicianNote: review.confirmed?.safetyNote || '', currentAssessment: 'Клиническая оценка безопасности не внесена' };
  if (review.confirmed?.safetyNote) safety.currentAssessment = 'Есть запись врача; исходные ответы и история сохранены';
  const health = state.healthContext || {};
  const reportedIntake = { ...entry.intake, ...Object.fromEntries(['conditions', 'previousTreatment', 'functionExample'].filter(k => health[k]).map(k => [k, health[k]])), ...(health.activation && health.activation !== 'unknown' ? { activation: health.activation === 'yes' ? 'Отмечены периоды необычной активности и меньшей потребности во сне. Требует уточнения.' : 'По дополнительному вопросу пациент не отметил таких периодов; это не исключение расстройства.' } : {}) };
  const medications = health.medicines ? [{ name: health.medicines, regimen: 'Список внесён пациентом; состав, режим и назначивший врач требуют сверки', verified: false }] : entry.medications;
  const checks = state.treatmentCheckins || [];
  const adherence = checks.length ? { label: 'Выполнение согласованного плана со слов', unit: 'дневных отметок', planned: checks.length, taken: checks.filter(c => c.adherence === 'taken').length, missed: checks.filter(c => c.adherence === 'missed').length, unknown: checks.filter(c => ['unknown', 'not-prescribed'].includes(c.adherence)).length, reason: `Частично выполнено: ${checks.filter(c => c.adherence === 'partly').length}. Число запланированных доз не известно; процент приверженности не вычисляется.` } : adherenceStats(entry.adherence);
  const events = [...entry.events, ...checks.filter(c => !['none', 'unknown'].includes(c.effect) || c.changes).map(c => ({ id: c.id, date: c.date, title: ({ drowsy: 'Сонливость', dizzy: 'Головокружение', other: 'Другое явление' })[c.effect] || 'Изменение принимаемых средств', severity: `Влияние на дела ${c.impact}/3`, impact: c.note || 'Дополнительного описания нет', note: c.changes ? 'Новые средства / изменения со слов: ' + c.changes : 'Причинная связь с лечением не установлена.', source: 'Дополнительная дневная отметка со слов пациента' }))];
  const intake = INTAKE_FIELDS.map(([key, label]) => ({ key, label, value: reportedIntake[key] || null, source: reportedIntake[key] ? 'Со слов пациента · не подтверждено врачом' : 'Не собиралось', at: reportedIntake[key] ? health.at || first?.completedAt || state.createdAt : null }));
  const unknown = intake.filter(x => !x.value).map(x => x.label);
  if (!medications.length) unknown.push('Лекарства и БАДы: перечень не внесён');
  if (!adherence) unknown.push('Выполнение назначений: не собиралось');
  if (!events.length) unknown.push('Новые явления: структурированный опрос не проводился');
  const observationDays = Math.min(snap.day, 14);
  const days = Array.from({ length: 15 }, (_, day) => ({ day, date: first ? addDays(first.date, day) : null, future: day > observationDays, entry: state.diary.find(e => e.day === day) || null })).filter(r => r.day !== 0 || snap.stats.baselineRecorded);
  const sourceRevision = `${episodeId(state)}:${state.revision}:${snap.today}${workspace.voiceRevisions?.[voiceKey] ? ":v" + workspace.voiceRevisions[voiceKey] : ""}`;
  const delta = Object.fromEntries(['phq', 'gad'].map(kind => [kind, assessments.length > 1 && first.scores[kind].complete && last.scores[kind].complete ? last.scores[kind].score - first.scores[kind].score : null]));
  const needs = [];
  if (safety.needsClarification) needs.push({ code: 'safety-question', tone: 'red', text: 'Есть отдельные ответы о безопасности — уточнить при контакте', source: phq9 > 0 ? 'Пункт 9 PHQ-9' : 'История обращений' });
  if (draft) needs.push({ code: 'unfinished', tone: 'neutral', text: 'Есть незавершённая анкета; пропуски не равны нулю', source: 'Сохранённый черновик' });
  if (daysAgo !== null && daysAgo >= 3) needs.push({ code: 'stale', tone: 'neutral', text: `Последним данным ${daysAgo} дн.; текущее состояние неизвестно`, source: 'Дата последней записи' });
  if (snap.stats.missing) needs.push({ code: 'missing-days', tone: 'neutral', text: `${snap.stats.missing} дней без дневника`, source: 'Полнота данных' });
  if (state.diary.at(-1)?.change === 'Стало хуже') needs.push({ code: 'reported-worse', tone: 'red', text: 'В последней записи пациент отметил ухудшение', source: state.diary.at(-1).date });
  const carePlan = patientCarePlan(workspace, state, id);
  const appointment = { ...state.appointment, reportedDate: state.appointment.date, reportedTime: state.appointment.time, confirmed: Boolean(carePlan?.nextDate), source: carePlan?.nextDate ? 'Дата из подтверждённого демоплана врача; запись в клинику не создана' : 'Дата со слов пациента; клиникой не подтверждена' };
  if (carePlan?.nextDate) Object.assign(appointment, { date: carePlan.nextDate, time: carePlan.nextTime, timeZone: carePlan.timeZone });
  const p = { id, identity: entry.identity, live: id === 'live' || Boolean(connectedEntry), connected: Boolean(connectedEntry), episodeId: episodeId(state), today: snap.today, day: snap.day, stage: state.appointment.attended ? 'Приём отмечен пациентом' : assessments.length > 1 ? 'Повторные анкеты готовы' : draft ? 'Анкета не завершена' : first ? 'Наблюдение до приёма' : 'Исходных анкет пока нет', referral: entry.referral, appointment, assessments, draft, delta, diary: state.diary, days, stats: snap.stats, weeks: weeklyRows(state, snap.day), safety, intake, medications, adherence, events, treatmentCheckins: checks, healthContext: health, voiceNotes, unknown, needs, review, latestAt, daysAgo, sourceRevision, timeZone: state.reminders.timeZone, dataChangedSinceReview: Boolean(review.confirmed && review.confirmed.sourceRevision !== sourceRevision), context: last?.context || null };
  p.support = buildPatientSupport(snap, carePlan);
  for (const s of p.support.signals.filter(s => ['activation', 'new-effect', 'contact-due'].includes(s.id))) p.needs.push({ code: 'report-' + s.id, tone: s.tone, text: s.title, source: s.source.date });
  p.therapy = therapySupport(workspace.therapyContexts?.[`${id}:${p.episodeId}`], p);
  p.summary = clinicianSummary(p) + `\n\nЛЕКАРСТВЕННАЯ СПРАВКА · ТОЛЬКО ВРАЧУ\n${p.therapy.title}. ${p.therapy.explanation}\n${p.therapy.medicine.name} / ${p.therapy.medicine.substance}. ${p.therapy.medicine.guideline}\nПроверка: ${p.therapy.context.at || 'не проводилась'}; ревизия ${p.therapy.context.revision}.\nОбоснование врача: ${p.therapy.context.evidence || 'не внесено'}.\n${p.therapy.bounds}`;
  if (voiceNotes.some(n => !n.archivedAt)) p.needs.push({ code: 'voice-note', tone: 'neutral', text: 'Есть проверенная расшифровка; уточнить клинический смысл', source: 'Голосовые заметки и беседы' });
  if (voiceNotes.some(n => !n.archivedAt)) p.summary += '\n\nРАСШИФРОВКИ · КЛИНИЧЕСКИЙ СМЫСЛ НЕ ПОДТВЕРЖДЁН\n' + voiceNotes.filter(n => !n.archivedAt).map(voiceText).join('\n\n');
  p.activity = workspace.audit.filter(e => e.patientId === id).slice(-20).reverse();
  return p;
}
export function clinicianList(workspace, liveState, wallNow = Date.now()) {
  return ['live', ...workspace.patients.map(p => p.id)].map(id => clinicianListItem(clinicianPatient(workspace, id, liveState, wallNow)));
}
export function clinicianListItem(p) {
    const { id } = p, last = p.assessments.at(-1);
    return { id, identity: p.identity, live: p.live, stage: p.stage, today: p.today, day: p.day, lastScores: last?.scores || null, lastAssessmentDate: last?.date || null, draft: p.draft ? { phq: p.draft.scores.phq.answered, gad: p.draft.scores.gad.answered } : null, delta: p.delta, stats: p.stats, appointment: p.appointment, latestAt: p.latestAt, daysAgo: p.daysAgo, needs: p.needs, reviewStatus: p.review.confirmed ? p.dataChangedSinceReview ? 'Новые данные после просмотра' : 'План подтверждён в демо' : p.review.draft ? 'Черновик врача' : p.review.viewedAt ? 'Данные просмотрены' : 'Не просмотрено', reviewRevision: p.review.revision, sourceRevision: p.sourceRevision };
}
export function clinicianSummary(p) {
  const first = p.assessments[0], last = p.assessments.at(-1);
  const scoreLine = a => `${dateText(a.date)} · ${a.mode === 'baseline' ? 'исходно' : 'повтор'}: PHQ-9 ${a.scores.phq.score}/27; GAD-7 ${a.scores.gad.score}/21. Окно ${dateText(a.window.start)} — ${dateText(a.window.end)}.`;
  const v = value => value === null ? 'нет данных' : String(value).replace('.', ',');
  return `ТРЕКЕР СЕЧЕНОВКА · СВОДКА К ПРИЁМУ\n${p.identity.name}, ${p.identity.age || '18+'} ${p.identity.age ? 'лет' : ''} · ${p.identity.code}\nВымышленные данные. Самоотчёт отдельно от записи врача. Сформировано ${dateText(p.today)}.\n\nПРИЧИНА ОБРАЩЕНИЯ\n${p.referral.reason}\nИсточник: ${p.referral.by}; ${dateText(p.referral.at)}. Подтверждение направления врачом: ${p.referral.confirmed ? 'внесено' : 'не внесено'}.\nЛичная цель: ${p.context?.goal || 'не указана'}.\nДлительность: ${p.context?.duration || 'не уточнена'}.\n\nАНКЕТЫ · СО СЛОВ ПАЦИЕНТА\n${p.assessments.length ? p.assessments.map(scoreLine).join('\n') : 'Завершённых анкет нет.'}\n${p.draft ? `Есть незавершённый ${p.draft.mode === 'repeat' ? 'повтор' : 'исходный скрининг'}: PHQ ${p.draft.scores.phq.answered}/9 ответов, GAD ${p.draft.scores.gad.answered}/7. Это черновик, пропуски не считаются нулём.\n` : ''}${first && last !== first ? `Изменение от исходной точки: PHQ-9 ${p.delta.phq > 0 ? '+' : ''}${p.delta.phq}; GAD-7 ${p.delta.gad > 0 ? '+' : ''}${p.delta.gad}.\n` : ''}Баллы описывают симптомы за две недели; диагноз и эффект лечения не установлены.\n\nОБЫЧНЫЕ ДЕЛА И ДНЕВНИК\nПо последним анкетам: ${p.context ? FUNCTION_LABELS[p.context.function] : 'не оценено'}.\n${p.stats.recorded} из ${p.stats.expected} дней с записями, ${p.stats.missing} без данных.${p.stats.baselineRecorded ? ' Включена дополнительная запись дня 0.' : ''}\nНастроение ${v(p.stats.mood)}/10; тревога ${v(p.stats.anxiety)}/10 в среднем. Сон ${v(p.stats.sleep)} ч, ${p.stats.sleepCount} числовых значений.\nПоследние данные: ${p.latestAt ? dateText(p.latestAt) : 'не поступали'}.\n${p.diary.filter(e => e.note).map(e => `${dateText(e.date)}${e.retrospective ? ' (внесено позже)' : ''}: ${e.note}`).join('\n') || 'Заметок нет.'}\n\nВОПРОСЫ БЕЗОПАСНОСТИ\nПоследний пункт 9 PHQ-9: ${p.safety.phq9 === null ? 'нет ответа' : p.safety.phq9 + '/3'}.\n${p.safety.events.map(e => `${dateText(e.at)}: ${e.source}; ${e.level === 'contact' ? 'сейчас нет' : e.level === 'urgent' ? 'да / не уверен(а)' : 'не хочу отвечать'}.`).join('\n') || 'Отдельных обращений не зафиксировано; это не подтверждение отсутствия риска.'}\n${p.safety.currentAssessment}.\n\nКОНТЕКСТ · САМООТЧЁТ\n${p.intake.map(f => `${f.label}: ${f.value || 'не собиралось'}.`).join('\n')}\n\nПРИНИМАЕМЫЕ СРЕДСТВА И ВЫПОЛНЕНИЕ ПЛАНА\n${p.medications.map(m => `${m.name}: ${m.regimen}. Не сверено врачом.`).join('\n') || 'Список лекарств и БАДов не внесён.'}\n${p.adherence ? `${p.adherence.label}: из ${p.adherence.planned} ${p.adherence.unit} — ${p.adherence.taken} выполнено со слов, ${p.adherence.missed} пропущено, ${p.adherence.unknown} без данных. ${p.adherence.reason}` : 'Выполнение назначений не собиралось; доля приверженности не вычислялась.'}\n\nНОВЫЕ ЯВЛЕНИЯ\n${p.events.map(e => `${dateText(e.date)}: ${e.title}; ${e.severity}; ${e.impact}. ${e.note}`).join('\n') || 'Структурированный опрос новых явлений не проводился.'}\nПричинная связь с лечением по этим данным не установлена.\n\nЧТО УТОЧНИТЬ\n${p.unknown.map(x => '• ' + x).join('\n') || 'Уточнить актуальность сведений при беседе.'}\nВопрос пациента: ${p.appointment.question || 'не указан'}.\n\nЗАПИСЬ ВРАЧА\n${p.review.confirmed ? `${p.review.confirmed.clinicalNote}\nЦель: ${p.review.confirmed.goal}\nПлан: ${p.review.confirmed.plan}\nОтслеживать: ${p.review.confirmed.watch}\nОбратиться раньше: ${p.review.confirmed.earlyContact}\nКонтроль: ${p.review.confirmed.nextDate}, ${p.review.confirmed.nextTime} (${p.review.confirmed.timeZone}).\nПодтверждено в демонстрационном кабинете ${p.review.confirmed.at}. Реальная врачебная авторизация отсутствует.` : 'Подтверждённой врачебной записи нет. Открытие карточки не считается оценкой безопасности.'}\n\nСЛЕДУЮЩИЙ КОНТАКТ\n${p.appointment.date ? dateText(p.appointment.date) + ', ' + p.appointment.time + '. ' + p.appointment.source : 'Дата не указана.'}\nПациент отметил состоявшийся приём: ${p.appointment.attended ? 'да' : 'нет; факт не подтверждён'}.\nСводка сформирована по сохранённым данным без генерации диагнозов и назначений.`;
}
export function patientCarePlan(workspace, state, id = 'live') {
  const plan = workspace?.reviews?.[reviewKey(id, state)]?.confirmed;
  return plan ? { id: plan.id, at: plan.at, goal: plan.goal, plan: plan.plan, watch: plan.watch, earlyContact: plan.earlyContact, nextDate: plan.nextDate, nextTime: plan.nextTime, timeZone: plan.timeZone, source: 'Демонстрационный кабинет психиатра' } : null;
}
export function saveClinicalReview(workspace, id, liveState, action, wallNow = Date.now(), connectedEntry = null) {
  const p = clinicianPatient(workspace, id, liveState, wallNow, connectedEntry);
  if (!p) return { status: 404, error: 'Пациент не найден в этом демонстрационном кабинете' };
  const review = p.review;
  if (action.episodeId !== p.episodeId) return { status: 409, error: 'Начат новый этап наблюдения. Старая запись не может быть сохранена в другой эпизод.' };
  if (action.revision !== review.revision) return { status: 409, error: 'Запись врача изменилась в другом окне. Обновите карточку; ваш введённый текст можно сохранить повторно.' };
  if (action.type === 'viewed') {
    if (action.sourceRevision !== p.sourceRevision) return { status: 409, error: 'Данные пациента изменились. Обновите карточку перед отметкой просмотра.' };
    review.viewedAt = new Date(wallNow).toISOString();
    review.viewedSourceRevision = p.sourceRevision;
  } else if (action.type === 'draft' || action.type === 'confirm') {
    const fields = ['clinicalNote', 'safetyNote', 'goal', 'plan', 'watch', 'earlyContact', 'nextDate', 'nextTime'];
    if (!action.values || typeof action.values !== 'object' || fields.some(k => typeof action.values[k] !== 'string' || action.values[k].length > (k === 'clinicalNote' || k === 'plan' ? 2000 : 1000))) return { status: 400, error: 'Проверьте поля записи и длину текста' };
    const values = Object.fromEntries(fields.map(k => [k, action.values[k].trim()]));
    if (values.nextDate && (!/^\d{4}-\d{2}-\d{2}$/.test(values.nextDate) || Number.isNaN(Date.parse(values.nextDate + 'T12:00:00Z')) || new Date(values.nextDate + 'T12:00:00Z').toISOString().slice(0, 10) !== values.nextDate)) return { status: 400, error: 'Укажите существующую дату следующего контакта' };
    if (values.nextTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.nextTime)) return { status: 400, error: 'Проверьте время следующего контакта' };
    if (action.type === 'confirm') {
      if (action.sourceRevision !== p.sourceRevision) return { status: 409, error: 'Данные пациента изменились. Сначала обновите и просмотрите их перед подтверждением плана.' };
      if (action.reviewed !== true || ['clinicalNote', 'goal', 'plan', 'watch', 'earlyContact', 'nextDate', 'nextTime'].some(k => !values[k])) return { status: 400, error: 'Для подтверждения заполните запись, цель, план, наблюдение, основания раннего контакта, дату и время; подтвердите просмотр данных' };
      if (values.nextDate < p.today) return { status: 400, error: 'Дата следующего контакта должна быть не раньше демонстрационной даты пациента' };
      if (p.safety.needsClarification && !values.safetyNote) return { status: 400, error: 'Есть отдельные ответы о безопасности. Внесите результат беседы и согласованные действия; просмотр карточки не считается оценкой' };
      review.confirmed = { ...values, id: randomUUID(), at: new Date(wallNow).toISOString(), sourceRevision: p.sourceRevision, author: 'Тестовый психиатр', timeZone: p.timeZone };
      review.history.push(review.confirmed);
    }
    review.draft = { ...values, at: new Date(wallNow).toISOString() };
  } else return { status: 400, error: 'Неизвестное действие врача' };
  review.revision++;
  workspace.reviews[`${id}:${p.episodeId}`] = review;
  workspace.revision++;
  workspace.audit.push({ id: randomUUID(), event: action.type, patientId: id, at: new Date(wallNow).toISOString(), sourceRevision: p.sourceRevision, reviewRevision: review.revision });
  workspace.audit = workspace.audit.slice(-200);
  return { status: 200 };
}

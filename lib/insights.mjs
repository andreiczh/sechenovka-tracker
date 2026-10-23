import { FORMS, FREQUENCY, FUNCTION_LABELS, scoreAssessment, URGENT_TEXT } from '../public/shared/clinical.js';
import { EVIDENCE_VERSION, SUPPORT_STEPS, SUPPORT_QUESTIONS } from '../public/shared/evidence.js';
import { daysBetween } from './time.mjs';

const num = n => Number.isFinite(n) ? String(Math.round(n * 10) / 10).replace('.', ',') : 'не указан';
const sign = n => n > 0 ? '+' + num(n) : num(n);
const mean = (rows, k) => { const v = rows.map(r => r[k]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const source = (type, date, fields) => ({ type, date, fields });
export function symptomItems(assessment) {
  if (!assessment?.answers || assessment.answers.length !== 16) return [];
  return ['phq', 'gad'].flatMap(kind => FORMS[kind].items.map((text, i) => ({
    id: `${kind}-${i}`, kind, text, value: assessment.answers[(kind === 'phq' ? 0 : 9) + i],
    frequency: FREQUENCY[assessment.answers[(kind === 'phq' ? 0 : 9) + i]], date: assessment.date,
  }))).filter(v => Number.isInteger(v.value) && v.value >= 2 && v.id !== 'phq-8').sort((a, b) => b.value - a.value);
}

// Descriptive calculations only. Rules are product hypotheses, not diagnostic cut-offs.
// Source dates and denominators travel with every statement; gaps never become zero.
export function buildPatientSupport(s, carePlan = null) {
  const first = s.assessments[0], last = s.assessments.at(-1), diary = [...s.diary].sort((a, b) => a.date.localeCompare(b.date));
  const recent = diary.at(-1), health = s.healthContext || {}, checkins = s.treatmentCheckins || [];
  const urgent = Boolean(s.safety?.pending || s.safety?.needsGuidance || ['urgent', 'unknown'].includes(s.safety?.level));
  const facts = [], signals = [];
  const add = (id, title, text, tab, from, mandatory = false) => facts.push({ id, title, text, tab, source: from, mandatory });
  const signal = (id, title, text, from, tone = 'red') => signals.push({ id, title, text, source: from, tone });
  const voiceNotes = (s.voiceNotes || []).filter(n => !n.archivedAt);
  if (voiceNotes.length) add('voice-notes', 'Есть заметки своими словами', `Сохранено ${voiceNotes.length} проверенных расшифровок. Покажите врачу важные фрагменты. Они не заменяют анкеты и не подтверждают диагноз; срочность по голосу не определяется.`, 'voice', source('Ваши заметки', voiceNotes.at(-1).date, ['voice-note']), true);
  if (last) {
    const sc = scoreAssessment(last);
    add('scores', 'Две отдельные шкалы', `PHQ-9: ${sc.phq.score}/27; GAD-7: ${sc.gad.score}/21. Ответы описывают ${last.window.start} — ${last.window.end}. Это частота симптомов, а не вероятность диагноза.`, 'results', source('Анкеты', last.date, ['PHQ-9', 'GAD-7']), true);
    if (last !== first) {
      const init = scoreAssessment(first);
      add('scales-change', 'Что изменилось в анкетах', `От ${first.date} до ${last.date}: PHQ-9 ${sign(sc.phq.score - init.phq.score)}, GAD-7 ${sign(sc.gad.score - init.gad.score)} баллов. Изменение само по себе не доказывает эффект лечения или выздоровление.`, 'dynamics', source('Два двухнедельных окна', last.date, ['PHQ-9', 'GAD-7']));
    }
    const items = symptomItems(last);
    if (items.length) add('symptoms', 'Что отмечалось чаще', items.slice(0, 3).map(i => `${i.text}: ${i.frequency.toLowerCase()}`).join('; ') + '. При беседе важны и отдельные ответы, и то, как они влияют на жизнь.', 'results', source('Отдельные пункты анкет', last.date, items.slice(0, 3).map(i => i.id)));
    if (last.answers[8] > 0 || s.safetyEvents?.length) add('safety-history', 'Ответ о безопасности требует разговора', 'В истории есть ответ о мыслях о смерти или самоповреждении. Обсудите его при контакте, даже если общая сумма снизилась. Приложение не оценивает текущую безопасность по графику.', 'visit', source('Пункт 9 и отдельные ответы', last.date, ['PHQ-9.9']), true);
    if (last.context?.function >= 2) signal('function', 'Расскажите врачу, что стало трудно', `По анкете обычные дела: ${FUNCTION_LABELS[last.context.function].toLowerCase()}. Договоритесь о сроке контакта; дневник не должен откладывать помощь.`, source('Функционирование', last.date, ['function']));
  } else add('unfinished', 'Сначала нужны завершённые ответы', 'Итоговые баллы появятся после полного исходного скрининга. Частично заполненная анкета не становится нулевым результатом.', 'today', source('Состояние анкеты', s.today, []), true);
  add('coverage', 'Насколько полна картина', `Дневник: ${s.stats.recorded} из ${s.stats.expected} дней; ${s.stats.missing} без записей. Сон указан в ${s.stats.sleepCount} записях. Пропуски можно оставить: состояние в эти дни неизвестно.`, 'diary', source('Полнота дневника', s.today, ['recorded', 'expected', 'sleepCount']), true);
  if (recent) {
    add('recent', 'Последняя запись', `${recent.date}: настроение ${num(recent.mood)}/10 (выше — лучше), тревога ${num(recent.anxiety)}/10 (выше — сильнее), сон ${num(recent.sleep)}${recent.sleep === null ? '' : ' ч'}. Обычные дела: ${FUNCTION_LABELS[recent.function]}.`, 'diary', source('Дневник', recent.date, ['mood', 'anxiety', 'sleep', 'function']));
    if (daysBetween(recent.date, s.today) >= 3) add('freshness', 'Текущее состояние неизвестно', `Последней записи ${daysBetween(recent.date, s.today)} дн. Выводы относятся к заполненным датам. Не нужно заполнять пропуски по памяти.`, 'diary', source('Давность', recent.date, []), true);
    if (recent.change === 'Стало хуже' || recent.function === 3) signal('worse', 'Не ждите окончания двух недель', 'В последней записи отмечены ухудшение или сильные трудности в делах. Свяжитесь с врачом раньше планового срока и расскажите, что именно изменилось. При опасности сейчас откройте памятку помощи.', source('Дневник', recent.date, ['change', 'function']));
  }
  const rows = diary.filter(d => daysBetween(d.date, s.today) >= 0 && daysBetween(d.date, s.today) <= 13);
  if (rows.length >= 6) {
    const a = rows.slice(0, 3), b = rows.slice(-3);
    add('diary-change', 'Сравнение заполненных дней', `Первые 3 записи (${a[0].date} — ${a.at(-1).date}) и последние 3 (${b[0].date} — ${b.at(-1).date}): настроение ${sign(mean(b, 'mood') - mean(a, 'mood'))}/10; тревога ${sign(mean(b, 'anxiety') - mean(a, 'anxiety'))}/10. Между этими датами могли быть пропуски; это описание, а не прогноз.`, 'dynamics', source('Две группы по 3 записи', b.at(-1).date, ['mood', 'anxiety']));
  } else if (last) add('few-days', 'Для сравнения пока мало записей', 'Покажем сравнение первых и последних трёх заполненных дней, когда будет хотя бы шесть записей за последние две недели. Один день не описывает тенденцию.', 'dynamics', source('Число записей', s.today, ['diary.length']));
  if (health.activation === 'yes') signal('activation', 'Отдельно расскажите про активность и сон', 'Вы отметили периоды необычной активности и меньшей потребности во сне. Это важно для оценки врачом; не подбирайте и не меняйте препараты самостоятельно.', source('Дополнительные сведения со слов', health.at?.slice(0, 10), ['activation']));
  const effect = checkins.at(-1);
  if (effect && effect.effect !== 'none' && effect.effect !== 'unknown') {
    signal('new-effect', 'Обсудите новое мешающее явление', `${effect.date}: ${effect.effect === 'drowsy' ? 'сонливость' : effect.effect === 'dizzy' ? 'головокружение' : 'другое явление'}; влияние на дела ${effect.impact}/3. Совпадение по времени не доказывает связь с препаратом. При сильном проявлении свяжитесь с врачом раньше; при сонливости или головокружении не садитесь за руль.`, source('Отметка о плане и переносимости', effect.date, ['effect', 'impact']));
  }
  if (checkins.length) add('treatment', 'Что известно о выполнении плана', `Есть ${checkins.length} дневных отметок: полностью выполнено со слов — ${checkins.filter(c => c.adherence === 'taken').length}, частично — ${checkins.filter(c => c.adherence === 'partly').length}, не выполнено — ${checkins.filter(c => c.adherence === 'missed').length}. Это не процент приёма доз: схема лечения здесь не проверена.`, 'support', source('Отметки о плане', checkins.at(-1).date, ['adherence']));
  const nextDate = carePlan?.nextDate || s.appointment.date;
  if (nextDate && nextDate < s.today && !s.appointment.attended) signal('contact-due', 'Уточните следующий контакт', `Указанная дата ${nextDate} уже прошла. Если беседы ещё не было, свяжитесь с врачом и договоритесь о новом сроке. Приложение не записывает на приём.`, source(carePlan ? 'Подтверждённый демоплан' : 'Дата со слов', nextDate, []), 'neutral');
  const questions = ['general'];
  if (last?.answers[2] >= 2 || recent?.sleep !== null && recent?.sleep < 6) questions.unshift('sleep');
  if (last && scoreAssessment(last).gad.score >= 10) questions.unshift('anxiety');
  if (signals.some(x => ['worse', 'function'].includes(x.id))) questions.unshift('function');
  if (health.medicines || checkins.length) questions.unshift('medicines');
  if (health.activation === 'yes') questions.unshift('activation');
  const ids = ['small', 'connect', 'walk', 'sleep', 'prepare'];
  if (questions.includes('sleep')) ids.unshift(...ids.splice(ids.indexOf('sleep'), 1));
  if (signals.length) ids.unshift(...ids.splice(ids.indexOf('prepare'), 1));
  const steps = urgent || !last ? [] : ids.map(id => ({ id, ...SUPPORT_STEPS[id], why: id === 'sleep' && questions.includes('sleep') ? 'В анкетах или дневнике есть отметки о нарушениях сна.' : id === 'prepare' && signals.length ? 'Есть сведения, которые стоит обсудить при контакте.' : id === 'small' && last.answers[0] >= 2 ? 'Вы часто отмечали снижение интереса; маленькая задача может быть посильнее большого плана.' : 'Необязательная повседневная поддержка. Можно выбрать то, что вам подходит.' }));
  const feedback = (s.supportFeedback || []).filter(f => f.date === s.today);
  const selectedStep = feedback.find(f => f.status === 'done');
  const candidates = steps.filter(x => !feedback.some(f => f.stepId === x.id && f.status === 'skip'));
  return { version: EVIDENCE_VERSION, episodeId: s.episodeId, urgent, facts, signals, steps, suggested: selectedStep ? steps.find(s => s.id === selectedStep.stepId) || candidates[0] || null : candidates[0] || null, feedback, questions: [...new Set(questions)].map(id => ({ id, text: SUPPORT_QUESTIONS[id] })), nextDate: nextDate || null, carePlanAvailable: Boolean(carePlan), limits: 'Это объяснение самоотчёта и повседневная поддержка. Диагноз, лечение и срочность определяет врач. Заметки не проверяются автоматически на опасность; врач не наблюдает за ними постоянно.' };
}

export function selectedSupportStep(support, draft = null) {
  if (support.urgent) return null;
  const done = support.feedback.find(f => f.status === 'done');
  if (done) return support.steps.find(s => s.id === done.stepId) || null;
  const skipped = new Set(support.feedback.filter(f => f.status === 'skip').map(f => f.stepId));
  if (support.signals.some(s => s.tone === 'red') && !skipped.has('prepare')) return support.steps.find(s => s.id === 'prepare') || null;
  return (draft?.stepIds || []).map(id => support.steps.find(s => s.id === id)).find(s => s && !skipped.has(s.id)) || support.suggested;
}
export function supportText(support, draft = null) {
  if (support.urgent) return 'Сначала — помощь и оценка безопасности\n\n' + URGENT_TEXT + '\n\nОбычные рекомендации и внешний ИИ-запрос приостановлены. Врач не наблюдает за перепиской постоянно. Откройте памятку помощи; текущие ответы можно уточнить отдельно.';
  const facts = draft?.facts || support.facts.slice(0, 3);
  const step = selectedSupportStep(support, draft);
  return ['Коротко о ваших данных', ...support.signals.map(s => `${s.title}. ${s.text}`), ...facts.map(f => `${f.title}. ${f.text}`), support.urgent ? 'Сначала откройте помощь. Обычные советы не заменяют немедленное обращение.' : step ? `Один шаг на сегодня: ${step.title}. ${step.text}` : 'Закончите исходные анкеты, чтобы появились данные для разбора.', `Вопрос к приёму: ${(draft?.questions || support.questions)[0]?.text || SUPPORT_QUESTIONS.general}`, support.limits].join('\n\n');
}

// Exact Russian wording: A. A. Zolotareva (2023), appendices, CC BY-NC 4.0.
// Educational local prototype. See docs/patient-clinical-rules.md for provenance.
export const FORM_VERSION = 'zolotareva-2023-ru-v1';
export const INSTRUCTION = 'Оцените, пожалуйста, насколько часто следующие проблемы беспокоили вас в течение прошедших двух недель.';
export const FREQUENCY = ['Совсем нет', 'В течение нескольких дней', 'Более, чем половину этого времени', 'Почти каждый день'];
export const FORMS = {
  phq: {
    name: 'PHQ-9', domain: 'Депрессивные симптомы', max: 27,
    items: [
      'Снижение интереса и удовольствия от привычных дел',
      'Чувство подавленности или безнадежности',
      'Проблемы со сном (неспособность заснуть, раннее пробуждение или слишком долгий сон)',
      'Чувство усталости или недостатка энергии',
      'Плохой аппетит или переедание',
      'Плохое мнение о себе или чувство, что не смог оправдать ожиданий моей семьи',
      'Проблемы с концентрацией внимания (например, при чтении газеты или просмотре телевизионной передачи)',
      'Замедленность движений или речи, которая стала заметна другим людям, или, напротив, суетливость, когда движения и речь стали более быстрыми и беспокойными',
      'Мысли о том, что мне бы хотелось умереть или причинить себе боль',
    ],
  },
  gad: {
    name: 'GAD-7', domain: 'Тревожные симптомы', max: 21,
    items: [
      'Чувство тревоги или раздражения.',
      'Неспособность справиться со своим беспокойством.',
      'Чрезмерное беспокойство по разным поводам.',
      'Неспособность расслабляться.',
      'Ощущение такого беспокойства, что трудно найти себе место.',
      'Склонность быстро испытывать злость или раздражительность.',
      'Чувство страха, как будто может случиться что–то ужасное.',
    ],
  },
};
export const FUNCTION_LABELS = ['Не мешало', 'Немного мешало', 'Сильно мешало', 'Почти не получалось справляться'];
export const DURATIONS = ['Меньше двух недель', 'От двух недель до месяца', 'От месяца до полугода', 'Больше полугода', 'Трудно сказать'];
export function scoreScale(kind, answers) {
  const form = FORMS[kind];
  if (!form) throw new Error('Неизвестная шкала');
  const complete = Array.isArray(answers) && answers.length === form.items.length && answers.every(v => Number.isInteger(v) && v >= 0 && v <= 3);
  if (!complete) return { complete: false, score: null, max: form.max, level: null, label: 'Анкета не завершена' };
  const score = answers.reduce((sum, v) => sum + v, 0);
  const cuts = kind === 'phq' ? [5, 10, 15, 20] : [5, 10, 15];
  const level = cuts.filter(v => score >= v).length;
  const labels = kind === 'phq'
    ? ['Минимальная выраженность', 'Лёгкая выраженность', 'Умеренная выраженность', 'Умеренно тяжёлая выраженность', 'Тяжёлая выраженность']
    : ['Минимальная выраженность', 'Лёгкая выраженность', 'Умеренная выраженность', 'Тяжёлая выраженность'];
  return { complete: true, score, max: form.max, level, label: labels[level] };
}
export function scoreAssessment(assessment) {
  return { phq: scoreScale('phq', assessment.answers.slice(0, 9)), gad: scoreScale('gad', assessment.answers.slice(9, 16)) };
}
export function assessmentSteps() {
  return [
    ...['phq', 'gad'].flatMap(kind => FORMS[kind].items.map((text, index) => ({ id: `${kind}-${index}`, kind, index, text, type: 'choice', options: FREQUENCY.map((label, value) => ({ label, value })), window: 'За последние две недели' }))),
    { id: 'function', text: 'Насколько за последние две недели это мешало работе, учёбе, домашним делам или общению?', type: 'choice', options: FUNCTION_LABELS.map((label, value) => ({ label, value })), window: 'Контекст · в сумму баллов не входит' },
    { id: 'duration', text: 'Как давно вы замечаете эти изменения?', type: 'choice', options: DURATIONS.map(label => ({ label, value: label })), window: 'Контекст · в сумму баллов не входит' },
    { id: 'goal', text: 'Что вы хотели бы обсудить с врачом в первую очередь?', type: 'text', placeholder: 'Например: плохо сплю и трудно работать', optional: true, window: 'Коротко, своими словами' },
  ];
}
export function diarySteps(day = 1, referenceDate = null) {
  const numberOptions = max => Array.from({ length: max + 1 }, (_, value) => ({ label: String(value), value }));
  const dayLabel = referenceDate ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${referenceDate}T12:00:00Z`)) : 'сегодня';
  return [
    { id: 'mood', text: `Какое настроение было у вас ${dayLabel}?`, type: 'number', options: numberOptions(10), minLabel: '0 — очень плохое', maxLabel: '10 — очень хорошее', window: `${dayLabel} · ваша личная оценка` },
    { id: 'anxiety', text: `Насколько сильной была тревога ${dayLabel}?`, type: 'number', options: numberOptions(10), minLabel: '0 — не было', maxLabel: '10 — очень сильная', window: `${dayLabel} · ваша личная оценка` },
    { id: 'sleep', text: referenceDate ? 'Сколько часов вы спали в основной сон перед этим днём?' : 'Сколько часов вы спали в последний основной сон?', type: 'sleep', min: 0, max: 24, optional: true, window: `${referenceDate ? dayLabel + ' · ' : ''}Часы сна · можно указать половину часа` },
    { id: 'function', text: `Насколько состояние мешало обычным делам ${dayLabel}?`, type: 'choice', options: FUNCTION_LABELS.map((label, value) => ({ label, value })), window: `${dayLabel} · работа, учёба, дом, общение` },
    ...(day >= 1 ? [{ id: 'change', text: `Как изменилось самочувствие ${referenceDate ? 'к этому дню ' : ''}по сравнению с началом наблюдения?`, type: 'choice', options: ['Стало лучше', 'Примерно так же', 'Стало хуже', 'Трудно сказать'].map(label => ({ label, value: label })), window: `${referenceDate ? dayLabel + ' · ' : ''}Контроль изменений` }] : []),
    { id: 'note', text: 'Что повлияло на день или что важно сказать врачу?', type: 'text', placeholder: 'Событие, новое ощущение, изменение лечения. Можно пропустить.', optional: true, window: 'Заметка для сводки · врач не читает её в реальном времени. Автоматический анализ текста на опасность не выполняется' },
  ];
}
export const SAFETY_QUESTION = 'Есть ли сейчас мысли причинить себе вред, намерение действовать или ощущение, что вы не можете оставаться в безопасности?';
export const SAFETY_OPTIONS = [{ label: 'Да / не уверен(а)', value: 'urgent' }, { label: 'Сейчас нет', value: 'contact' }, { label: 'Не хочу отвечать', value: 'unknown' }];
export const URGENT_TEXT = 'Если вы можете причинить себе вред сейчас или не уверены в своей безопасности, обратитесь за неотложной помощью: позвоните 112 или попросите человека рядом помочь вам это сделать. По возможности оставайтесь с человеком, которому доверяете. Не ждите ответа в приложении.';
export const RECOMMENDATION_VERSION = 'demo-feedback-v2';
export function hasReportedThoughts(state) {
  return state.safety?.source === 'PHQ-9, пункт 9' || state.safetyEvents.some(e => e.source === 'PHQ-9, пункт 9') || state.assessments.some(a => a.answers[8] > 0) || state.active?.values['phq-8'] > 0;
}
export function contactGuidance(state) {
  return hasReportedThoughts(state)
    ? 'Ранее в ответе на пункт 9 PHQ-9 вы отметили мысли о смерти или причинении себе боли. Даже при небольшой сумме баллов нужна отдельная беседа с врачом как можно скорее. При появлении опасности сейчас обращайтесь за неотложной помощью.'
    : 'Вы попросили помощи раньше. Свяжитесь с направившим врачом или психиатром и обсудите, что беспокоит и когда нужна консультация. Если становится хуже, не ждите следующей записи. Приложение не отправляет обращение врачу автоматически.';
}
export function patientRecommendation(state) {
  const result = (reason, tone, title, text) => ({ ruleVersion: RECOMMENDATION_VERSION, reasonCodes: [reason], tone, title, text });
  if (state.safety?.level === 'urgent' || state.safety?.level === 'unknown') return result('current-safety-guidance', 'red', 'Сейчас важнее получить помощь', URGENT_TEXT);
  if (state.safety?.level === 'contact') return result(hasReportedThoughts(state) ? 'reported-phq9-thoughts' : 'requested-earlier-help', 'red', hasReportedThoughts(state) ? 'Обсудите этот ответ с врачом как можно скорее' : 'Договоритесь о помощи раньше', contactGuidance(state));
  const last = state.assessments.at(-1);
  if (!last) return result('baseline-pending', 'green', 'Начнём с исходной точки', 'Две анкеты помогут описать симптомы за последние две недели. Затем вы увидите результаты и следующий шаг.');
  const latest = state.diary.at(-1);
  if (latest?.function >= 2 || latest?.change === 'Стало хуже') return result('daily-difficulties', 'red', 'Стоит связаться с врачом', 'В последней записи вы отметили сильные трудности с обычными делами или ухудшение самочувствия. Свяжитесь с врачом и обсудите срок консультации. Исходные баллы не отменяют новые трудности; ждать 14 дней не нужно. Дневник не устанавливает диагноз.');
  const { phq, gad } = scoreAssessment(last);
  if (phq.score >= 10 || gad.score >= 10 || last.context.function >= 2) return result('assessment-difficulties', 'red', 'Стоит связаться с врачом', 'Ответы показывают заметные трудности. Обсудите результаты и срок консультации с направившим врачом или психиатром. Записи можно вести параллельно; ждать 14 дней для обращения не нужно.');
  return result('planned-follow-up', 'green', 'Сохраните результаты и договоритесь о следующем контакте', 'Сумма баллов невысока, но она не исключает проблему. Короткий дневник поможет описать изменения. Если становится хуже или нужна помощь, обратитесь раньше.');
}

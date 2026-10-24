export const VOICE_VERSION = 'voice-review-v2';
export const VOICE_TOPICS = Object.freeze({ complaints: 'Что беспокоит', course: 'Начало и течение', sleep: 'Сон и силы', function: 'Повседневные дела', history: 'Предыдущие эпизоды и помощь', medicines: 'Лекарства, БАДы и вещества', safety: 'Безопасность: уточнить отдельно', plan: 'Обсуждённые действия', goal: 'Цель и вопросы', other: 'Другой контекст' });
export const VOICE_ROLES = Object.freeze({ patient: 'Пациент', doctor: 'Врач', unknown: 'Не определено' });
export const VOICE_QUESTIONS = Object.freeze({
  onset: 'Когда начались изменения, как часто возникают и что изменилось относительно обычного состояния?',
  function: 'Какие конкретные дела, учёба, работа или общение стали труднее?',
  sleep: 'Как изменились сон, потребность во сне и самочувствие днём?',
  activation: 'Были ли периоды необычной активности и меньшей потребности во сне? Уточнить длительность и последствия.',
  safety: 'Отдельно уточнить актуальную безопасность и доступную помощь при клиническом контакте. Отсутствие упоминания в записи не исключает риска.',
  medicines: 'Сверить названия, дозы, даты изменений и назначившего врача для всех лекарств, БАДов и веществ. Новые явления оценить отдельно.',
  previous: 'Какие похожие эпизоды и способы помощи уже были? Что помогало и что мешало?',
  goal: 'Что пациент хотел бы получить от ближайшего контакта и какой следующий шаг согласован?',
});
export function normalizeVoiceSegments(values, scope = 'patient') {
  if (!Array.isArray(values) || !values.length || values.length > (scope === 'patient' ? 60 : 2000)) throw new Error('Нужна расшифровка: до 60 фрагментов заметки или 2000 фрагментов беседы.');
  const seen = new Set(); let total = 0;
  const rows = values.map((v, i) => {
    if (!v || typeof v.text !== 'string' || !v.text.trim() || v.text.length > 1200) throw new Error('Проверьте текст фрагмента: от 1 до 1200 знаков.');
    const id = typeof v.id === 'string' && /^s\d{1,4}$/.test(v.id) ? v.id : `s${i}`;
    if (seen.has(id)) throw new Error('Повторяющийся фрагмент расшифровки.'); seen.add(id);
    const start = v.start === null || v.start === undefined ? null : Number(v.start), end = v.end === null || v.end === undefined ? null : Number(v.end);
    if (start !== null && (!Number.isFinite(start) || start < 0 || start > 3600) || end !== null && (!Number.isFinite(end) || end < (start || 0) || end > 3600)) throw new Error('Некорректное время фрагмента.');
    total += v.text.trim().length;
    return { id, text: v.text.trim(), start, end, role: scope === 'patient' ? 'patient' : Object.hasOwn(VOICE_ROLES, v.role) ? v.role : 'unknown', roleSource: v.roleSource === 'manual' ? 'manual' : 'unreviewed', topics: Array.isArray(v.topics) ? [...new Set(v.topics.filter(t => Object.hasOwn(VOICE_TOPICS, t)))].slice(0, 3) : [] };
  });
  if (total > (scope === 'patient' ? 6000 : 120000)) throw new Error('Слишком длинная запись. Разделите её на несколько частей.');
  return rows;
}
export function voiceGroups(segments) {
  return Object.entries(VOICE_TOPICS).map(([id, title]) => ({ id, title, segments: segments.filter(s => s.topics.includes(id)) })).filter(g => g.segments.length);
}
export function voiceSummary(segments, limit = 6) {
  const selected = [], seen = new Set(), texts = new Set();
  const add = (row,budget=limit) => { const key=row && row.role+':'+row.text.trim().toLocaleLowerCase('ru').replace(/\s+/g,' '); if(row && !seen.has(row.id) && !texts.has(key) && selected.length < budget){seen.add(row.id);texts.add(key);selected.push(row);} };
  const plan = segments.find(s=>s.role==='doctor' && s.topics?.includes('plan'));
  for(const topic of ['complaints','course','sleep','function','medicines','safety','history','goal']) add(segments.find(s=>s.role==='patient' && s.topics?.includes(topic)),plan?Math.max(0,limit-1):limit);
  add(plan);
  for(const role of ['patient','unknown','doctor']) for(const row of segments.filter(s=>s.role===role)) add(row);
  return { segments:selected, omitted:Math.max(0,segments.length-selected.length) };
}
export function voiceTimestamp(seconds) { if (seconds === null || seconds === undefined) return 'без времени'; return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
export function voiceText(note) {
  return `ТРЕКЕР СЕЧЕНОВКА · ${note.scope === 'patient' ? 'ЗАМЕТКА' : 'БЕСЕДА'}\n${note.at || ''}\n${note.title || ''}\n${note.ai?.complete === false ? 'ИИ-СТРУКТУРА ЧАСТИЧНАЯ: проверены не все фрагменты.\n' : ''}${note.incomplete ? 'ЧАСТИЧНАЯ РАСШИФРОВКА: часть записи не распознана или обработка остановлена.\n' : ''}Вымышленные данные. Расшифровка проверена пользователем; клинические выводы требуют отдельной оценки.\n\n${note.segments.map(s => `[${voiceTimestamp(s.start)}] ${VOICE_ROLES[s.role]}: ${s.text}`).join('\n')}\n\n${note.vopObservations?.length || note.vopSafety?.length ? 'ОТМЕТКИ ВОП ПРИ СОХРАНЕНИИ\n' + [...(note.vopObservations || []), ...(note.vopSafety || [])].join('\n') + '\nОтдельные отметки не являются диагнозом.\n\n' : ''}ПО ТЕМАМ\n${voiceGroups(note.segments).map(g => `${g.title}\n${g.segments.map(s => `${VOICE_ROLES[s.role]}: ${s.text}`).join('\n')}`).join('\n\n')}\n\nВОПРОСЫ К БЕСЕДЕ\n${(note.questions || []).map(id => VOICE_QUESTIONS[id]).filter(Boolean).join('\n')}\n\nРеплики — сохранённый текст, а не подтверждённые клинические факты. Диагноз, баллы анкет, назначения и врачебный план автоматически не изменяются.`;
}

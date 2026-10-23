import { randomUUID, createHash } from 'node:crypto';
import { EVIDENCE_VERSION } from '../public/shared/evidence.js';

// A physician reference, not a prescription engine. Diagnosis and safety entries
// are entered explicitly by the clinician and never inferred from scale totals.
export const THERAPY_FIELDS = Object.freeze([
  ['adult', 'Возраст 18+ подтверждён', 'positive'],
  ['safety', 'Актуальная безопасность оценена при клиническом контакте', 'positive'],
  ['differential', 'Соматические причины, активация / гипомания и психотические проявления оценены', 'positive'],
  ['refractory', 'Неэффективность первых двух линий при ГТР подтверждена', 'positive'],
  ['allergy', 'Гиперчувствительность к компонентам', 'hazard'],
  ['brain', 'Эпилепсия / органическое заболевание головного мозга', 'hazard'],
  ['renal', 'СКФ ниже 60 мл/мин', 'hazard'],
  ['hepatic', 'Печёночная недостаточность Child-Pugh A–C', 'hazard'],
  ['pregnancy', 'Беременность', 'hazard'],
  ['lactation', 'Грудное вскармливание', 'review'],
  ['maoi', 'ИМАО сейчас или в предыдущие 14 дней', 'hazard'],
  ['lactose', 'Ограничения по лактозе / сахарам из инструкции', 'hazard'],
  ['interactions', 'Лекарства, БАДы и взаимодействия сверены по инструкции', 'positive'],
]);
export const THERAPY_DIAGNOSES = Object.freeze({ unknown: 'Клиническое основание не подтверждено', gad: 'ГТР подтверждён врачом', postcovid: 'Постковидный тревожно-адаптационный сценарий подтверждён', depression: 'Депрессивное расстройство', other: 'Иной клинический сценарий' });
export const emptyTherapyContext = () => ({ revision: 0, diagnosis: 'unknown', checks: Object.fromEntries(THERAPY_FIELDS.map(([id]) => [id, 'unknown'])), evidence: '', at: null, sourceRevision: null });
const therapySourceHash = p => createHash('sha256').update(JSON.stringify({ episodeId: p.episodeId, today: p.today, assessments: p.assessments, draft: p.draft, diary: p.diary, safety: p.safety, health: p.healthContext, checkins: p.treatmentCheckins, medications: p.medications, visit: { question: p.appointment.question, attended: p.appointment.attended }, confirmedPlan: p.review.confirmed?.id || null })).digest('hex');

export function therapySupport(context, p) {
  const empty = emptyTherapyContext(), c = { ...empty, ...context, checks: { ...empty.checks, ...context?.checks } };
  const stale = Boolean(c.at && c.sourceHash !== therapySourceHash(p));
  const contraindications = THERAPY_FIELDS.filter(([id, , kind]) => kind === 'hazard' && c.checks[id] === 'yes').map(([, text]) => text);
  if (c.checks.adult === 'no') contraindications.unshift('Пациент младше 18 лет');
  const missing = THERAPY_FIELDS.filter(([id]) => c.checks[id] === 'unknown' && (id !== 'refractory' || c.diagnosis === 'gad')).map(([, text]) => text);
  const cautions = [];
  if (c.checks.interactions === 'no') cautions.push('Совместимость всех лекарств, БАДов и алкоголя не сверена');
  if (c.checks.safety === 'no') cautions.push('Актуальная клиническая оценка безопасности не подтверждена');
  if (c.checks.differential === 'no') cautions.push('Дифференциальная оценка причин симптомов и активации не завершена');
  if (c.checks.lactation === 'yes') cautions.push('При лактации требуется отдельное решение по инструкции; автоматическая рекомендация не формируется');
  if (c.checks.adult !== 'yes' && !missing.includes(THERAPY_FIELDS[0][1])) missing.unshift(THERAPY_FIELDS[0][1]);
  let status = 'insufficient', title = 'Оснований для положительной подсказки пока нет';
  let explanation = 'Одни баллы PHQ-9/GAD-7 не подтверждают диагноз, показание или пригодность препарата.';
  if (p.support?.urgent) { status = 'clinical-review'; title = 'Сначала — актуальная оценка безопасности'; explanation = 'В пациентском сценарии есть незавершённый вопрос безопасности или ответ, требующий отдельной помощи. Обычная лекарственная подсказка приостановлена.'; }
  else if (contraindications.length) { status = 'blocked'; title = 'Есть ограничение из инструкции'; explanation = 'Положительная подсказка остановлена. Уточните сведения и выберите другой план помощи; это не команда отменить уже назначенное лечение.'; }
  else if (c.diagnosis === 'depression' || c.diagnosis === 'other') { status = 'no-portfolio-option'; title = 'Подходящего варианта в проверенной части портфеля нет'; explanation = 'В этой ветке Авиандр не подставляется как антидепрессант или универсальное средство. Нужен клинический план по соответствующему расстройству; бренд спонсора не расширяет показания.'; }
  else if (c.diagnosis === 'gad' && c.checks.refractory === 'no') { status = 'line-mismatch'; title = 'Не показывать Авиандр как первую линию'; explanation = 'КР 457_3 описывают маритупердин в разделе третьей линии при рефрактерности к первым двум. Регистрационное показание ГТР не делает препарат безусловным первым выбором.'; }
  else if (stale) { status = 'stale'; title = 'После проверки появились новые сведения'; explanation = 'Проверьте актуальные лекарства, состояние и ограничения. Старый список не считается проверкой новых данных.'; }
  else if (c.at && ['gad', 'postcovid'].includes(c.diagnosis) && !missing.length && !cautions.length && c.evidence.trim()) {
    status = 'consider'; title = 'Есть основание для рассмотрения врачом';
    explanation = c.diagnosis === 'gad' ? 'Внесены подтверждённый ГТР, сведения о предшествующих линиях и проверка ключевых ограничений. Это справочный вариант для клинического решения врача, не назначение.' : 'Внесён отдельный постковидный тревожно-адаптационный контекст лёгкой/средней выраженности и проверка ключевых ограничений. Соответствие точной формулировке показания подтверждает врач.';
  }
  return { version: EVIDENCE_VERSION, status, title, explanation, context: c, stale, contraindications, missing, cautions,
    medicine: { name: 'Авиандр', substance: 'Маритупирдин', group: 'Анксиолитик · N05BX · рецептурный', sponsor: 'ХимРар / Авинейро — портфель спонсора', sources: ['aviandr', 'anxiety'],
      indication: 'Взрослые: ГТР; отдельный постковидный тревожно-адаптационный сценарий из раздела показаний.',
      guideline: 'КР 457_3, §3.2: маритупердин, третья линия при рефрактерности к первым двум, УУР B / УДД 2. В тексте есть редакционная несогласованность названия линии; требуется врачебная сверка.',
      exclusions: 'По проверенной инструкции депрессия, паническое расстройство и общая адаптационная реакция без COVID-19 не включаются автоматически. Исследования не расширяют зарегистрированные показания.',
      monitoring: 'Фактический приём по назначенной схеме, тревога, функционирование, сонливость, головокружение, астения, новые средства и алкоголь. Дату контроля и длительность задаёт врач; по 1–2 неделям дневника не объявляют лечение неэффективным.',
      interactions: 'Сверить ИМАО и интервал после них; серотонинергические/седативные средства, ингибиторы CYP2D6, алкоголь, зверобой и L-триптофан. Встроенная форма не является полным справочником взаимодействий.',
    }, alternative: 'Не выбирать препарат из портфеля; обсудить психотерапию и фармакотерапию по соответствующим КР. Выбор конкретного средства — после клинической оценки.',
    bounds: 'Ключевые проверки не заменяют полную актуальную инструкцию и клиническую оценку. Дозировки не генерируются. Эта справка и черновики не передаются пациенту как назначения.' };
}

export function saveTherapyContext(workspace, p, action, now) {
  const key = `${p.id}:${p.episodeId}`, old = workspace.therapyContexts?.[key] || emptyTherapyContext();
  if (action.episodeId !== p.episodeId || action.sourceRevision !== p.sourceRevision || action.contextRevision !== old.revision) return { status: 409, error: 'Данные или врачебная проверка изменились. Обновите карточку перед сохранением.' };
  const values = action.values;
  if (!values || !Object.hasOwn(THERAPY_DIAGNOSES, values.diagnosis) || typeof values.evidence !== 'string' || values.evidence.length > 1600 || !values.checks || THERAPY_FIELDS.some(([id]) => !['yes', 'no', 'unknown'].includes(values.checks[id]))) return { status: 400, error: 'Проверьте основание, ответы и длину пояснения' };
  const record = { revision: old.revision + 1, diagnosis: values.diagnosis, evidence: values.evidence.trim(), checks: Object.fromEntries(THERAPY_FIELDS.map(([id]) => [id, values.checks[id]])), at: new Date(now).toISOString(), sourceRevision: p.sourceRevision, sourceHash: therapySourceHash(p) };
  workspace.therapyContexts ||= {}; workspace.therapyContexts[key] = record;
  workspace.audit.push({ id: randomUUID(), event: 'therapy-context', patientId: p.id, sourceRevision: p.sourceRevision, contextRevision: record.revision, at: record.at }); workspace.audit = workspace.audit.slice(-200);
  return { status: 200, data: record };
}

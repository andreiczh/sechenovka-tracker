export const checklistGroups = Object.freeze([
  {
    id: 'wellbeing', title: 'Настроение и повседневная жизнь', eyebrow: 'О чём спросить',
    items: [
      { id: 'low-mood', title: 'Сниженное настроение', description: 'Грусть, подавленность или ощущение безнадёжности.' },
      { id: 'interest', title: 'Меньше интереса и удовольствия', description: 'Привычные занятия перестали радовать или увлекать.' },
      { id: 'energy', title: 'Усталость и недостаток сил', description: 'На обычные дела требуется заметно больше усилий.' },
      { id: 'sleep', title: 'Изменился сон', description: 'Трудно заснуть, частые пробуждения или сонливость.' },
      { id: 'concentration', title: 'Труднее сосредоточиться', description: 'Сложнее удерживать внимание и принимать решения.' },
    ],
  },
  {
    id: 'anxiety', title: 'Тревога и её влияние', eyebrow: 'Что уточнить',
    items: [
      { id: 'worry', title: 'Частое беспокойство', description: 'Много тревожных мыслей о разных событиях и делах.' },
      { id: 'control', title: 'Тревогу трудно остановить', description: 'Человек не может переключиться, даже когда старается.' },
      { id: 'tension', title: 'Напряжение или раздражительность', description: 'Трудно расслабиться; привычные ситуации раздражают.' },
      { id: 'avoidance', title: 'Избегание дел и общения', description: 'Из-за самочувствия откладывает дела или встречи.' },
      { id: 'functioning', title: 'Страдают обычные дела', description: 'Состояние мешает работе, учёбе или заботе о себе.' },
    ],
  },
]);

export const safetyItems = Object.freeze([
  { id: 'current-danger', title: 'Есть непосредственное опасение за безопасность', description: 'Актуальное намерение самоповреждения, план или невозможность обеспечить безопасность.' },
  { id: 'other-urgent', title: 'Есть другие признаки, требующие срочной оценки', description: 'Например, психотические проявления, выраженное возбуждение, спутанность или острое соматическое состояние.' },
]);

export const clinicalSources = Object.freeze([
  { title: 'Депрессивный эпизод и рекуррентное депрессивное расстройство', organization: 'Клинические рекомендации Минздрава РФ', url: 'https://cr.minzdrav.gov.ru/view-cr/301_3', detail: 'Клиническая оценка и диагностика.' },
  { title: 'Генерализованное тревожное расстройство', organization: 'Клинические рекомендации Минздрава РФ', url: 'https://cr.minzdrav.gov.ru/view-cr/457_3', detail: 'Оценка тревожной симптоматики и ведение.' },
  { title: 'Depression in adults: treatment and management', organization: 'NICE NG222, раздел 1.2', url: 'https://www.nice.org.uk/guidance/ng222/chapter/Recommendations', detail: 'Выявление, контекст, функционирование и безопасность.' },
  { title: 'Generalised anxiety disorder and panic disorder in adults', organization: 'NICE CG113, раздел 1.2', url: 'https://www.nice.org.uk/guidance/cg113/chapter/Recommendations', detail: 'Выявление и всесторонняя оценка тревоги.' },
]);

const itemIds = new Set(checklistGroups.flatMap(group => group.items.map(item => item.id)));
const safetyIds = new Set(safetyItems.map(item => item.id));

export function evaluateChecklist(selected = [], selectedSafety = [], threshold = 0.6) {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new RangeError('Invalid demo threshold');
  const uniqueItems = new Set([...selected].filter(id => itemIds.has(id)));
  const uniqueSafety = new Set([...selectedSafety].filter(id => safetyIds.has(id)));
  const total = itemIds.size;
  return Object.freeze({
    count: uniqueItems.size,
    total,
    fraction: uniqueItems.size / total,
    requiredCount: Math.ceil(total * threshold),
    thresholdReached: uniqueItems.size >= Math.ceil(total * threshold),
    safetyConcern: uniqueSafety.size > 0,
    safetyCount: uniqueSafety.size,
  });
}

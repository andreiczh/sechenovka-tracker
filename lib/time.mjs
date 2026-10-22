export function localParts(instant, timeZone = 'Europe/Moscow') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, second: Number(p.second) };
}
export const addDays = (date, count) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
export function zonedInstant(date, time, zone) {
  const target = Date.parse(`${date}T${time}:00Z`);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(guess, zone);
    const actual = Date.parse(`${p.date}T${p.time}:00Z`);
    const diff = target - actual;
    guess += diff;
    if (diff === 0) break;
  }
  const check = localParts(guess, zone);
  return check.date === date && check.time === time ? guess : null;
}
export const demoNow = (state, wallNow = Date.now()) => new Date(wallNow + state.clockOffsetMs).toISOString();
export function validateReminders(value) {
  if (typeof value?.enabled !== 'boolean') throw new Error('Укажите, включены ли напоминания');
  if (typeof value.timeZone !== 'string' || !value.timeZone) throw new Error('Укажите часовой пояс');
  try { new Intl.DateTimeFormat('ru', { timeZone: value.timeZone }).format(); } catch { throw new Error('Неизвестный часовой пояс'); }
  if (!Array.isArray(value.times) || value.times.length < 1 || value.times.length > 3 || value.times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || new Set(value.times).size !== value.times.length) throw new Error('Выберите от 1 до 3 разных времён');
  return { enabled: value.enabled, timeZone: value.timeZone, times: [...value.times].sort() };
}

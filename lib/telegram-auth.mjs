import { createHmac, timingSafeEqual } from 'node:crypto';

export function secretMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function telegramSessionId(userId, identitySecret) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || identitySecret.length < 32) throw new Error('Не удалось проверить Telegram-профиль');
  // This namespace cannot be selected by the public demo's UUID cookie.
  return 'tg-' + createHmac('sha256', identitySecret).update(String(userId)).digest('hex');
}

export function verifyTelegramInitData(initData, botToken, now = Date.now()) {
  if (typeof initData !== 'string' || !initData || initData.length > 12000 || !botToken) throw new Error('Откройте дневник кнопкой в боте Telegram');
  const params = new URLSearchParams(initData);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new Error('Не удалось проверить вход из Telegram. Откройте приложение заново.');
  const hash = params.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(hash || '')) throw new Error('Не удалось проверить вход из Telegram. Откройте приложение заново.');
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', key).update(check).digest('hex');
  if (!secretMatches(hash.toLowerCase(), expected)) throw new Error('Не удалось проверить вход из Telegram. Откройте приложение заново.');
  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || authDate * 1000 > now + 60000 || now - authDate * 1000 > 86400000) throw new Error('Сессия Telegram устарела. Закройте дневник и откройте его кнопкой в боте.');
  let user;
  try { user = JSON.parse(params.get('user')); } catch {}
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot) throw new Error('Не удалось проверить Telegram-профиль');
  return { userId: user.id };
}

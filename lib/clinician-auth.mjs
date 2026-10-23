import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CLINICIAN_COOKIE = 'sechenovka_clinician';
export const CLINICIAN_SESSION_MS = 12 * 3600000;
const digest = value => createHash('sha256').update(value).digest('hex');
const ownerId = token => `clinic-auth:${digest(token)}`;
const cookieValue = req => req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(CLINICIAN_COOKIE + '='))?.slice(CLINICIAN_COOKIE.length + 1) || '';
export function createClinicianAuth({ config, store, wallClock }) {
  const attempts = new Map();
  const credentialTag = digest(`clinic-login-v1:${config.clinicianAccessKey || ''}`);
  const cookie = (token, expires = false) => `${CLINICIAN_COOKIE}=${token}; Path=/api/clinic; HttpOnly; SameSite=Strict; Max-Age=${expires ? 0 : CLINICIAN_SESSION_MS / 1000}${config.publicOrigin?.startsWith('https:') ? '; Secure' : ''}`;
  async function authenticate(req) {
    if (!config.clinicianAccessKey) return null;
    const token = cookieValue(req);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return store.withSession(ownerId(token), async transaction => {
      const session = await transaction.getWorkspace(ownerId(token));
      return session?.credentialTag === credentialTag && session.expiresAt > wallClock() ? { expiresAt: session.expiresAt } : null;
    });
  }
  async function login(req, key) {
    if (!config.clinicianAccessKey) return { status: 503, error: 'Вход в учебный кабинет пока не настроен' };
    const now = wallClock(), address = req.socket.remoteAddress || 'unknown';
    for (const [id, item] of attempts) if (item.until <= now) attempts.delete(id);
    const attempt = attempts.get(address) || { count: 0, until: now + 900000 };
    if (attempt.count >= 8) return { status: 429, error: 'Слишком много попыток входа. Повторите через 15 минут.' };
    const supplied = typeof key === 'string' && key.length <= 256 ? key : '';
    if (!timingSafeEqual(Buffer.from(digest(supplied), 'hex'), Buffer.from(digest(config.clinicianAccessKey), 'hex'))) {
      attempt.count++; attempts.set(address, attempt);
      return { status: 401, error: 'Неверный ключ доступа' };
    }
    attempts.delete(address);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + CLINICIAN_SESSION_MS;
    // Only the hash of the random session cookie is stored. Revocation survives
    // restarts and overlapping deploys; changing the access key revokes sessions.
    await store.withSession(ownerId(token), transaction => transaction.saveWorkspace(ownerId(token), { credentialTag, expiresAt }));
    const oldToken = cookieValue(req);
    if (/^[A-Za-z0-9_-]{43}$/.test(oldToken)) await store.withSession(ownerId(oldToken), transaction => transaction.saveWorkspace(ownerId(oldToken), { expiresAt: 0 }));
    return { status: 200, data: { enabled: true, authenticated: true, expiresAt }, setCookie: cookie(token) };
  }
  async function logout(req) {
    const token = cookieValue(req);
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) await store.withSession(ownerId(token), transaction => transaction.saveWorkspace(ownerId(token), { expiresAt: 0 }));
    return cookie('', true);
  }
  return { authenticate, login, logout };
}

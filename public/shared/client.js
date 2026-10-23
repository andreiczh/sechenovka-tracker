import { telegramHeaders } from './telegram.js';
export const REQUEST_TIMEOUT_MS = 12000;
export async function requestJSON(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const uncertain = options.method === 'POST';
  const failure = (text, state, status) => Object.assign(new Error(text), { friendly: true, uncertain, state, status });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw failure('Сервер временно недоступен. Проверьте соединение и повторите действие.');
    }
    if (!response.ok) throw failure(typeof data.error === 'string' && data.error.length <= 500 ? data.error : 'Сервер временно недоступен. Повторите действие.', data.state, response.status);
    return data;
  } catch (error) {
    if (error.friendly) throw error;
    throw failure(controller.signal.aborted
      ? 'Сервер долго не отвечает. Сохранение пока не подтверждено. Проверьте текущий вопрос и повторите действие.'
      : 'Не удалось связаться с сервером. Сохранение пока не подтверждено. Проверьте соединение и повторите действие.');
  } finally { clearTimeout(timer); }
}
export async function getState() {
  return requestJSON('/api/state', { cache: 'no-store', headers: telegramHeaders() });
}
export async function sendAction(state, action) {
  return requestJSON('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Client': '1', ...telegramHeaders() }, body: JSON.stringify({ ...action, revision: state.revision }) });
}
export async function generatePatientSupport(state) {
  return requestJSON('/api/ai-support', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Client': '1', ...telegramHeaders() }, body: JSON.stringify({ consent: true, episodeId: state.episodeId, sourceHash: state.support.sourceHash }) }, 30000);
}
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const dateLabel = date => date ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`)) : 'Не назначено';
export const numericDate = date => date ? new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`)) : '—';
export const numberLabel = value => value === null || value === undefined ? 'нет данных' : String(value).replace('.', ',');
export const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${({ today: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-11 5 2 2 4-4"/>', results: '<path d="M8 3h8l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3Zm8 0v5h4M8 12h8m-8 4h6"/>', diary: '<path d="M4 4h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v16h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4V4Zm8 1v16M7 8h2m6 0h2m-10 4h2m6 0h2"/>', dynamics: '<path d="M4 4v16h16M7 15l4-5 4 2 5-7"/>', visit: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9V3Zm3 7v6m-3-3h6"/>', settings: '<path d="M10 3h4l.5 3 2 1 2.5-1 2 3.5-2 2v2l2 2-2 3.5-2.5-1-2 1-.5 3h-4l-.5-3-2-1L5 19l-2-3.5 2-2v-2l-2-2L5 6l2.5 1 2-1 .5-3Z"/><circle cx="12" cy="12.5" r="3"/>', arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>', check: '<path d="m5 12 4 4L19 6"/>', help: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>', back: '<path d="M20 12H5m6-6-6 6 6 6"/>', bell: '<path d="M6 9a6 6 0 0 1 12 0v5l2 3H4l2-3V9Zm4 12h4"/>', bot: '<rect x="4" y="7" width="16" height="14" rx="4"/><path d="M12 3v4m-4 5h.01M16 12h.01M9 17h6"/>', download: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>' })[name] || ''}</svg>`;

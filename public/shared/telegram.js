// Telegram's signed launch data is kept in memory and verified only by the server.
const fragment = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.hash.slice(1));
const initialData = fragment.get('tgWebAppData') || '';
const launch = Boolean(initialData || fragment.has('tgWebAppVersion'));
export const telegramInitialView = typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'settings' ? 'settings' : 'today';
export function telegramHeaders() {
  const data = globalThis.Telegram?.WebApp?.initData || initialData;
  return data ? { 'X-Telegram-Init-Data': data, 'X-Telegram-Launch': '1' } : launch ? { 'X-Telegram-Launch': '1' } : {};
}
export function prepareTelegram() {
  const prepare = () => {
    const webApp = globalThis.Telegram?.WebApp;
    if (!webApp || !(webApp.initData || launch)) return;
    if (launch && location.hash.includes('tgWebAppData=')) history.replaceState(null, '', location.pathname + location.search + '#' + telegramInitialView);
    webApp.ready(); webApp.expand(); webApp.setHeaderColor('#ffffff'); webApp.setBackgroundColor('#ffffff');
  };
  prepare();
  document.getElementById('telegram-sdk')?.addEventListener('load', prepare, { once: true });
}

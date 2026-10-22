import { getState, sendAction, escapeHtml as h, dateLabel } from '/shared/client.js';
let state, busy = false, lastMessage = '', statusTimer;
const messages = document.getElementById('chat-messages'), keyboard = document.getElementById('reply-keyboard'), status = document.getElementById('bot-status'), input = document.getElementById('message-input');
function render() {
  const stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 130 || !lastMessage;
  messages.innerHTML = `<div class="chat-day">Тестовый профиль · ${h(dateLabel(state.today))}</div>` + state.messages.map((m, i) => `<article class="message ${m.role === 'user' ? 'user' : ''} ${m.reminder ? 'reminder' : ''} ${i === 0 ? 'chat-welcome-message' : ''}">${i === 0 ? '<img class="chat-welcome" src="/assets/welcome.png" alt="Записи в блокноте при дневном свете">' : ''}${h(m.text)}<time>${new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', timeZone: state.reminders.timeZone }).format(new Date(m.at))}</time></article>`).join('');
  keyboard.innerHTML = state.keyboard.map(row => `<div class="keyboard-row">${row.map(label => `<button type="button" data-reply="${h(label)}">${h(label)}</button>`).join('')}</div>`).join('');
  document.getElementById('resume-button').hidden = !state.joined;
  if (stick || state.messages.at(-1)?.id !== lastMessage) { requestAnimationFrame(() => messages.scrollTo({ top: messages.scrollHeight, behavior: 'instant' })); messages.querySelectorAll('img').forEach(img => img.addEventListener('load', () => messages.scrollTo({ top: messages.scrollHeight, behavior: 'instant' }), { once: true })); }
  lastMessage = state.messages.at(-1)?.id;
}
function showError(text) { clearTimeout(statusTimer); status.textContent = text; statusTimer = setTimeout(() => status.textContent = '', 7000); }
async function send(text) {
  if (busy || !state) return;
  if (text === 'Открыть Mini App') { location.href = '/patient/'; return; }
  busy = true; document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { state = await sendAction(state, { type: 'bot', text }); input.value = ''; render(); status.textContent = ''; }
  catch (error) { if (error.state) { state = error.state; render(); } showError(error.message); }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
document.getElementById('message-form').addEventListener('submit', event => { event.preventDefault(); if (input.value.trim()) send(input.value); });
keyboard.addEventListener('click', event => { const b = event.target.closest('[data-reply]'); if (b) send(b.dataset.reply); });
document.getElementById('resume-button').addEventListener('click', () => send('Продолжить'));
try { state = await getState(); render(); } catch { showError('Локальный сервер недоступен. Запустите сервер проекта и обновите страницу.'); }
setInterval(async () => { if (busy || document.hidden) return; try { const next = await getState(); if (!state || next.revision !== state.revision) { state = next; render(); } } catch { /* Keep visible history; do not claim delivery. */ } }, 3000);

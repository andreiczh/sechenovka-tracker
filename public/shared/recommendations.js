import { escapeHtml as h } from './client.js';

let panel = null, owner = '', returnFocus = null, onClose = null;
export const recommendationsOpen = key => Boolean(panel?.open && (!key || owner === key));
export function closeRecommendations() { panel?.close(); }
export function openRecommendations({ key, title = 'Рекомендации', description = '', content, closed }) {
  if (!panel) {
    panel = document.createElement('dialog');
    panel.className = 'recommendations-dialog';
    panel.dataset.managedDialog = 'true';
    panel.setAttribute('aria-labelledby', 'recommendations-title');
    document.body.append(panel);
    panel.addEventListener('click', event => {
      if (event.target.closest('[data-recommendations-close]')) panel.close();
      const link = event.target.closest('a[href^="#"]');
      if (link && !link.getAttribute('href').startsWith('#support')) panel.close();
    });
    panel.addEventListener('close', () => {
      const callback = onClose; onClose = null; owner = '';
      callback?.();
      panel.innerHTML = '';
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    });
  }
  if (!panel.open) returnFocus = document.activeElement;
  owner = key; onClose = closed || null;
  const oldBody = panel.querySelector('.recommendations-body');
  const scrollTop = oldBody?.scrollTop || 0;
  const hadFocus = panel.contains(document.activeElement);
  const activeId = hadFocus ? document.activeElement.id : '';
  panel.innerHTML = `<header class="recommendations-head"><div><h2 id="recommendations-title">${h(title)}</h2>${description ? `<p>${h(description)}</p>` : ''}</div><button class="window-close" data-recommendations-close aria-label="Закрыть рекомендации">×</button></header><div class="recommendations-body">${content}</div>`;
  panel.querySelector('.recommendations-body').scrollTop = scrollTop;
  if (!panel.open) panel.showModal();
  else if (hadFocus) (activeId ? panel.querySelector('#' + CSS.escape(activeId)) : panel.querySelector('[data-recommendations-close]'))?.focus({ preventScroll: true });
  return panel;
}

import { openRecommendations } from '/shared/recommendations.js';
import { openVoice } from '/shared/voice-ui.js';
import { buildVopConversation } from './shared/vop-support.js';
import { startViewport, revealViewportElement } from './shared/viewport.js';
import { appConfig } from './config.js';
import { checklistGroups, safetyItems, clinicalSources, evaluateChecklist } from './clinical-data.js';

const selected = new Set();
const selectedSafety = new Set();
const byId = id => document.getElementById(id);
let installPrompt = null;
let toastTimer;

function renderChecklist() {
  byId('checklist-groups').innerHTML = checklistGroups.map(group => `
    <div class="checklist-group" role="group" aria-labelledby="${group.id}-title">
      <h3 class="group-title" id="${group.id}-title">${group.title}</h3>
      <div class="checklist-items">${group.items.map(item => `
        <div class="check-option"><label class="check-item" for="${item.id}" title="${item.description}">
          <input type="checkbox" id="${item.id}" name="observation" value="${item.id}" aria-describedby="${item.id}-description">
          <span><strong>${item.title}</strong><span class="item-description" id="${item.id}-description">${item.description}</span></span>
        </label><button class="item-info" type="button" data-info="${item.id}" aria-label="Подробнее: ${item.title}">i</button></div>`).join('')}
      </div>
    </div>`).join('');

  byId('safety-items').innerHTML = safetyItems.map(item => `
    <label class="safety-item" for="${item.id}">
      <input type="checkbox" id="${item.id}" name="safety" value="${item.id}" aria-describedby="${item.id}-description">
      <span><strong>${item.title}</strong><span class="item-description" id="${item.id}-description">${item.description}</span></span>
    </label>`).join('');
}

function updateSelection() {
  const result = evaluateChecklist(selected, selectedSafety, appConfig.checklistThreshold);
  byId('selected-count').textContent = String(result.count);
  byId('compact-count').textContent = `${result.count} / ${result.total}`;
  byId('compact-screening').disabled = !result.thresholdReached;
  byId('compact-safety').classList.toggle('safety-active', result.safetyConcern);
  byId('count-progress').setAttribute('aria-valuenow', String(result.count));
  byId('count-progress').querySelector('span').style.width = `${result.fraction * 100}%`;
  byId('screening-button').disabled = !result.thresholdReached;
  byId('button-hint').textContent = result.thresholdReached
    ? 'Можно перейти к передаче ссылки пациенту.'
    : `Кнопка активируется при ${result.requiredCount} отметках.`;
  const panel = document.querySelector('.decision-panel');
  panel.classList.toggle('is-ready', result.thresholdReached);
  panel.classList.toggle('has-safety', result.safetyConcern);
  byId('safety-notice').hidden = !result.safetyConcern;
  byId('handoff-safety').hidden = !result.safetyConcern;

  let text;
  if (result.safetyConcern) {
    text = 'Есть признак, требующий отдельной оценки. Сначала проверьте безопасность.';
  } else if (result.thresholdReached) {
    text = 'Порог прототипа достигнут. Проверьте безопасность и предложите скрининг.';
  } else if (result.count > 0) {
    text = 'Учитывайте значимость жалоб. Перейти к скринингу можно по решению врача.';
  } else {
    text = 'Отмечайте подходящие пункты.';
  }
  byId('selection-summary').querySelector('p').textContent = text;
}

function navigateToPatient() { window.location.hash = 'patient'; }

function updateRoute({ focus = true } = {}) {
  const patient = window.location.hash === '#patient';
  byId('checklist-view').hidden = patient;
  byId('patient-view').hidden = !patient;
  document.title = `${appConfig.name} — ${patient ? 'передать пациенту' : 'памятка для ВОП'}`;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === (patient ? 'patient' : 'checklist')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (focus) {
    const heading = byId(patient ? 'patient-title' : 'page-title');
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  byId('toast').textContent = message;
  byId('toast').hidden = false;
  toastTimer = setTimeout(() => { byId('toast').hidden = true; }, 2800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'clipboard-fallback';
    document.body.append(area);
    area.select();
    let success = false;
    try { success = document.execCommand('copy'); } catch { /* Нативный fallback недоступен. */ }
    area.remove();
    return success;
  }
}

function renderBotLink() {
  const url = new URL(appConfig.botUrl);
  if (url.protocol !== 'https:' || url.hostname !== 't.me') throw new Error('Bot URL must point to Telegram over HTTPS');
  byId('open-bot-button').href = url.href;
  byId('bot-username').textContent = `@${appConfig.botUsername}`;

  if (typeof window.qrcode === 'function') {
    const code = window.qrcode(0, 'M');
    code.addData(url.href);
    code.make();
    byId('qr-code').innerHTML = code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
    const svg = byId('qr-code').querySelector('svg');
    svg.setAttribute('aria-hidden', 'true');
  } else {
    byId('qr-code').textContent = 'Используйте ссылку ниже';
  }
}

function setupDialogs() {
  byId('sources-list').innerHTML = clinicalSources.map(source => `
    <a class="source-item" href="${source.url}" target="_blank" rel="noopener noreferrer">
      <strong>${source.title} ↗</strong><span>${source.organization}</span>
    </a>`).join('');
  byId('bot-help-button').addEventListener('click', () => byId('bot-help-dialog').showModal());
  byId('guide-button').addEventListener('click', () => byId('guide-dialog').showModal());
  byId('sources-button').addEventListener('click', () => byId('sources-dialog').showModal());
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => byId(button.dataset.close).close());
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
  }
}

function setupInstall() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    byId('install-button').innerHTML = 'Установить памятку <span aria-hidden="true">↗</span>';
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; showToast('Памятка добавлена'); });
  byId('install-button').addEventListener('click', async () => {
    if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
      showToast('Памятка уже открыта как приложение');
    } else if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
    } else {
      if (/iPhone|iPad|iPod/.test(navigator.userAgent)) byId('install-instructions').textContent = 'В Safari нажмите «Поделиться», затем «На экран “Домой”». Если действие недоступно, продолжайте пользоваться сайтом в браузере.';
      byId('install-dialog').showModal();
    }
  });
}

renderChecklist();
renderBotLink();
setupDialogs();
setupInstall();
updateSelection();
updateRoute({ focus: false });

document.addEventListener('change', event => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const collection = input.name === 'observation' ? selected : input.name === 'safety' ? selectedSafety : null;
  if (!collection) return;
  if (input.checked) collection.add(input.value); else collection.delete(input.value);
  updateSelection();
});
byId('reset-button').addEventListener('click', () => {
  selected.clear(); selectedSafety.clear();
  for (const input of document.querySelectorAll('input[type=checkbox]')) input.checked = false;
  updateSelection();
  showToast('Отметки сняты');
});
byId('screening-button').addEventListener('click', navigateToPatient);
byId('manual-screening-button').addEventListener('click', navigateToPatient);
byId('back-button').addEventListener('click', () => { window.location.hash = 'checklist'; });
window.addEventListener('hashchange', () => updateRoute());
byId('copy-link-button').addEventListener('click', async () => {
  const ok = await copyText(appConfig.botUrl);
  byId('copy-link-status').textContent = ok ? 'Ссылка скопирована' : 'Выделите адрес ссылки и скопируйте его';
  if (ok) showToast('Ссылка на бота скопирована');
});
byId('copy-script-button').addEventListener('click', async () => {
  const ok = await copyText(byId('doctor-script').textContent);
  showToast(ok ? 'Текст для пациента скопирован' : 'Выделите текст и скопируйте его');
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {
      // Сайт остаётся доступным при невозможности включить офлайн-режим.
    });
  });
}

startViewport({ mainSelector: '#checklist-view:not([hidden]), #patient-view:not([hidden])', watchSelector: 'main', skip: el => el.id === 'checklist-view' && innerWidth >= 1000 && innerHeight >= 700 });

byId('compact-screening').addEventListener('click', navigateToPatient);
byId('compact-safety').addEventListener('click', () => revealViewportElement(byId('safety-section')));

byId('checklist-groups').addEventListener('click', event => { const id = event.target.closest('[data-info]')?.dataset.info; if (!id) return; const item = checklistGroups.flatMap(g => g.items).find(i => i.id === id); if (!item) return; byId('observation-title').textContent = item.title; byId('observation-description').textContent = item.description; byId('observation-dialog').showModal(); });

function openVopRecommendations() {
  const items=checklistGroups.flatMap(g=>g.items).filter(i=>selected.has(i.id)),v=buildVopConversation(items,selectedSafety.size>0);
  const panel=openRecommendations({key:'vop',title:'Рекомендации к беседе',description:'Подсказки по отметкам памятки. Работают без внешнего ИИ.',content:v.html+(v.script?'<button type="button" class="button button-primary" id="vop-copy-script">Скопировать объяснение пациенту</button>':'')});
  panel.querySelector('#vop-copy-script')?.addEventListener('click',async()=>showToast(await copyText(v.script)?'Объяснение скопировано':'Выделите текст и скопируйте его'));
}
byId('conversation-button').addEventListener('click',openVopRecommendations);
byId('recommendations-vop').addEventListener('click',openVopRecommendations);
byId('voice-vop-history').addEventListener('click',()=>{void openVoice({scope:'vop',endpoint:'/api/voice?scope=vop',ownerLabel:'Беседы ВОП',library:true,getContext:()=>({observations:[...selected],safety:[...selectedSafety]}),onError:text=>showToast(text)});});
byId('conversation-close').addEventListener('click',()=>byId('conversation-dialog').close());
byId('conversation-copy').addEventListener('click',async()=>{const text=byId('conversation-script')?.textContent;if(text)showToast(await copyText(text)?'Объяснение скопировано':'Выделите текст и скопируйте его');});

document.querySelector('#voice-vop-button').addEventListener('click', () => { void openVoice({ scope: 'vop', endpoint: '/api/voice?scope=vop', ownerLabel: 'Короткая беседа на приёме ВОП', getContext: () => ({ observations: [...selected], safety: [...selectedSafety] }), onError: text => alert(text) }); });

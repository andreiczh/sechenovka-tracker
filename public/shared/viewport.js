// A viewport-sized workspace with actual pagination. Existing form elements
// stay in their original forms; nothing is cloned, discarded or saved locally.
const positions = new Map();
const revealers = new WeakMap();
const transparent = '.home-grid,.two-col,.stack,.overview-grid,.detail-grid,.clinical-grid,.handoff-layout,.handoff-main,.question-shell,.settings-list,.checklist-main,.checklist-columns';
const pinned = '.page-heading,.lead-row,.detail-back,.patient-heading,.sync-line,.detail-tabs,.modal-head,.dialog-header,.back-button,.intro,.compact-actions';
const repeated = 'h1,h2,h3,legend,.group-title,thead,.card-head,.card-header,.roster-count,.question-window';
const noSplit = 'button,a,input,textarea,select,label,svg,img,hr,summary,.roster tr,.row,.form-row,.metric-grid,.score-comparison,.option-list,.number-options,.tab-switch,.range-labels';

function paginate(root, key) {
  let content = root.querySelector(':scope > .viewport-content');
  if (!content) {
    const head = document.createElement('div'); head.className = 'viewport-head';
    content = document.createElement('div'); content.className = 'viewport-content';
    const footer = document.createElement('div'); footer.className = 'viewport-footer';
    for (const child of [...root.children]) {
      if (child.matches(pinned)) head.append(child);
      else if (child.matches('.footer-note')) footer.append(child);
      else content.append(child);
    }
    root.replaceChildren(head, content, footer);
    root.classList.add('viewport-workspace');
  }
  root.querySelector(':scope > .viewport-controls')?.remove();
  for (const el of root.querySelectorAll('[data-viewport-hidden]')) el.removeAttribute('data-viewport-hidden');
  root.classList.toggle('viewport-single', root.matches('dialog') || Boolean(root.querySelector('.question-shell')) || root.id === 'patient-view');
  if (root.id === 'patient-view') {
    const aside = root.querySelector('.bot-panel');
    const sidebar = innerWidth >= 1000;
    root.classList.toggle('viewport-with-side', sidebar);
    if (aside) { if (sidebar) root.append(aside); else content.prepend(aside); }
  }
  const controls = document.createElement('nav');
  controls.className = 'viewport-controls'; controls.setAttribute('aria-label', 'Страницы раздела');
  controls.innerHTML = '<button type="button" class="viewport-prev" aria-label="Предыдущая часть">←</button><label><span class="sr-only">Часть раздела</span><select aria-label="Часть раздела"></select></label><span class="viewport-count" aria-live="polite"></span><button type="button" class="viewport-next" aria-label="Следующая часть">→</button>';
  root.insertBefore(controls, root.querySelector(':scope > .viewport-footer'));
  const height = content.clientHeight;
  if (height < 80) { controls.remove(); root.classList.add('viewport-fallback'); return; }
  root.classList.remove('viewport-fallback');
  const atoms = [];
  function collect(node) {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || getComputedStyle(node).display === 'none') return null;
    if (node.matches(transparent)) node.classList.add('viewport-transparent');
    if (!node.children.length && !node.textContent.trim() && !node.matches('input,textarea,select,img,svg,hr,button')) { node.setAttribute('data-viewport-hidden', ''); return null; }
    // Long textual summaries are paged by paragraph, including long notes.
    if (node.matches('pre,.summary-box,.summary-sheet,p') && !node.children.length && node.getBoundingClientRect().height > height / 2) {
      const text = node.textContent;
    const parts = text.match(/[\s\S]{1,450}(?:\s|$)|[\s\S]{1,450}/g) || [text];
      node.replaceChildren(...parts.map(text => { const span = document.createElement('span'); span.className = 'viewport-paragraph'; span.textContent = text; return span; }));
    }
    const children = [...node.children];
    const split = children.length && !node.matches(noSplit) && (node.matches(transparent) || node.getBoundingClientRect().height > Math.max(70, height / 2));
    if (!split) { const item = { node, index: atoms.length }; atoms.push(item); return item; }
    const branch = { node, children: [] };
    for (const child of children) {
      if (child.matches(repeated)) continue;
      const item = collect(child); if (item) branch.children.push(item);
    }
    // A node consisting only of headings is still content.
    if (!branch.children.length) { const item = { node, index: atoms.length }; atoms.push(item); return item; }
    return branch;
  }
  const tree = [...content.children].map(collect).filter(Boolean);
  function show(start, end) {
    function visit(item) {
      const visible = item.children ? item.children.map(visit).some(Boolean) : item.index >= start && item.index <= end;
      if (visible) item.node.removeAttribute('data-viewport-hidden'); else item.node.setAttribute('data-viewport-hidden', '');
      return visible;
    }
    tree.forEach(visit);
  }
  const pages = [];
  let start = 0;
  for (let end = 0; end < atoms.length; end++) {
    show(start, end);
    if (end > start && content.scrollHeight > height + 2) { pages.push([start, end - 1]); start = end; }
  }
  if (atoms.length) pages.push([start, atoms.length - 1]);
  if (!pages.length) pages.push([0, -1]);
  const select = controls.querySelector('select'), previous = controls.querySelector('.viewport-prev'), next = controls.querySelector('.viewport-next');
  pages.forEach(([a], index) => {
    const node = atoms[a]?.node;
    const section = node?.closest('.card,.bot-panel,.objections') || node;
    const title = section?.querySelector('h2,h3,legend')?.textContent || node?.querySelector?.('h2,h3')?.textContent || (node?.matches('tr') ? 'Таблица' : root.querySelector('.viewport-head h1,.viewport-head h2')?.textContent || 'Обзор');
    const option = document.createElement('option'); option.value = index; option.textContent = `${index + 1}. ${title.slice(0, 65)}`; select.append(option);
  });
  function display(index, focus = false) {
    index = Math.max(0, Math.min(pages.length - 1, index)); positions.set(key, index);
    show(...pages[index]); select.value = index;
    previous.disabled = index === 0; next.disabled = index === pages.length - 1;
    controls.querySelector('.viewport-count').textContent = `${index + 1} / ${pages.length}`;
    root.dataset.viewportPages = pages.length; root.dataset.viewportPage = index + 1;
    // Never make an oversized element inaccessible. Small landscape screens or
    // accessibility zoom retain a scroll fallback rather than clipping fields.
    root.classList.toggle('viewport-overflow', content.scrollHeight > height + 2);
    if (focus) { content.tabIndex = -1; content.focus({ preventScroll: true }); }
  }
  const activeAtom = atoms.findIndex(item => item.node.contains(document.activeElement));
  const activePage = activeAtom >= 0 ? pages.findIndex(([a, b]) => activeAtom >= a && activeAtom <= b) : -1;
  display(activePage >= 0 ? activePage : positions.get(key) || 0);
  previous.onclick = () => display(Number(select.value) - 1, true);
  next.onclick = () => display(Number(select.value) + 1, true);
  select.onchange = () => display(Number(select.value));
  // Required fields stay inside their form, even on another screen.
  const reveal = target => {
    const index = atoms.findIndex(item => item.node.contains(target) || target.contains(item.node));
    const page = pages.findIndex(([a, b]) => index >= a && index <= b);
    if (page >= 0) display(page);
  };
  revealers.set(root, reveal);
  if (!root.dataset.viewportValidation) {
    root.dataset.viewportValidation = 'true';
    root.addEventListener('invalid', event => revealers.get(root)?.(event.target), true);
  }
  return controls;
}

export function revealViewportElement(element) { if (element) { revealers.get(element.closest('.viewport-workspace'))?.(element); element.focus({ preventScroll: true }); } }

function restore(root) {
  const head = root.querySelector(':scope > .viewport-head'), content = root.querySelector(':scope > .viewport-content'), footer = root.querySelector(':scope > .viewport-footer');
  if (!head || !content || !footer) return;
  root.replaceChildren(...head.children, ...content.children, ...footer.children);
  root.classList.remove('viewport-workspace', 'viewport-single', 'viewport-overflow', 'viewport-with-side');
  for (const node of root.querySelectorAll('[data-viewport-hidden]')) node.removeAttribute('data-viewport-hidden');
  for (const node of root.querySelectorAll('.viewport-transparent')) node.classList.remove('viewport-transparent');
}

export function startViewport({ mainSelector = 'main.main', watchSelector = '#app', skip = () => false } = {}) {
  let queued = false, running = false;
  const watch = document.querySelector(watchSelector) || document.body;
  const observer = new MutationObserver(records => {
    if (records.some(record => !(record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest('.viewport-controls,#unsaved-note,#sync-status'))) schedule();
  });
  const observed = () => {
    observer.observe(watch, { childList: true, subtree: true });
    for (const dialog of document.querySelectorAll('dialog')) observer.observe(dialog, { childList: true, subtree: true });
  };
  function layout() {
    queued = false; if (running) return; running = true; observer.disconnect();
    try {
      const main = document.querySelector(mainSelector);
      if (main && !skip(main)) paginate(main, `${location.pathname}:${location.hash}`);
      else if (main?.classList.contains('viewport-workspace')) restore(main);
      for (const dialog of document.querySelectorAll('dialog')) {
        if (!dialog.open) { if (dialog.classList.contains('viewport-workspace')) restore(dialog); continue; }
        if (dialog.classList.contains('viewport-workspace') || dialog.scrollHeight > dialog.clientHeight + 2) paginate(dialog, `dialog:${dialog.id}`);
      }
    } finally { running = false; observed(); }
  }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(layout); } }
  observed(); schedule(); document.fonts?.ready.then(schedule);
  window.addEventListener('resize', schedule); window.addEventListener('hashchange', schedule);
  document.addEventListener('toggle', schedule, true);
  document.addEventListener('beforetoggle', () => { positions.delete(`dialog:${document.querySelector('dialog[open]')?.id}`); schedule(); }, true);
  return schedule;
}

import { overviewModel, meetingQuestions, initialWorkspaceMode } from './overview-model.js';
import { openRecommendations, closeRecommendations, recommendationsOpen } from '/shared/recommendations.js';
import { openVoice, voiceButton, voiceNotesSection, enhanceVoiceFields, closeVoice } from '/shared/voice-ui.js';
import { startViewport, revealViewportElement } from '/shared/viewport.js';
import { requestJSON, escapeHtml as h, dateLabel, numericDate, numberLabel as n, icon } from '/shared/client.js';
import { FORMS, FREQUENCY, FUNCTION_LABELS } from '/shared/clinical.js';
import { renderDoctorSupport } from '/shared/support-ui.js';

const app = document.querySelector('#app'), modal = document.querySelector('#modal');
const tabs = [['overview', 'Обзор', 'today'], ['assessments', 'Анкеты', 'results'], ['diary', 'Дневник', 'diary'], ['dynamics', 'Динамика', 'dynamics'], ['plan', 'Приём', 'visit']];
const metricLabels = { mood: 'Настроение', anxiety: 'Тревога', sleep: 'Сон', function: 'Обычные дела' };
let roster = [], patient = null, loading = false, busy = false, loadVersion = 0, lastSync = null, syncError = false;
let rosterPage=0;
let query = '', filter = 'all', sort = 'appointment', metric = 'mood', assessmentId = null, selectedDay = null;
const therapyDrafts = new Map();
const formDrafts = new Map(), presented = new Set();
const draftKey = p => `${p.id}:${p.episodeId}`;
let toastTimer;
let clinicSession = null, workspaceMode = 'demo';
let aiBusy = false, aiError = '';
const apiBase = () => workspaceMode === 'clinic' ? '/api/clinic/patients' : '/api/clinician/patients';
function clearPrivateView() { closeRecommendations(); void closeVoice(); loadVersion++; loading = false; aiError = ''; document.querySelector('#request-status').hidden = true; patient = null; roster = []; formDrafts.clear(); therapyDrafts.clear(); presented.clear(); if (modal.open) modal.close(); }
function loginPage() {
  return `<main class="clinic-login"><a class="brand" href="/"><img src="/icons/mark.svg" alt="" width="36" height="36"><span>Трекер Сеченовка</span></a><section class="card"><div class="eyebrow">Кабинет психиатра</div><h1>Подключённые профили</h1><p>Войдите, чтобы увидеть тестовые анкеты, дневник и динамику из бота и Mini App.</p><form id="clinic-login-form"><label class="form-field">Ключ доступа<input type="password" name="key" autocomplete="off" required placeholder="Ключ учебного кабинета"></label><p id="login-error" class="sync-error" role="alert"></p><button class="button" type="submit">Войти в кабинет</button></form><p class="small muted">Вводите только вымышленные данные. Сеанс длится до 12 часов. Медицинское наблюдение в реальном времени не организовано.</p><button class="text-link" data-action="demo-workspace">Посмотреть готовые примеры →</button></section></main>`;
}
function authExpired() { clinicSession = { ...clinicSession, authenticated: false }; clearPrivateView(); render(); }
const pathFor = (id, tab = 'overview') => `#/patient/${encodeURIComponent(id)}/${tab}`;
const route = () => {
  const match = /^#\/patient\/([a-z0-9-]+)\/(overview|assessments|diary|dynamics|plan|summary|support|voice)$/.exec(location.hash);
  return match ? { id: match[1], tab: match[2] } : { id: null, tab: 'patients' };
};
const when = value => value ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(value)) + ' МСК' : 'нет данных';
const initials = p => p.identity.name.split(' ').slice(0, 2).map(v => v[0]).join('');
const source = text => `<span class="source-label">${h(text)}</span>`;
const notice = (title, text, red = false) => `<div class="notice${red ? ' red' : ''}"><strong>${h(title)}</strong><div>${text}</div></div>`;
const empty = (title, text) => `<div class="empty-state"><h2>${h(title)}</h2><p>${h(text)}</p></div>`;
const signed = value => value === null ? '—' : (value > 0 ? '+' : '') + value;
const delta = value => value === null ? '<span class="delta">нет пары для сравнения</span>' : `<span class="delta ${value < 0 ? 'down' : value > 0 ? 'up' : ''}">${h(signed(value))} к исходной точке</span>`;
const button = (label, action, secondary = true, extra = '') => `<button type="button" class="button${secondary ? ' secondary' : ''}" data-action="${action}" ${extra}>${label}</button>`;
const field = (label, value, extra = '') => `<div><dt>${h(label)}</dt><dd${value === null ? ' class="unknown-value"' : ''}>${h(value ?? 'Не собиралось')}${extra}</dd></div>`;
function toast(text, error = false) {
  const el = document.querySelector('#toast'); clearTimeout(toastTimer); el.textContent = text; el.classList.toggle('error', error); el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 8000 : 4500);
}
function showModal(title, content) {
  modal.innerHTML = `<div class="modal-head"><h2 id="modal-title">${h(title)}</h2><button type="button" class="close" data-action="close-modal" aria-label="Закрыть">×</button></div>${content}`;
  if (!modal.open) modal.showModal();
}
modal.addEventListener('click', event => {
  if (event.target.closest('a[href^="#/patient/"]')) modal.close();
});
function coverage(p) {
  if (!p.stats.expected) return 'Период ещё не начат';
  return `${p.stats.recorded} из ${p.stats.expected} дней`;
}
function render() {
  if (!clinicSession) { app.innerHTML = '<main class="loading"><p>Открываем кабинет…</p></main>'; return; }
  if (workspaceMode === 'clinic' && !clinicSession.authenticated) { app.innerHTML = loginPage(); return; }
  const r = route();
  document.title = `${r.id && patient ? patient.identity.name : 'Пациенты'} — Трекер Сеченовка`;
  app.innerHTML = `<div class="shell"><div class="main-shell"><header class="topbar"><a class="mobile-brand brand" href="#/patients"><img src="/icons/mark.svg" alt=""><span>Трекер Сеченовка</span></a><span class="workspace-label">Кабинет психиатра <small class="workspace-mode">${workspaceMode==='clinic'?'Подключённые профили':'Готовые профили'}</small></span><div class="topbar-right"><details class="workspace-menu"><summary>Меню</summary><div><a href="#/patients">Все пациенты</a><button data-action="${workspaceMode==='clinic'?'demo-workspace':'clinic-workspace'}">${workspaceMode==='clinic'?'Готовые профили':'Подключённые профили'}</button>${workspaceMode==='demo'?'<a href="#/patient/live/overview">Профиль этого браузера</a>':''}<a href="/patient/">Миниапп пациента</a><a href="/">Памятка ВОП</a><button data-action="about">О демонстрации</button></div></details>${workspaceMode==='clinic'?button('Выйти','clinic-logout'):button('Подключённые профили','clinic-workspace')}</div></header><main id="main" class="main" tabindex="-1">${loading && !patient && r.id ? empty('Открываем карточку…', 'Загружаем сохранённые данные.') : r.id ? patient && patient.id === r.id ? detail(r.tab) : empty('Карточка недоступна', 'Вернитесь к списку или обновите страницу.') + `<a class="button secondary" href="#/patients">К пациентам</a>` : listPage()}</main></div></div>`;
  if (r.tab === 'plan' || r.tab === 'support') { const review = document.querySelector('#review-card'); if (review) review.parentElement.prepend(review); }
  if (busy) document.querySelectorAll('button[data-action="save-draft"],button[data-action="confirm-plan"],button[data-action="viewed"]').forEach(el => { el.disabled = true; });
  structureClinicPanels(r.tab);
  enhanceVoiceFields(app, extra => openDoctorVoice(extra));
  if (r.tab === 'support' || recommendationsOpen('doctor')) showDoctorRecommendations();
  logPresented();
}
function listPage() {
  const safetyCount = roster.filter(p => p.needs.some(f => f.code === 'safety-question')).length;
  const lowData = roster.filter(p => p.draft || p.daysAgo >= 3 || !p.lastScores || p.stats.missing > 0).length;
  return `<div class="lead-row"><div class="page-heading"><div class="eyebrow">Пациенты и наблюдение</div><h1 tabindex="-1">${workspaceMode==='demo'?'Готовые профили':'Пациенты'}</h1><p>Анкеты, дневник и голосовые записи к приёму.</p></div>${button('Обновить данные', 'refresh')}</div><div class="stat-strip"><div class="stat-tile"><span>${workspaceMode==='clinic'?'Подключённых профилей':'Готовых профилей'}</span><strong>${roster.length}</strong></div><div class="stat-tile"><span>Есть повторные анкеты</span><strong>${roster.filter(p => p.delta.phq !== null).length}</strong></div><div class="stat-tile rose"><span>Ответы о безопасности для уточнения</span><strong>${safetyCount}</strong></div><div class="stat-tile"><span>Неполные или давние данные</span><strong>${lowData}</strong></div></div><form class="toolbar" id="roster-form"><label>Поиск по имени или коду<input type="search" id="patient-search" placeholder="Имя, фамилия или ТС-1024" value="${h(query)}" autocomplete="off"></label><label>Показать<select id="patient-filter">${[['all','Все пациенты'],['safety','Ответы о безопасности'],['incomplete','Незавершённые анкеты'],['missing','Есть пропуски дневника'],['repeat','Есть повторные анкеты'],['confirmed','Подтверждён план']].map(([v,t]) => `<option value="${v}" ${v === filter ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label>Порядок<select id="patient-sort">${[['appointment','По дате контакта'],['freshness','Сначала давние данные'],['name','По имени']].map(([v,t]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${t}</option>`).join('')}</select></label></form><section class="card roster-card" aria-label="Список пациентов"><div class="roster-count"><span id="roster-count"></span><span>Баллы разных шкал не суммируются</span><div class="roster-paging"><button type="button" data-action="roster-prev" aria-label="Предыдущие профили">←</button><button type="button" data-action="roster-next" aria-label="Следующие профили">→</button></div></div><div id="roster-results">${rosterRows()}</div></section>`;
}
function shortFlag(f,p) {
  return ({'safety-question':'Уточнить безопасность','unfinished':'Анкета не завершена','stale':'Данные устарели','missing-days':p.stats.missing+' пропусков','reported-worse':'Пациент отметил ухудшение','report-activation':'Уточнить активность и сон','report-new-effect':'Новые неприятные явления','report-contact-due':'Срок контакта'})[f.code]||f.text;
}
function filteredRoster() {
  return roster.filter(p => `${p.identity.name} ${p.identity.code}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru').trim()))
    .filter(p => filter === 'all' || filter === 'safety' && p.needs.some(f => f.code === 'safety-question') || filter === 'incomplete' && p.draft || filter === 'missing' && p.stats.missing > 0 || filter === 'repeat' && p.delta.phq !== null || filter === 'confirmed' && p.reviewStatus === 'План подтверждён в демо')
    .sort((a,b) => sort === 'name' ? a.identity.name.localeCompare(b.identity.name, 'ru') : sort === 'freshness' ? (b.daysAgo ?? 999) - (a.daysAgo ?? 999) : (a.appointment.date || '9999').localeCompare(b.appointment.date || '9999') || (a.appointment.time || '').localeCompare(b.appointment.time || ''));
}
function rosterRows() {
  const size=innerWidth<600?1:innerWidth<1000?2:Math.max(2,Math.min(5,Math.floor((innerHeight-390)/80)));const all=filteredRoster();rosterPage=Math.max(0,Math.min(rosterPage,Math.max(0,Math.ceil(all.length/size)-1)));const rows=all.slice(rosterPage*size,rosterPage*size+size);
  queueMicrotask(() => { const prev=document.querySelector('[data-action=roster-prev]'),next=document.querySelector('[data-action=roster-next]'),pager=document.querySelector('.roster-paging');if(pager)pager.hidden=all.length<=size;if(prev)prev.disabled=rosterPage===0;if(next)next.disabled=(rosterPage+1)*size>=all.length;const el = document.querySelector('#roster-count'); if (el) el.textContent = `Показано ${rows.length?rosterPage*size+1:0}–${rosterPage*size+rows.length} из ${all.length}`; });
  if (!rows.length) return empty(roster.length ? 'Никого не найдено' : 'Подключённых профилей пока нет', roster.length ? 'Измените имя или код, выберите другой фильтр.' : 'В боте: /doctor → /share. В Mini App: «К приёму» → «Передать тестовый профиль». После согласия пациента анкеты и дневник появятся здесь автоматически.');
  return `<table class="roster"><thead><tr><th>Пациент</th><th>Последние анкеты</th><th>Дневник</th><th>Наблюдение</th><th>Следующий контакт</th><th><span class="sr-only">Открыть карточку</span></th></tr></thead><tbody>${rows.map(p => `<tr data-patient="${p.id}"><td><div class="patient-name"><span class="patient-avatar">${h(initials(p))}</span><div><strong>${h(p.identity.name)}</strong><span class="subtle-label">${h(p.identity.code)} · ${p.identity.age ? p.identity.age + ' лет' : '18+'}${p.live ? ' · связан с миниаппом' : ''}</span></div></div>${p.voiceCount?`<a class="roster-voice" href="${pathFor(p.id,'voice')}">${icon('diary')}${p.voiceCount} голосовые записи →</a>`:''}</td><td data-label="Последние анкеты">${p.lastScores ? `<span class="score-inline">${p.lastScores.phq.score}<small> /27 PHQ-9</small></span><span class="score-inline">${p.lastScores.gad.score}<small> /21 GAD-7</small></span><span class="subtle-label">${h(dateLabel(p.lastAssessmentDate))}</span>` : `<span>${p.draft ? `Черновик: ${p.draft.phq}/9 и ${p.draft.gad}/7` : 'Ещё нет'}</span><span class="subtle-label">Суммы не рассчитаны</span>`}</td><td data-label="Дневник">${h(coverage(p))}<div class="coverage-bar"><div class="coverage-segments">${Array.from({length:p.stats.expected},(_,i)=>`<span class="${i < p.stats.recorded ? '' : 'blank'}"></span>`).join('')}</div></div><span class="subtle-label">${p.latestAt ? `${p.daysAgo === 0 ? 'Сегодня' : p.daysAgo + ' дн. назад'} · последние данные` : 'Записей пока нет'}</span></td><td data-label="Наблюдение"><div class="flag-list">${p.needs.filter(f=>f.code!=='voice-note').slice(0,2).map(f=>`<span class="flag ${f.tone}" title="${h(f.text)}">${h(shortFlag(f,p))}</span>`).join('') || '<span class="flag">Данные доступны для беседы</span>'}</div><span class="subtle-label">${h(p.reviewStatus)}</span></td><td data-label="Следующий контакт">${p.appointment.date ? `${h(dateLabel(p.appointment.date))} · ${h(p.appointment.time)}` : 'Не указан'}<span class="subtle-label">${p.appointment.confirmed ? 'Из демоплана врача' : 'Со слов пациента'}</span></td><td><a class="roster-open" href="${pathFor(p.id)}" aria-label="Открыть: ${h(p.identity.name)}">Открыть →</a></td></tr>`).join('')}</tbody></table>`;
}
function detail(tab) {
  const p=patient,visitTab=['plan','voice','summary','support'].includes(tab),active=visitTab?'plan':tab;
  const visitNav=visitTab?`<nav class="visit-subnav" aria-label="Работа на приёме">${[['plan','Подготовка и план'],['voice','Записи бесед'],['summary','Сводка и экспорт']].map(([id,label])=>`<a href="${pathFor(p.id,id)}" ${(tab==='support'?'plan':tab)===id?'aria-current="page"':''}>${label}</a>`).join('')}</nav>`:'';
  return `<a class="text-link detail-back" href="#/patients">${icon('back')}Все пациенты</a><div class="patient-heading"><div class="identity-line"><span class="patient-avatar">${h(initials(p))}</span><div><h1 tabindex="-1">${h(p.identity.name)}</h1><div class="patient-meta">${h(p.identity.code)} · ${p.identity.age?p.identity.age+' лет':'18+'} · ${h(p.stage)}${p.safety.needsClarification?' · Уточнить безопасность':''}</div></div></div><div class="row">${voiceButton('Записать беседу')}${button('Рекомендации','open-recommendations')}${button('↻','refresh',true,'aria-label="Обновить" title="Обновить данные"')}</div></div><div class="sync-line"><span>Последние данные: <strong>${p.latestAt?h(when(p.latestAt)):'ещё не поступили'}</strong> · ${h(coverage(p))}${p.stats.baselineRecorded?' + день 0':''}</span><span class="${syncError?'sync-error':''}" id="sync-status">${syncError?'Не удалось обновить. Показаны сохранённые данные.':`Загружено ${lastSync?new Intl.DateTimeFormat('ru',{hour:'2-digit',minute:'2-digit'}).format(lastSync):'сейчас'}`}</span></div><nav class="detail-tabs" aria-label="Разделы карточки">${tabs.map(([id,label,i])=>`<a href="${pathFor(p.id,id)}" ${active===id?'aria-current="page"':''}>${icon(i)}${label}</a>`).join('')}</nav>${visitNav}${p.dataChangedSinceReview?'<div class="profile-status">После подтверждения появились новые данные. Прежняя запись сохранена; проверьте изменения перед решением.</div>':''}${({voice:()=>voiceNotesSection(p.voiceNotes||[],true),overview,assessments,diary,dynamics,plan,summary,support:plan}[tab])()}`;
}
function showDoctorRecommendations() {
  if(!patient)return;
  const recommendationPatientId=patient.id;
  const panel=openRecommendations({key:'doctor',title:'Рекомендации к приёму',description:patient.identity.name+' · '+patient.identity.code+'. Подсказки и лекарственная справка; решения принимает врач.',content:renderDoctorSupport(patient,therapyDrafts.get(draftKey(patient))?.values),closed:()=>{captureTherapy();if(route().tab==='support'&&route().id===recommendationPatientId)location.hash=pathFor(recommendationPatientId,'plan');}});
  enhanceVoiceFields(panel,extra=>openDoctorVoice(extra));
  void logPresented('support');
}

function safetyCard(p) {
  const answer = p.safety.phq9;
  return `<section class="card"><div class="card-head"><h2>Ответы о безопасности</h2>${p.safety.needsClarification ? '<span class="pill red">Уточнить при контакте</span>' : ''}</div><dl class="fact-list">${field('Последний пункт 9 PHQ-9', answer === null ? 'Ответа пока нет' : `${answer}/3 · ${FREQUENCY[answer]}`)}${field('Дополнительный ответ', p.safety.events.length ? p.safety.events.map(e => `${dateLabel(e.at)}: ${e.level === 'contact' ? '«Сейчас нет»' : e.level === 'urgent' ? '«Да / не уверен(а)»' : '«Не хочу отвечать»'}`).join('\n') : 'Отдельного ответа нет')}${field('Запись врача', p.safety.clinicianNote || p.safety.currentAssessment)}</dl><p class="small muted section-gap">Ответ на один пункт и сумма анкеты не определяют уровень риска. «Сейчас нет» и отсутствие записи не исключают риск; нужна клиническая беседа.</p>${source('Исходные ответы сохранены. Открытие карточки не считается оценкой безопасности.')}</section>`;
}
function scoreCards(p) {
  const first=p.assessments[0],last=p.assessments.at(-1);
  return `<div class="score-pair">${['phq','gad'].map(kind=>`<section class="clinical-score"><h3>${FORMS[kind].name}</h3><div class="domain">${FORMS[kind].domain}</div>${last ? `<span class="big-number">${last.scores[kind].score}</span><span class="max">/ ${FORMS[kind].max}</span><div class="score-label">${h(last.scores[kind].label)}</div><div class="score-baseline">${h(dateLabel(last.date))} · ${last.mode==='baseline'?'исходная':'повторная'}<br>${first !== last ? `Исходно ${first.scores[kind].score} · ${h(dateLabel(first.date))}<br>${delta(p.delta[kind])}` : 'Повтора пока нет'}</div>` : `<p>Нет итогового результата</p><span class="subtle-label">${p.draft ? `${p.draft.scores[kind].answered}/${FORMS[kind].items.length} ответов · черновик` : 'Анкеты не начаты'}</span>`}</section>`).join('')}</div>`;
}
function overview() {
  const p=patient,m=overviewModel(p),last=m.lastDiary;
  const score=(kind,title,max)=>{
    const v=m.scores.find(s=>s.kind===kind);
    return `<a class="dashboard-stat" href="${pathFor(p.id,'assessments')}"><span>${title}</span><strong>${v.value===null?'—':v.value}<small> / ${max}</small></strong><span>${v.date?h(dateLabel(v.date)):'Нет завершённой анкеты'} · ${delta(v.delta)}</span></a>`;
  };
  const metricBox=(title,value,unit,caption)=>`<div class="dashboard-stat"><span>${title}</span><strong>${value===null||value===undefined?'—':h(n(value))}<small>${unit}</small></strong><span>${h(caption)}</span></div>`;
  const flags=p.needs.filter(f=>f.code!=='missing-days');
  return `<div class="clinical-dashboard${m.safetyNeedsClarification||flags.some(f=>f.tone==='red')?' has-priority':''}" data-screen-panel="Обзор">
    <div class="dashboard-flags">
    ${m.safetyNeedsClarification?`<div class="dashboard-alert"><strong>Уточнить безопасность при контакте</strong><span>Пункт 9 PHQ-9: ${m.safetyAnswer===null?'нет ответа':m.safetyAnswer+'/3'}. Ответ требует отдельной беседы.</span><a href="${pathFor(p.id,'plan')}">Открыть запись →</a></div>`:''}
    ${flags.some(f=>f.tone==='red'&&f.code!=='safety-question')?`<div class="dashboard-alert"><strong>${h(flags.filter(f=>f.tone==='red'&&f.code!=='safety-question').map(f=>f.text).join(' · '))}</strong><a href="${pathFor(p.id,'dynamics')}">Проверить данные →</a></div>`:''}
    </div>
    <div class="dashboard-stats">${score('phq','PHQ-9 · депрессивные симптомы',27)}${score('gad','GAD-7 · тревожные симптомы',21)}${metricBox('Дневник',p.stats.expected?p.stats.recorded:null,p.stats.expected?' / '+p.stats.expected+' дней':'',p.stats.expected?p.stats.missing+' дней без записи':'Наблюдение ещё не начато')}${metricBox('Сон · среднее',p.stats.sleep,' ч',p.stats.sleepCount+' числовых ответов')}</div>
    <div class="dashboard-main">
      <section class="card dashboard-trend"><div class="card-head"><h2>Самочувствие по дням</h2><a class="text-link" href="${pathFor(p.id,'dynamics')}">Динамика →</a></div>${overviewChart(p)}<div class="dashboard-legend"><span><i></i>Настроение · выше лучше</span><span><i class="anxiety"></i>Тревога · выше сильнее</span></div><p class="small muted">0–10 · разрывы — нет ответа. Пропуски не заполнены нулями.</p><div class="dashboard-inline"><span>Среднее настроение <b>${n(p.stats.mood)}</b></span><span>Средняя тревога <b>${n(p.stats.anxiety)}</b></span><span>${m.recordCount?`Сильно мешало делам <b>${m.functionDifficult} из ${m.recordCount}</b> записей`:'Влияние на дела: нет дневных записей'}</span></div></section>
      <section class="card dashboard-questions"><div class="card-head"><h2>К встрече с пациентом</h2>${button('Все рекомендации','open-recommendations')}</div><ol>${m.questions.slice(0,3).map(q=>`<li>${h(q.brief||q.text)}</li>`).join('')}</ol><div class="dashboard-contact"><span>Следующий контакт</span><strong>${p.appointment.date?h(dateLabel(p.appointment.date))+(p.appointment.time?' · '+h(p.appointment.time):''):'Дата не указана'}</strong><span>${h(p.appointment.source)}</span></div><div class="dashboard-links"><a class="text-link" href="${pathFor(p.id,'plan')}">Краткая сводка и запись →</a><button type="button" class="text-link dashboard-context-button" data-action="overview-context">Контекст и заметки →</button></div></section>
    </div>
    <div class="dashboard-bottom"><div><span class="dashboard-label">Что хочет обсудить</span><p>${h(p.context?.goal||p.appointment.question||p.referral.reason||'Не указано')}</p><span class="small muted">Со слов пациента · ${h(p.context?.duration||'Длительность не уточнена')}</span></div><div><span class="dashboard-label">Последняя дневная запись${last?' · '+h(dateLabel(last.date)):''}</span><p>${h(last?.note||'Свободной заметки нет')}</p><span class="small muted">${last?'Настроение '+last.mood+'/10 · тревога '+last.anxiety+'/10 · '+FUNCTION_LABELS[last.function]:'Дневник пока не заполнен'}</span></div><div class="dashboard-review"><span class="dashboard-label">Обратить внимание</span><p>${h(flags.filter(f=>f.code!=='safety-question').slice(0,2).map(f=>f.text).join(' · ')||'Проверить актуальность сведений при контакте')}</p>${button(p.review.viewedAt?'Просмотр отмечен':'Отметить просмотр','viewed')}</div></div>
  </div>`;
}
function overviewChart(p) {
  const rows=p.days.filter(d=>!d.future),W=640,H=140,L=24,R=14,T=12,B=26;
  if(!rows.some(d=>d.entry))return '<div class="dashboard-empty">График появится после первой дневной записи.</div>';
  const x=i=>L+(rows.length<2?(W-L-R)/2:i/(rows.length-1)*(W-L-R));
  const y=v=>T+(10-v)/10*(H-T-B);
  const series=(key,color)=>{
    const segments=[];let current=[];
    rows.forEach((d,i)=>{if(Number.isFinite(d.entry?.[key]))current.push([x(i),y(d.entry[key])]);else if(current.length){segments.push(current);current=[];}});
    if(current.length)segments.push(current);
    return segments.map(a=>`<polyline fill="none" stroke="${color}" stroke-width="2" points="${a.map(v=>v.join(',')).join(' ')}"/>`).join('')+rows.map((d,i)=>Number.isFinite(d.entry?.[key])?`<circle cx="${x(i)}" cy="${y(d.entry[key])}" r="3" fill="${color}"><title>${h(dateLabel(d.date))}: ${key==='mood'?'настроение':'тревога'} ${d.entry[key]}/10</title></circle>`:'').join('');
  };
  return `<svg class="dashboard-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Настроение и тревога по дням, 0–10. Пропуски оставлены разрывами.">${[0,5,10].map(v=>`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#e4ebe5"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end">${v}</text>`).join('')}${series('mood','#416d57')}${series('anxiety','#af7060')}${[...new Set([0,Math.floor((rows.length-1)/2),rows.length-1])].map(i=>`<text x="${x(i)}" y="${H-4}" text-anchor="middle">${h(numericDate(rows[i].date))}</text>`).join('')}</svg>`;
}

// Deliberate content sections replace the old automatic fragments. Nothing is
// cloned: original fields, forms, exports and delegated actions remain intact.
function structureClinicPanels(tab) {
  const main=document.querySelector('main.main');if(!main)return;
  const panel=(label,...nodes)=>{const el=document.createElement('div');el.dataset.screenPanel=label;el.className='clinic-panel';el.append(...nodes.filter(Boolean));return el;};
  if(tab==='overview')return;
  if(tab==='assessments'){
    const card=main.querySelector(':scope>.card');if(!card)return;
    const toolbar=card.querySelector('.assessment-selector');toolbar.classList.add('assessment-toolbar');main.insertBefore(toolbar,card);
    const nodes=[...card.children];
    for(const node of nodes){if(node.querySelector('.answer-table'))main.insertBefore(panel(node.querySelector('h2').textContent.split(' · ')[0],node),card);}
    const rest=[...card.children];if(rest.length)main.insertBefore(panel('Источник и ограничения',...rest),card);card.remove();return;
  }
  if(tab==='diary'){
    const grid=main.querySelector(':scope>.detail-grid');if(grid)grid.dataset.screenPanel='Календарь и заметки';
    const table=main.querySelector(':scope>.card:has(.daily-table)');if(table)table.dataset.screenPanel='Все записи';return;
  }
  if(tab==='dynamics'){
    const labels=['Самочувствие','Анкеты','Недели','События','Таблица'];
    const nodes=[...main.children].filter(n=>n.matches('.card,.two-col'));
    nodes.forEach((node,i)=>{node.dataset.screenPanel=labels[i]||'Данные';if(i===0)node.dataset.fitPanel='chart';if(i===1)node.dataset.fitPanel='comparison';});return;
  }
  if(tab==='plan'||tab==='support'){
    const grid=main.querySelector(':scope>.detail-grid');if(!grid)return;
    const review=grid.querySelector('#review-card');
    const brief=document.createElement('div');brief.innerHTML=aiSummary(patient);const intro=panel('Краткая сводка',...brief.children);
    const record=panel('Запись и план',review);
    const cards=[...grid.querySelectorAll('.card')];
    const context=panel('Контекст и история',...cards);
    main.insertBefore(intro,grid);main.insertBefore(record,grid);main.insertBefore(context,grid);grid.remove();return;
  }
  const nodes=[...main.children].filter(n=>!n.matches('.detail-back,.patient-heading,.sync-line,.profile-status,.detail-tabs,.visit-subnav,.lead-row,.page-heading,.footer-note'));
  if(nodes.length){const first=nodes[0],wrapper=panel(tab==='summary'?'Полная сводка':tab==='voice'?'Записи бесед':'Пациенты');main.insertBefore(wrapper,first);wrapper.append(...nodes);}
}
function lastNotes(p) {
  const rows=p.diary.filter(e=>e.note).slice(-3).reverse();
  return rows.length ? `<ul class="timeline-list section-gap">${rows.map(e=>`<li><time>${h(dateLabel(e.date))}${e.retrospective?' · внесено позже':''}</time>${h(e.note)}${source('Заметка пациента')}</li>`).join('')}</ul>` : '<p class="small muted section-gap">Свободных заметок пока нет. Это не означает, что важных событий не было.</p>';
}
function assessments() {
  const p=patient, records=[...p.assessments,...(p.draft?[p.draft]:[])];
  const selected=records.find(a=>a.id===assessmentId)||records.at(-1), first=p.assessments[0];
  if(!selected) return `<section class="card">${empty('Анкет пока нет','После завершения скрининга здесь появятся суммы, окно оценки и все исходные ответы.')}<a class="button secondary" href="/patient/">Открыть миниапп</a></section>`;
  assessmentId=selected.id;
  return `<section class="card"><div class="assessment-selector"><label>Измерение<select id="assessment-select">${records.map(a=>`<option value="${h(a.id)}" ${a.id===selected.id?'selected':''}>${a.draft?'Черновик':a.mode==='baseline'?'Исходные анкеты':'Повторные анкеты'} · ${h(dateLabel(a.date))}</option>`).join('')}</select></label><p class="small muted">${selected.draft?'Анкета не завершена. Сумма не считается до заполнения всех пунктов шкалы.':'Самоотчёт пациента. Каждый пункт 0–3, суммы шкал рассчитываются отдельно.'}</p></div>${selected.draft?notice('Сохранённый черновик',`PHQ-9: ${selected.scores.phq.answered}/9 ответов; GAD-7: ${selected.scores.gad.answered}/7. Пропущенный ответ обозначен «нет ответа», а не нулём.`):''}${['phq','gad'].map(kind=>`<div class="section-gap"><h2 class="section-title">${FORMS[kind].name} · ${selected.scores[kind].complete?selected.scores[kind].score+' / '+FORMS[kind].max:'нет итоговой суммы'}</h2><div class="scale-window">${h(FORMS[kind].domain)} · ${selected.window ? `Окно ${dateLabel(selected.window.start)} — ${dateLabel(selected.window.end)}` : 'За последние две недели · анкета в процессе'}<br>Форма: ${h(selected.version)} · ${selected.draft?'черновик':'завершено '+when(selected.completedAt)}</div><div class="table-scroll"><table class="answer-table"><thead><tr><th>Пункт анкеты</th><th>${selected===first?'Ответ': 'Выбранная дата'}</th>${selected!==first&&first?'<th>Исходно</th><th>Разница</th>':''}</tr></thead><tbody>${FORMS[kind].items.map((text,i)=>{const index=i+(kind==='gad'?9:0),value=selected.answers[index],baseline=first?.answers[index];return `<tr class="${kind==='phq'&&i===8?'critical-row':''}"><td><span class="item-num">${i+1}.</span>${h(text)}</td><td><span class="answer-score">${value===null?'—':value}</span>${value===null?'Нет ответа':h(FREQUENCY[value])}</td>${selected!==first&&first?`<td><span class="answer-score">${baseline}</span>${h(FREQUENCY[baseline])}</td><td>${value===null?'—':signed(value-baseline)}</td>`:''}</tr>`;}).join('')}</tbody></table></div></div>`).join('')}<p class="small muted section-gap">Пункт 9 PHQ-9 рассматривается отдельно от суммы. Категории выраженности — описание результата шкалы, клинический диагноз по ним не выставляется. Контекстные вопросы и дневник в суммы не входят.</p><details class="section-gap"><summary>Источник формы и ограничения</summary><p class="small muted">Русские формы А. А. Золотаревой (2023), одинаковые с миниаппом. Версия и первичные ответы сохранены. Учебное некоммерческое использование; происхождение и лицензия описаны в документации проекта. Готовность к клиническому использованию отдельно не подтверждена.</p></details></section>`;
}
function calendar(p) {
  return `<div class="calendar-grid" aria-label="Дни наблюдения">${p.days.map(d=>`<button type="button" class="calendar-cell ${d.entry?'fn-'+d.entry.function:d.future?'future':'missing'}" data-action="day" data-day="${d.day}" aria-pressed="${Number(selectedDay)===d.day}" aria-label="День ${d.day}${d.date?', '+dateLabel(d.date):''}: ${d.entry?FUNCTION_LABELS[d.entry.function]:d.future?'ещё не наступил':'нет записи'}"><b>${d.day}</b><span>${d.date?numericDate(d.date):'—'}<br>${d.entry?['Не мешало','Немного','Сильно','Почти не справл.'][d.entry.function]:d.future?'Впереди':'Нет записи'}</span>${d.entry?.retrospective?'<span class="retro" title="Внесено позже">*</span>':''}</button>`).join('')}</div><div class="legend-doctor">${FUNCTION_LABELS.map((s,i)=>`<span><i class="legend-dot fn-${i}"></i>${h(s)}</span>`).join('')}<span><i class="legend-dot missing"></i>Нет записи</span><span>* Внесено позже</span></div>`;
}
function diary() {
  const p=patient;
  if(!p.assessments.length) return `<section class="card">${empty('Наблюдение ещё не началось','После исходного скрининга появится календарь. Будущие дни не считаются пропусками.')}</section>`;
  if(selectedDay===null||!p.days.some(d=>d.day===Number(selectedDay))) selectedDay=p.diary.at(-1)?.day??Math.min(p.day,14);
  const day=p.days.find(d=>d.day===Number(selectedDay)), e=day?.entry;
  return `<div class="detail-grid"><section class="card"><div class="card-head"><h2>Как состояние мешало делам</h2><span class="pill">${h(coverage(p))}</span></div><p class="small muted">Цвет ячейки — ответ пациента о работе, учёбе, быте и общении. Это не оценка тяжести расстройства.</p>${calendar(p)}<div class="diary-detail" aria-live="polite"><h3>День ${selectedDay} · ${h(dateLabel(day?.date))}</h3>${e?`<div class="compact-metrics"><div><span>Настроение</span><b>${e.mood}<small>/10</small></b></div><div><span>Тревога</span><b>${e.anxiety}<small>/10</small></b></div><div><span>Сон</span><b>${n(e.sleep)}${e.sleep===null?'':' ч'}</b></div></div><dl class="fact-list section-gap">${field('Обычные дела',FUNCTION_LABELS[e.function])}${field('По сравнению с началом наблюдения',e.change||'Не спрашивалось в день 0')}</dl><blockquote class="entry-quote">${h(e.note||'Свободной заметки нет.')}</blockquote>${source(`Со слов пациента · внесено ${when(e.recordedAt)}${e.retrospective?' · ретроспективная запись':''}`)}`:notice(day?.future?'День ещё не наступил':'Нет записи',day?.future?'Не включён в ожидаемое число дневников.':'Состояние в этот день неизвестно. Значения не восстанавливаются автоматически.')}</div></section><div class="stack"><section class="card"><h2>Полнота данных</h2><dl class="fact-list section-gap">${field('Записи',coverage(p))}${field('Дни без дневника',String(p.stats.missing))}${field('Продолжительность сна',`${p.stats.sleepCount} числовых ответов из ${p.diary.length} записей`)}${field('Ретроспективные записи',String(p.diary.filter(e=>e.retrospective).length))}</dl><p class="small muted section-gap">Отсутствие дневника не считается ни улучшением, ни ухудшением. Удобство заполнения можно обсудить на приёме.</p></section><section class="card"><h2>Заметки и события</h2>${lastNotes(p)}</section></div></div><section class="card section-gap"><div class="card-head"><h2>Все дневные записи</h2>${button('Скачать CSV', 'csv')}</div>${diaryTable(p)}</section>`;
}
function diaryTable(p) {
  return `<div class="table-scroll"><table class="daily-table"><thead><tr><th>День / дата</th><th>Настроение 0–10</th><th>Тревога 0–10</th><th>Сон, ч</th><th>Обычные дела</th><th>Изменение</th><th>Заметка</th></tr></thead><tbody>${p.diary.map(e=>`<tr><td>${e.day} · ${h(numericDate(e.date))}${e.retrospective?' *':''}</td><td>${e.mood}</td><td>${e.anxiety}</td><td>${e.sleep===null?'нет данных':n(e.sleep)}</td><td>${h(FUNCTION_LABELS[e.function])}</td><td>${h(e.change||'не спрашивалось')}</td><td class="note-cell">${h(e.note||'—')}</td></tr>`).join('')||'<tr><td colspan="7">Записей пока нет</td></tr>'}</tbody></table></div>`;
}
function lineChart(rows, {key='value',max=10,labels,events=[],label='График',color='#527c62',xLabels,compact=false}={}) {
  const W=window.innerWidth<600?330:Math.round(Math.min(1380,Math.max(600,window.innerWidth-105))/(compact?2:1)),H=210,L=36,R=18,T=18,B=34, PW=W-L-R,PH=H-T-B;
  const x=i=>L+(rows.length<2?PW/2:i/(rows.length-1)*PW), y=v=>T+PH-(v/max)*PH;
  let segments=[],current=[];
  rows.forEach((r,i)=>{if(Number.isFinite(r[key])) current.push([x(i),y(r[key])]);else if(current.length){segments.push(current);current=[];}}); if(current.length)segments.push(current);
  const ticks=labels?labels.map((label,i)=>[i,label]):[0,max/2,max].map(v=>[v,String(v)]);
  const stampIndices=rows.length<=4?rows.map((_,i)=>i):[0,Math.floor((rows.length-1)/2),rows.length-1];
  return `<div class="chart-wrap"><svg class="doctor-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(label)}"><title>${h(label)}. Пропуски оставлены разрывами.</title>${ticks.map(([v,text])=>`<line class="grid-line" x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L-9}" y="${y(v)+3}" text-anchor="end">${h(text)}</text>`).join('')}${events.map(e=>{const i=rows.findIndex(r=>r.date===e.date);return i<0?'':`<line class="event-line" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H-B}"/><text x="${x(i)}" y="10" text-anchor="middle">*</text>`;}).join('')}${segments.map(s=>`<polyline class="series" stroke="${color}" points="${s.map(p=>p.join(',')).join(' ')}"/>`).join('')}${rows.map((r,i)=>Number.isFinite(r[key])?`<circle class="point" stroke="${color}" cx="${x(i)}" cy="${y(r[key])}" r="3.5"><title>${h(r.date?dateLabel(r.date):'День '+(i+1))}: ${h(n(r[key]))}</title></circle>`:'').join('')}${stampIndices.map(i=>`<text x="${x(i)}" y="${H-10}" text-anchor="middle">${h(xLabels?xLabels[i]:rows[i]?.date?numericDate(rows[i].date):'—')}</text>`).join('')}</svg></div>`;
}
function dynamics() {
  const p=patient, rows=p.days.filter(d=>!d.future).map(d=>({date:d.date,[metric]:d.entry?.[metric]??null}));
  return `<section class="card"><div class="card-head"><div><h2>Дневная динамика</h2><p class="small muted">${({mood:'0 — очень плохое настроение, 10 — очень хорошее.',anxiety:'0 — тревоги не было, 10 — очень сильная.',sleep:'Продолжительность основного сна перед указанным днём, в часах.',function:'0 — не мешало, 1 — немного, 2 — сильно, 3 — почти не получалось справляться.'})[metric]}</p></div><div class="metric-switch" role="group" aria-label="Показатель графика">${Object.entries(metricLabels).map(([v,t])=>`<button data-action="metric" data-metric="${v}" aria-pressed="${metric===v}">${t}</button>`).join('')}</div></div>${rows.length?lineChart(rows,{key:metric,max:metric==='function'?3:metric==='sleep'?Math.max(12,...p.diary.map(e=>e.sleep||0)):10,events:p.events,label:metricLabels[metric]+' по дням'}):empty('Пока нечего сравнивать','Появится после первых дневных записей.')}<p class="chart-caption">Линия соединяет только соседние дни с ответами. Разрыв означает отсутствие данных. ${metric==='sleep'?'Пропуск сна не равен 0 часам.':''}${p.events.length?' Звёздочки — даты сообщённых новых явлений. Совпадение по времени не доказывает связь с лечением.':''}</p></section><div class="two-col section-gap">${['phq','gad'].map(kind=>`<section class="card"><h2>${FORMS[kind].name} · 0–${FORMS[kind].max}</h2>${p.assessments.length?lineChart(p.assessments.map(a=>({date:a.date,value:a.scores[kind].score})),{max:FORMS[kind].max,compact:true,label:FORMS[kind].name+' по завершённым анкетам'}):empty('Нет завершённых анкет','Черновик на график результатов не переносится.')}<p class="small muted">${delta(p.delta[kind])} · ${p.assessments.length} завершённых измерений. Оценка симптомов за предшествующие две недели; ежедневный дневник — другой инструмент.</p></section>`).join('')}</div><section class="card section-gap"><h2>Недели наблюдения</h2><div class="table-scroll section-gap"><table class="daily-table"><thead><tr><th>Период</th><th>Дневники</th><th>Настроение, среднее</th><th>Тревога, среднее</th><th>Сон, среднее</th><th>Сильно мешало / почти не справлялся</th></tr></thead><tbody>${p.weeks.map(w=>`<tr><td>Дни ${w.start}–${w.end}</td><td>${w.recorded} из ${w.expected}</td><td>${n(w.mood)}</td><td>${n(w.anxiety)}</td><td>${n(w.sleep)}${w.sleep===null?'':' ч'} · n=${w.sleepCount}</td><td>${w.functionDifficult} из ${w.recorded} записей</td></tr>`).join('')}</tbody></table></div><p class="small muted section-gap">Средние рассчитаны по заполненным числовым ответам. Категории влияния на дела показаны числом записей, без усреднения порядковой шкалы. Неполные недели нельзя сравнивать как равные по полноте.</p></section>${eventsCard(p)}<section class="card section-gap"><div class="card-head"><h2>Таблица значений</h2>${button('Скачать CSV','csv')}</div>${diaryTable(p)}</section>`;
}
function eventsCard(p) {
  return `<section class="card section-gap"><h2>Новые явления и изменения лечения</h2>${p.events.length?`<ul class="timeline-list section-gap">${p.events.map(e=>`<li><time>${h(dateLabel(e.date))}</time><strong>${h(e.title)}</strong> · ${h(e.severity)}<br>${h(e.impact)}<br>${h(e.note)}${source(e.source)}</li>`).join('')}</ul>`:'<p class="small muted section-gap">Структурированные сведения о новых явлениях и датах изменения лечения не собирались. Свободные заметки можно уточнить при беседе; отсутствие события в ленте не означает отсутствия нежелательных явлений.</p>'}<p class="small muted section-gap">Связь с препаратами не установлена. Названия, дозы и даты начала требуют сверки; приложение не изменяет назначения.</p></section>`;
}
function planValues(p) {
  return formDrafts.get(draftKey(p))?.values || p.review.draft || p.review.confirmed || {clinicalNote:'',safetyNote:'',goal:'',plan:'',watch:'',earlyContact:'',nextDate:'',nextTime:''};
}
function plan() {
  const p=patient,v=planValues(p), local=formDrafts.get(draftKey(p));
  const input=(name,label,hint,limit=1000)=>`<label class="form-field">${label}<span class="private-label">${hint}</span><textarea name="${name}" maxlength="${limit}" placeholder="${name==='safetyNote'?'Результат уточнения и согласованные действия':'Внесите по итогам беседы'}">${h(v[name]||'')}</textarea></label>`;
  return `<div class="detail-grid"><div class="stack"><section class="card"><div class="card-head"><h2>Контекст для клинической беседы</h2><span class="pill">Требует уточнения</span></div><div class="context-grid">${p.intake.map(f=>`<div class="context-item"><h3>${h(f.label)}</h3><p>${h(f.value||'Не собиралось')}</p>${source(f.source+(f.at?' · '+dateLabel(f.at):''))}</div>`).join('')}</div><p class="small muted section-gap">Лабораторные показатели, пульс, давление и данные носимых устройств не собираются. Биомаркеры для постановки диагноза в этом прототипе не используются.</p></section><section class="card"><h2>Лекарства и БАДы со слов пациента</h2>${p.medications.length?p.medications.map(m=>`<div class="medication-item"><strong>${h(m.name)}</strong><div>${h(m.regimen)}</div>${source('Не сверено врачом · вымышленный пример')}</div>`).join(''):'<p class="small muted section-gap">Перечень не внесён. Это не означает, что пациент ничего не принимает.</p>'}${p.adherence?`<div class="section-gap"><h3>Выполнение плана со слов</h3><p class="small">${h(p.adherence.label)}. Запланированные дозы и точность схемы здесь не проверяются.</p><div class="adherence-strip" aria-label="${p.adherence.taken} выполнено, ${p.adherence.missed} пропущено, ${p.adherence.unknown} без данных">${Array.from({length:p.adherence.taken},()=>'<span></span>').join('')}${Array.from({length:p.adherence.missed},()=>'<span class="missed"></span>').join('')}${Array.from({length:p.adherence.unknown},()=>'<span class="unknown"></span>').join('')}</div><div class="small">Из ${p.adherence.planned}: ${p.adherence.taken} выполнено со слов · ${p.adherence.missed} пропущено · ${p.adherence.unknown} без данных</div><p class="small muted section-gap">${h(p.adherence.reason)} Пропуски и отсутствие ответа разделены; процент «приверженности» не вычисляется.</p></div>`:'<p class="small muted section-gap">Выполнение назначений не собиралось.</p>'}</section>${eventsCard(p)}<section class="card" id="review-card"><div class="card-head"><h2>Врачебная запись</h2><span class="pill">Демонстрация</span></div><p class="review-copy">Черновик доступен только в кабинете. После явного подтверждения пациент увидит цель, план, наблюдение и дату контакта. Назначения автоматически не предлагаются. ${p.connected?'Этот профиль связан с ботом и Mini App через защищённый учебный кабинет.':p.live?'Этот профиль связан с миниаппом в том же браузере.':'Это отдельный вымышленный пример.'}</p>${p.safety.needsClarification?notice('Сначала уточните ответы о безопасности','Для подтверждения внесите результат беседы в отдельное поле. Исходные ответы при этом сохраняются.',true):''}<form id="clinical-form" class="doctor-form section-gap">${input('clinicalNote','Клиническая запись','Только в кабинете · не передаётся пациенту',2000)}${input('safetyNote','Уточнение безопасности'+(p.safety.needsClarification?' · обязательно для этого случая':''),'Только в кабинете · результат беседы, а не вывод по сумме анкеты')}<div class="form-section">Часть, которую увидит пациент после подтверждения</div>${input('goal','Согласованная цель','Просто и конкретно: что пациент хочет вернуть в повседневной жизни')}${input('plan','Согласованный план','Что и когда делать; лекарственная схема вносится только после решения врача',2000)}${input('watch','Что отслеживать','Какие изменения и проявления отмечать')}${input('earlyContact','Когда связаться раньше','Конкретные основания и согласованный способ обращения')}<div class="form-row"><label class="form-field">Следующий контакт · дата<input type="date" name="nextDate" value="${h(v.nextDate||'')}" min="${p.today}"></label><label class="form-field">Время<input type="time" name="nextTime" value="${h(v.nextTime||'')}"></label></div><p class="small muted">Часовой пояс контакта: ${h(p.timeZone)} · пояс профиля пациента.</p><p class="unsaved-note" id="unsaved-note" role="status">${local?.dirty?'Есть несохранённые изменения.':p.review.draft?'Черновик сохранён '+h(when(p.review.draft.at))+'.':'Запись ещё не сохранена.'}</p><div class="row"><button class="button secondary" type="submit">Сохранить черновик</button>${button('Проверить и подтвердить','confirm-plan',false)}</div><p class="small muted">Подтверждение здесь демонстрирует рабочий процесс. Реальная идентификация врача и клиническое согласование не подключены.</p></form></section></div><div class="stack">${safetyCard(p)}<section class="card"><h2>Подтверждённая версия плана</h2>${p.review.confirmed?`<p class="small muted section-gap">${h(when(p.review.confirmed.at))} · ${h(p.review.confirmed.author)}</p>${patientPlan(p.review.confirmed)}<p class="small muted section-gap">${p.live?'Эта часть доступна в миниаппе, в разделе «К приёму».':'Вымышленная карточка; на профиль миниаппа этот план не переносится.'}</p>`:'<p class="small muted section-gap">Подтверждённого плана пока нет. Черновик пациенту не показывается.</p>'}</section><section class="card"><h2>История версий и действий</h2><p class="small muted section-gap">Подтверждений плана: ${p.review.history.length}. Показы вкладок, черновики и подтверждения записываются отдельно.</p><ul class="activity-list">${p.activity.slice(0,10).map(e=>`<li><b>${h(({draft:'Сохранён черновик',confirm:'Подтверждён план',viewed:'Отмечен просмотр','view-presented':'Показан раздел: '+(tabs.find(t=>t[0]===e.view)?.[1]||'карточка')})[e.event]||e.event)}</b><br>${h(when(e.at))}</li>`).join('')||'<li>Действий пока нет.</li>'}</ul>${p.review.history.length?`<details class="section-gap"><summary>Все подтверждённые версии</summary>${p.review.history.slice().reverse().map(v=>`<div class="medication-item"><strong>${h(when(v.at))}</strong>${patientPlan(v)}</div>`).join('')}</details>`:''}</section></div></div>`;
}
function patientPlan(v) {
  return `<dl class="fact-list section-gap">${field('Цель',v.goal)}${field('План',v.plan)}${field('Отслеживать',v.watch)}${field('Связаться раньше',v.earlyContact)}${field('Следующий контакт',`${dateLabel(v.nextDate)}, ${v.nextTime} · ${v.timeZone||patient.timeZone}`)}</dl>`;
}
function summary() {
  const p=patient;
  return `<div class="summary-actions">${button(icon('download')+' Скачать TXT','download-summary')}${button('Копировать сводку','copy-summary')}${button('Печать / сохранить PDF','print')}${button('Скачать дневник CSV','csv')}</div><section class="card"><div class="summary-top"><h2>Полная сводка из сохранённых полей</h2><p class="small muted section-gap">Самоотчёт, пропуски и врачебная запись разделены. Полная версия содержит внутреннюю запись врача; для пациента предназначен только подтверждённый план.</p></div><pre class="summary-sheet" id="summary-content">${h(p.summary)}</pre></section>`;
}
function aiSummary(p) {
  if(workspaceMode!=='clinic')return `<section class="card"><h2>Краткая сводка к приёму</h2><p class="small muted">По сохранённым ответам · проверьте на беседе</p><dl class="fact-list section-gap">${field('Причина обращения',p.referral.reason)}${field('Цель пациента',p.context?.goal||null)}${field('Длительность',p.context?.duration||null)}${field('Дневник',coverage(p))}</dl><h3 class="section-gap">Уточнить на приёме</h3><ol class="meeting-questions">${meetingQuestions(p).slice(0,4).map(q=>`<li>${h(q.text)}</li>`).join('')}</ol><a class="text-link" href="${pathFor(p.id,'summary')}">Полная сводка и экспорт →</a></section>`;
  const latest=p.assessments.at(-1);
  const savedFacts=`<dl class="summary-facts"><div><dt>Последние анкеты</dt><dd>${latest?'PHQ-9 '+latest.scores.phq.score+'/27 · GAD-7 '+latest.scores.gad.score+'/21':'Нет завершённых анкет'}</dd></div><div><dt>Дневник</dt><dd>${h(coverage(p))} · ${p.stats.missing} без записи</dd></div><div><dt>Цель пациента</dt><dd>${h(p.context?.goal||p.appointment.question||'Не указана')}</dd></div><div><dt>С чем направлен</dt><dd>${h(p.referral.reason||'Не указано')}</dd></div></dl>`;
  const ai=p.ai, draft=ai?.draft, waiting=aiBusy||ai?.pending;
  return `<section class="card ai-summary" aria-label="Краткая сводка к приёму"><div class="ai-summary-heading"><div><h2>Краткая сводка к приёму</h2><p class="small muted">Проверьте сохранённые сведения на беседе</p></div>${button(waiting?'Готовим сводку…':draft&&!ai.stale?'Сводка готова':draft?'Обновить краткую сводку':'Подготовить краткую сводку','generate-ai',false,!ai?.enabled||waiting||draft&&!ai.stale?'disabled':'')}</div>${savedFacts}<details class="summary-method"><summary>Как подготовлена сводка</summary><p class="small muted">${h(ai?.provider||"Сервис")} выбирает важные факты и вопросы. Числа и формулировки фактов берутся из сохранённых полей. Передаются только структурированные вымышленные данные без имён, кодов и свободного текста. Бесплатный поставщик может сохранять их и использовать для обучения.</p></details>${aiError?`<p class="notice red" role="alert">${h(aiError)}</p>`:''}${!ai?.enabled?'<p class="small muted">Сервис пока не подключён. Полная сводка ниже доступна.</p>':''}${waiting?'<p role="status" class="small">Обычно это занимает несколько секунд. Полная сводка доступна ниже.</p>':''}${draft?`${ai.stale?'<p class="notice red">После подготовки появились новые данные. Этот черновик устарел — обновите его перед использованием.</p>':''}<p class="small muted">Подготовлено ${h(when(draft.generatedAt))} · ${h(draft.model)}</p><section class="ai-group"><h3>На что обратить внимание</h3><ul class="ai-facts">${draft.highlights.map(f=>`<li><p>${h(f.text)}</p><a class="text-link" href="${pathFor(p.id,f.tab)}">${h(tabs.find(t=>t[0]===f.tab)?.[1]||'Исходные данные')} →</a></li>`).join('')}</ul></section><section class="ai-group"><h3>Уточнить при беседе</h3><ul class="ai-questions">${draft.questions.map(q=>`<li>${h(q.text)}</li>`).join('')}</ul></section><div class="row">${button('Скачать краткую сводку TXT','download-ai')}</div>`:'<p class="small">Нажмите кнопку: получите список важных наблюдений со ссылками на анкеты, дневник и динамику, а также вопросы к приёму.</p>'}<details class="summary-method"><summary>Ограничения сводки</summary><p class="small muted">${h(ai?.limitations?.join(' ')||'Черновик не является диагнозом или назначением и не передаётся пациенту как план.')}</p></details></section>`;
}
function aiText(p) {
  const d=p.ai.draft;
  return `ТРЕКЕР СЕЧЕНОВКА · ЧЕРНОВИК КРАТКОЙ СВОДКИ\nВымышленные данные. Требуется проверка врачом.\nПодготовлено ${d.generatedAt}; ${d.model}; ${d.promptVersion}.\n${p.ai.stale?'ВНИМАНИЕ: исходные данные изменились; черновик устарел.\n':''}\nНАБЛЮДЕНИЯ\n${d.highlights.map(f=>'• '+f.text+' [Источник: '+(tabs.find(t=>t[0]===f.tab)?.[1]||f.tab)+']').join('\n')}\n\nУТОЧНИТЬ ПРИ БЕСЕДЕ\n${d.questions.map(q=>'• '+q.text).join('\n')}\n\n${p.ai.limitations.join('\n')}\nЧерновик не является врачебной записью или подтверждённым планом.`;
}
async function generateAi() {
  if(busy||aiBusy||!patient?.ai?.enabled)return;
  const id=patient.id, episode=patient.episodeId, mode=workspaceMode;
  busy=true;aiBusy=true;aiError='';captureForm();render();
  try {
    await requestJSON(`${apiBase()}/${id}/ai-summary`,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Client':'1'},body:JSON.stringify({episodeId:episode,sourceRevision:patient.sourceRevision})},30000);
    if(workspaceMode===mode&&route().id===id)toast('Краткая сводка готова. Проверьте её по исходным данным.');
  }catch(error){
    if(error.status===401){authExpired();return;}
    if(workspaceMode===mode&&route().id===id){aiError=error.status<500?error.message:'ИИ-сервис не подготовил сводку. Полная версия доступна; повторите позже.';toast(aiError,true);}
  }finally{busy=false;aiBusy=false;render();await load({force:true});}
}
function captureTherapy(dirty = false) {
  const form = document.querySelector('#therapy-context-form');
  if (!form || !patient) return;
  const d = Object.fromEntries(new FormData(form)), key = draftKey(patient), old = therapyDrafts.get(key);
  therapyDrafts.set(key, { dirty: dirty || old?.dirty || false, values: { diagnosis: d.diagnosis, evidence: d.evidence, checks: Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('check-')).map(([k, v]) => [k.slice(6), v])) } });
}
async function saveTherapy() {
  if (busy || !patient) return;
  captureTherapy(); const p = patient, key = draftKey(p), values = therapyDrafts.get(key)?.values;
  if (!values) return;
  const mode = workspaceMode; loadVersion++; loading = false;
  busy = true; const el = document.querySelector('#therapy-context-form button'); if (el) el.disabled = true;
  try {
    const next = await requestJSON(`${apiBase()}/${p.id}/therapy-context`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Client': '1' }, body: JSON.stringify({ episodeId: p.episodeId, sourceRevision: p.sourceRevision, contextRevision: p.therapy.context.revision, values }) });
    if (workspaceMode !== mode || patient?.id !== p.id || patient?.episodeId !== p.episodeId) return;
    therapyDrafts.delete(key); patient = next; busy = false; render(); requestAnimationFrame(() => requestAnimationFrame(() => revealViewportElement(document.querySelector('#therapy-status')))); toast('Проверка сохранена. Назначение и план пациента не изменены.');
  } catch (e) { if (e.status === 401 && workspaceMode === 'clinic') authExpired(); else toast(e.message, true); }
  finally { busy = false; if (el?.isConnected) el.disabled = false; }
}
function captureForm() {
  captureTherapy();
  const form=document.querySelector('#clinical-form');
  if(form&&patient){const old=formDrafts.get(draftKey(patient));formDrafts.set(draftKey(patient),{values:Object.fromEntries(new FormData(form)),dirty:old?.dirty||false});}
}
function download(text, name, type='text/plain;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function csv() {
  const clean=value=>{let v=String(value??'');if(/^[=+\-@\t\r]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';};
  const columns=['День','Дата','Настроение 0–10','Тревога 0–10','Сон, ч','Влияние на дела','Изменение','Заметка','Внесено позже','Время внесения'];
  const rows=patient.diary.map(e=>[e.day,e.date,e.mood,e.anxiety,e.sleep===null?'нет данных':e.sleep,FUNCTION_LABELS[e.function],e.change||'',e.note,e.retrospective?'да':'нет',e.recordedAt]);
  download('\ufeff'+[columns,...rows].map(r=>r.map(clean).join(';')).join('\r\n'),`dnevnik-${patient.identity.code}.csv`,'text/csv;charset=utf-8');
  toast('CSV содержит только заполненные дни; пропуски сна обозначены явно.');
}
async function saveReview(type, values, reviewed=false) {
  if(busy||!patient)return;
  const id=patient.id, localKey=draftKey(patient), episodeId=patient.episodeId, revision=patient.review.revision, sourceRevision=patient.sourceRevision;
  busy=true;document.querySelector('#request-status').hidden=false;
  document.querySelector('#request-status').textContent='Сохраняем запись…';
  try {
    const next=await requestJSON(`${apiBase()}/${id}/review`,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Client':'1'},body:JSON.stringify({type,values,revision,sourceRevision,episodeId,reviewed})});
    if(type!=='viewed')formDrafts.delete(localKey);
    if(route().id===id)patient=next;
    if(modal.open)modal.close();
    render();toast(type==='draft'?'Черновик сохранён. Пациент его не видит.':type==='confirm'?'План подтверждён в демонстрации.': 'Просмотр отмечен. Клиническое решение отдельно.');
  } catch(error) {
    if(error.status===401&&workspaceMode==='clinic'){authExpired();return;}
    toast(error.message,true);
    if(modal.open){let el=modal.querySelector('#confirmation-error');if(el)el.textContent=error.message;}
  } finally {
    busy=false;document.querySelector('#request-status').hidden=true;
    document.querySelectorAll('button[data-action="confirm-plan"],button[data-action="viewed"]').forEach(el=>{el.disabled=false;});
    document.querySelectorAll('button').forEach(el=>{if(el.dataset.locked==='true'){el.disabled=false;delete el.dataset.locked;}});
  }
}
function confirmation() {
  captureForm();const v=planValues(patient), required=['clinicalNote','goal','plan','watch','earlyContact','nextDate','nextTime'];
  if(required.some(k=>!v[k]?.trim())){toast('Заполните запись, цель, план, наблюдение, основания раннего контакта, дату и время.',true);revealViewportElement(document.querySelector(`[name="${required.find(k=>!v[k]?.trim())}"]`));return;}
  if(patient.safety.needsClarification&&!v.safetyNote?.trim()){toast('Внесите результат уточнения безопасности и согласованные действия.',true);revealViewportElement(document.querySelector('[name="safetyNote"]'));return;}
  showModal('Проверить план перед подтверждением',`<p>Подтверждение создаёт новую версию. ${patient.live?'Следующие поля появятся у пациента в миниаппе.':'План сохранится только в этой вымышленной карточке.'} Внутренняя клиническая запись и уточнение безопасности пациенту не передаются.</p>${patientPlan(v)}<label class="confirm-check"><input type="checkbox" id="reviewed-check">Я просмотрел(а) актуальные данные, уточнил(а) вопросы при беседе и проверил(а) текст плана. В этом прототипе подтверждение только демонстрационное.</label><p id="confirmation-error" class="small sync-error" role="alert"></p><div class="row">${button('Вернуться к записи','close-modal')}${button('Подтвердить демоплан','publish-plan',false)}</div>`);
}
async function logPresented(view = route().tab) {
  const r=route();if(!patient||r.id!==patient.id||loading||document.hidden||workspaceMode==='clinic'&&!clinicSession?.authenticated)return;
  const key=[patient.id,view,patient.sourceRevision,patient.review.revision].join(':');if(presented.has(key))return;
  presented.add(key);
  try {await requestJSON(`${apiBase()}/${patient.id}/events`,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Client':'1'},body:JSON.stringify({view,sourceRevision:patient.sourceRevision})});}
  catch{presented.delete(key);}
}
async function load({silent=false,force=false}={}) {
  if(loading||busy||modal.open||silent&&recommendationsOpen('doctor')||!clinicSession||workspaceMode==='clinic'&&!clinicSession.authenticated)return;
  const r=route(),version=++loadVersion;loading=true;
  if(!silent){if(!patient||patient.id!==r.id){patient=null;render();}document.querySelector('#request-status').textContent='Обновляем данные…';document.querySelector('#request-status').hidden=false;}
  try {
    if(r.id){
      const next=await requestJSON(`${apiBase()}/${r.id}`,{cache:'no-store'});
      if(version!==loadVersion||route().id!==r.id)return;
      const changed=!patient||patient.id!==next.id||patient.sourceRevision!==next.sourceRevision||patient.review.revision!==next.review.revision||JSON.stringify(patient.ai)!==JSON.stringify(next.ai)||patient.therapy.context.revision!==next.therapy.context.revision;
      if(changed&&silent&&patient&&(formDrafts.get(draftKey(patient))?.dirty||therapyDrafts.get(draftKey(patient))?.dirty)){const el=document.querySelector('#sync-status');if(el)el.textContent='Есть новые данные. Сохраните черновик и обновите карточку.';return;}
      captureForm();patient=next;lastSync=new Date();if(syncError){clearTimeout(toastTimer);document.querySelector('#toast').hidden=true;}syncError=false;
      if(changed||force||!silent)render();
      else {const el=document.querySelector('#sync-status');if(el){el.textContent='Данные актуальны · '+new Intl.DateTimeFormat('ru',{hour:'2-digit',minute:'2-digit'}).format(lastSync);el.classList.remove('sync-error');}}
    }else{
      const next=await requestJSON(apiBase(),{cache:'no-store'});if(version!==loadVersion||route().id)return;
      const rows=workspaceMode==='demo'?next.patients.filter(p=>p.id!=='live'):next.patients;const changed=JSON.stringify(rows)!==JSON.stringify(roster);roster=rows;patient=null;lastSync=new Date();if(syncError){clearTimeout(toastTimer);document.querySelector('#toast').hidden=true;}syncError=false;if(changed||!silent||force)render();
    }
  } catch(error){if(error.status===401&&workspaceMode==='clinic'){authExpired();return;}if(error.status===404&&workspaceMode==='clinic'){patient=null;render();}syncError=true;if(!silent)toast(error.message,true);if(!silent||patient){const el=document.querySelector('#sync-status');if(el){el.textContent='Обновление не удалось. Показаны сохранённые данные.';el.classList.add('sync-error');}else if(r.id&&!patient)render();}}
  finally{if(version===loadVersion){loading=false;document.querySelector('#request-status').hidden=true;logPresented();if(route().id!==r.id)load();}}
}
document.addEventListener('input',event=>{
  if(event.target.closest('#therapy-context-form'))captureTherapy(true);
  if(event.target.id==='patient-search'){query=event.target.value;rosterPage=0;document.querySelector('#roster-results').innerHTML=rosterRows();}
  if(event.target.closest('#clinical-form')){captureForm();const draft=formDrafts.get(draftKey(patient));draft.dirty=true;document.querySelector('#unsaved-note').textContent='Есть несохранённые изменения.';}
});
document.addEventListener('change',event=>{
  if(event.target.closest('#therapy-context-form'))captureTherapy(true);
  const el=event.target;
  if(el.id==='patient-filter'||el.id==='patient-sort'){rosterPage=0;filter=document.querySelector('#patient-filter').value;sort=document.querySelector('#patient-sort').value;document.querySelector('#roster-results').innerHTML=rosterRows();}
  if(el.id==='assessment-select'){assessmentId=el.value;render();}
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='therapy-context-form'){event.preventDefault();await saveTherapy();return;}
  if(event.target.id==='clinic-login-form'){event.preventDefault();if(busy)return;busy=true;const form=event.target;const submit=form.querySelector('button');submit.disabled=true;try{clinicSession=await requestJSON('/api/clinic/session',{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Client':'1'},body:JSON.stringify({key:String(new FormData(form).get('key')||'')})});form.reset();clearPrivateView();render();}catch(error){form.querySelector('#login-error').textContent=error.message;}finally{busy=false;submit.disabled=false;}await load({force:true});return;}
  if(event.target.id==='roster-form'){event.preventDefault();return;}
  if(event.target.id==='clinical-form'){event.preventDefault();captureForm();saveReview('draft',planValues(patient));}
});
document.addEventListener('click',async event=>{
  const el=event.target.closest('[data-action]');if(!el)return;
  const action=el.dataset.action;
  if(action==='roster-prev'||action==='roster-next'){rosterPage+=action==='roster-next'?1:-1;document.querySelector('#roster-results').innerHTML=rosterRows();return;}
  if(action==='overview-context'&&patient){const m=overviewModel(patient);showModal('Контекст и последние записи',`<dl class="fact-list">${field('Цель пациента',patient.context?.goal||patient.appointment.question||null)}${field('Длительность',patient.context?.duration||null)}${field('Последняя заметка',m.lastDiary?.note||'Свободной заметки нет')}${field('Дата заметки',m.lastDiary?dateLabel(m.lastDiary.date):null)}</dl><h3>На что обратить внимание</h3><ul>${patient.needs.map(f=>`<li>${h(f.text)}</li>`).join('')}</ul><a class="button secondary" href="${pathFor(patient.id,'diary')}">Все записи дневника →</a>`);return;}
  if(action==='open-recommendations'){showDoctorRecommendations();return;}
  if(action==='close-modal'){modal.close();return;}
  if(action==='demo-workspace'||action==='clinic-workspace'){if(busy)return;if([...formDrafts.values()].some(v=>v.dirty)){toast('Сохраните черновик перед сменой кабинета.',true);return;}clearPrivateView();workspaceMode=action==='demo-workspace'?'demo':'clinic';location.hash='#/patients';render();await load({force:true});return;}
  if(action==='clinic-logout'){if(busy)return;if([...formDrafts.values()].some(v=>v.dirty)){toast('Сохраните черновик перед выходом.',true);return;}try{await requestJSON('/api/clinic/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Client':'1'},body:'{}'});authExpired();}catch(error){toast(error.message,true);}return;}
  if(action==='about'){showModal('О проекте и данных',`<p>Здесь используются вымышленные примеры и подключённые тестовые профили. Передача профиля врачу включается пациентом отдельно.</p><p>Анкеты и дневник — самоотчёт. Сводка составляется из полей без генерации диагноза. Черновик врача отделён от подтверждённого плана.</p><p>Подключённые профили доступны только после отдельного входа. Связь между устройствами работает через Telegram-профиль. Реальная клиника и постоянное наблюдение не подключены. Используйте только тестовые данные.</p><div class="row"><a class="button secondary" href="/patient/">Миниапп</a><a class="button secondary" href="/">Памятка ВОП</a></div>`);return;}
  if(action==='refresh'){captureForm();await load({force:true});return;}
  if(action==='day'){selectedDay=Number(el.dataset.day);render();document.querySelector(`[data-action="day"][data-day="${selectedDay}"]`)?.focus({preventScroll:true});return;}
  if(action==='metric'){metric=el.dataset.metric;render();document.querySelector(`[data-metric="${metric}"]`)?.focus({preventScroll:true});return;}
  if(action==='csv'){csv();return;}
  if(action==='therapy-to-plan'){
    captureTherapy(); if(patient?.therapy.status!=='consider'||therapyDrafts.get(draftKey(patient))?.dirty){toast('Сначала сохраните актуальную проверку клинического основания.',true);return;}
    const old=planValues(patient),watch='Отмечать фактическое выполнение назначенного врачом плана, тревогу, сон, обычные дела, сонливость, головокружение и новые принимаемые средства.';
    const early='При новом мешающем явлении или ухудшении связаться с врачом раньше. При сонливости или головокружении не водить автомобиль. Схему лечения самостоятельно не менять; при опасности сейчас обратиться за экстренной помощью.';
    const append=(a,b)=>a?.includes(b)?a:[a,b].filter(Boolean).join('\n');
    const values={...old,watch:append(old.watch,watch),earlyContact:append(old.earlyContact,early)};
    if(values.watch.length>1000||values.earlyContact.length>1000){toast('В полях уже много текста. Добавьте наблюдение вручную.',true);return;}
    formDrafts.set(draftKey(patient),{values,dirty:true});closeRecommendations();location.hash=pathFor(patient.id,'plan');toast('Наблюдение добавлено в несохранённый черновик. Проверьте и заполните клинический план.');return;
  }
  if(action==='generate-ai'){await generateAi();return;}
  if(action==='download-ai'){if(patient?.ai?.draft){download(aiText(patient),`kratkaya-svodka-${patient.identity.code}.txt`);toast('Черновик сохранён. Проверьте факты перед использованием.');}return;}
  if(action==='download-summary'){download(patient.summary,`svodka-${patient.identity.code}.txt`);toast('Сводка сохранена. Она содержит внутреннюю запись врача.');return;}
  if(action==='copy-summary'){try{await navigator.clipboard.writeText(patient.summary);toast('Сводка скопирована. Она содержит внутреннюю запись врача.');}catch{showModal('Скопировать сводку',`<p>Выделите и скопируйте текст:</p><textarea class="summary-box" readonly aria-label="Текст сводки">${h(patient.summary)}</textarea>`);modal.querySelector('textarea').select();}return;}
  if(action==='print'){window.print();return;}
  if(action==='confirm-plan'){confirmation();return;}
  if(action==='publish-plan'){if(!document.querySelector('#reviewed-check').checked){document.querySelector('#confirmation-error').textContent='Подтвердите, что данные и план просмотрены.';return;}el.disabled=true;el.dataset.locked='true';await saveReview('confirm',planValues(patient),true);return;}
  if(action==='viewed'){el.disabled=true;el.dataset.locked='true';captureForm();await saveReview('viewed');return;}
});
window.addEventListener('hashchange',()=>{captureForm();if(route().tab!=='support')closeRecommendations();assessmentId=null;selectedDay=null;const r=route();if(patient?.id!==r.id){patient=null;aiError='';}render();load();window.scrollTo({top:0,behavior:'instant'});document.querySelector('h1')?.focus({preventScroll:true});});
window.addEventListener('beforeunload',event=>{if([...formDrafts.values()].some(v=>v.dirty)){event.preventDefault();event.returnValue='';}});
window.addEventListener('resize',()=>{if(!route().id&&document.querySelector('#roster-results')){document.querySelector('#roster-results').innerHTML=rosterRows();}});
window.addEventListener('focus',()=>load({silent:true}));
window.addEventListener('online',()=>load({silent:true}));
window.addEventListener('offline',()=>{syncError=true;const el=document.querySelector('#sync-status');if(el){el.textContent='Нет соединения. Новые данные не загружены.';el.classList.add('sync-error');}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load({silent:true});});
setInterval(()=>{if(!document.hidden)load({silent:true});},10000);
if(!location.hash)history.replaceState(null,'','#/patients');
render();
try{clinicSession=await requestJSON('/api/clinic/session',{cache:'no-store'});workspaceMode=initialWorkspaceMode(clinicSession,route().id);render();await load();}catch(error){app.innerHTML='<main class="loading"><h1>Не удалось открыть кабинет</h1><p>Проверьте соединение и обновите страницу.</p></main>';}

startViewport();

async function openDoctorVoice(extra = {}) {
  if (!patient) { toast('Сначала выберите пациента.', true); return; }
  const targetId = patient.id, targetEpisode = patient.episodeId;
  await openVoice({ scope: 'psychiatrist', savedHref: pathFor(targetId,'voice'), endpoint: apiBase() + '/' + targetId + '/voice', ownerLabel: patient.identity.name + ' · ' + patient.identity.code, isCurrent: () => patient?.id === targetId && patient.episodeId === targetEpisode, onError: text => toast(text, true), onSaved: async () => { if (patient?.id === targetId && patient.episodeId === targetEpisode) await load({ force: true }); }, ...extra });
}
document.addEventListener('click', event => {
  if (event.target.closest('[data-voice-start]')) { event.preventDefault(); void openDoctorVoice(); }
  const note = event.target.closest('[data-voice-note]'); if (note) void openDoctorVoice({ existing: (patient.voiceNotes || []).find(n => n.id === note.dataset.voiceNote) });
  if (event.target.closest('[data-voice-library]')) void openDoctorVoice({ library: true });
});

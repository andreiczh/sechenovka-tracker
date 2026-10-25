import { openRecommendations, closeRecommendations, recommendationsOpen } from '/shared/recommendations.js';
import { openVoice, voiceButton, voiceNotesSection, enhanceVoiceFields } from '/shared/voice-ui.js';
import { voiceText } from '/shared/voice-model.js';
import { revealViewportElement } from '/shared/viewport.js';
import { getState, sendAction, generatePatientSupport, escapeHtml as h, dateLabel, numericDate, numberLabel as n, icon } from '/shared/client.js';
import { FORMS, FREQUENCY, FUNCTION_LABELS, INSTRUCTION, scoreAssessment, URGENT_TEXT } from '/shared/clinical.js';
import { prepareTelegram, telegramInitialView } from '/shared/telegram.js';
import { renderPatientSupport, renderPatientAi, renderSupportStep, renderSupportQuestions } from '/shared/support-ui.js';

import { visitPreparation, patientVoiceOptions } from './patient-model.js';

prepareTelegram();
document.body.classList.add('patient-app');

const app = document.getElementById('app');
const modal = document.getElementById('modal');
let state, busy = false, toastTimer, reminderCount = 1, chartMode = 'feelings';
let patientAiBusy = false, patientAiError = '', lastMainView = 'today';
const supportFormDrafts = new Map(), appointmentDrafts = new Map();
function captureSupportForm(event) {
  const form = event.target.closest('#health-context-form, #treatment-checkin-form');
  if (!form || !state || form.dataset.episode !== state.episodeId) return;
  const draft = supportFormDrafts.get(state.episodeId) || {};
  draft[form.id === 'health-context-form' ? 'health' : 'treatment'] = { ...Object.fromEntries(new FormData(form)), ...(form.id === 'treatment-checkin-form' ? { _date: form.dataset.date } : {}) };
  supportFormDrafts.set(state.episodeId, draft);
}
const navigation = [['today', 'Сегодня'], ['results', 'Результаты'], ['diary', 'Дневник'], ['dynamics', 'Динамика'], ['visit', 'К приёму']];
const route = () => location.hash.includes('tgWebAppData=') ? telegramInitialView : location.hash.slice(1) || telegramInitialView;
const botUrl = () => state?.telegram?.available ? `https://t.me/${state.telegram.username}` : '/bot/';
const actionButton = (label, action, secondary = false) => `<button class="button${secondary ? ' secondary' : ''}" data-action="${action}">${label}</button>`;
const linkButton = (label, destination, secondary = false) => `<a class="button${secondary ? ' secondary' : ''}" href="#${destination}">${label}</a>`;
function heading(title, description='', eyebrow='', extra='') {
  return `<div class="patient-page-title"><h1 tabindex="-1">${title}</h1>${extra}${description?`<p>${description}</p>`:''}</div>`;
}
function note(text, title = '', tone = '') { return `<div class="notice ${tone}">${title ? `<strong>${title}</strong>` : ''}${text}</div>`; }
function safetyNotice() { return state.safety?.level ? `<div class="notice red section-gap"><strong>${h(state.recommendation.title)}</strong>${h(state.recommendation.text)}<div><button class="text-link red" data-action="help">Открыть помощь ${icon('arrow')}</button></div></div>` : ''; }
function recommendation() { const r = state.recommendation; return `<div class="notice ${r.tone === 'red' ? 'red' : ''}"><strong>${h(r.title)}</strong>${h(r.text)}${state.assessments.length ? '<div><a class="text-link" href="#visit">Подготовить обращение →</a></div>' : ''}</div>`; }
function disablePendingButtons() {
  for (const button of document.querySelectorAll('#app button, #modal button')) {
    if (!button.hasAttribute('data-before-request')) button.dataset.beforeRequest = String(button.disabled);
    button.disabled = true;
  }
}
function setBusy(value) {
  busy = value;
  app.setAttribute('aria-busy', String(value));
  document.getElementById('request-status').hidden = !value;
  if (value) disablePendingButtons();
  else for (const button of document.querySelectorAll('[data-before-request]')) { button.disabled = button.dataset.beforeRequest === 'true'; delete button.dataset.beforeRequest; }
}
function render() {
  if (!state) return;
  const current = route();
  if(!current.startsWith('support'))lastMainView=current;
  const activeView=current.startsWith('support')?lastMainView:({'flow':'today','saved-assessment':'results','saved-diary':'diary','voice':'diary'})[current]||current;
  const nav = navigation.map(([key, label]) => `<a href="#${key}"${activeView===key ? ' aria-current="page"' : ''}>${icon(key === 'support' ? 'help' : key)}<span>${label}</span></a>`).join('');
  const views = { support: () => renderPatientSupport(state, patientAiBusy, patientAiError, supportFormDrafts.get(state.episodeId)), 'support-data': () => renderPatientSupport(state, patientAiBusy, patientAiError, supportFormDrafts.get(state.episodeId), 'data'), 'support-context': () => renderPatientSupport(state, patientAiBusy, patientAiError, supportFormDrafts.get(state.episodeId), 'context'), 'support-treatment': () => renderPatientSupport(state, patientAiBusy, patientAiError, supportFormDrafts.get(state.episodeId), 'treatment'), voice: () => state.joined ? heading('Заметки своими словами', 'Скажите или напишите то, что важно обсудить с врачом.') + voiceNotesSection(state.voiceNotes || []) : home(), today: home, results, diary, dynamics, visit, settings, flow, 'saved-assessment': () => receipt('assessment'), 'saved-diary': () => receipt('diary') };
  let content = (views[current.startsWith('support') ? lastMainView : current] || home)();
  if(current==='settings')content+='<button class="text-link" data-action="demo">Тестовый профиль и готовый пример</button>';
  app.innerHTML = `<div class="shell"><div class="main-shell"><header class="topbar"><a class="mobile-brand brand" href="#today"><img src="/icons/mark.svg" alt=""><span>Сеченовка</span></a><div class="topbar-right">${state.joined?'<button class="patient-advice" data-action="open-recommendations">Советы</button>':''}<button class="patient-info" data-action="sources" aria-label="Об анкетах и данных">${icon('help')}</button><a class="mobile-settings" href="#settings" aria-label="Напоминания и настройки">${icon('settings')}</a></div></header><nav class="app-nav" aria-label="Разделы приложения">${nav}</nav><main id="main" class="main" data-view="${h(current)}">${content}</main></div></div>`;
  enhanceVoiceFields(app, extra => openPatientVoice(extra));
  if(current.startsWith('support'))showPatientRecommendations();
  if (busy) disablePendingButtons();
}
function showPatientRecommendations() {
  const section=({'support-data':'data','support-context':'context','support-treatment':'treatment'})[route()]||'main';
  const panel=openRecommendations({key:'patient',title:'Рекомендации и вопросы врачу',description:'Понятный разбор сохранённых ответов. Лечение определяет врач.',content:renderPatientSupport(state,patientAiBusy,patientAiError,supportFormDrafts.get(state.episodeId),section),closed:()=>{if(route().startsWith('support'))location.hash=lastMainView;}});
  enhanceVoiceFields(panel,extra=>openPatientVoice(extra));
}

function home() {
  if(!state.joined)return `<section class="card patient-welcome"><img class="patient-welcome-image" src="/assets/welcome.png" alt="Записи в блокноте"><h1 tabindex="-1">Как вы себя чувствуете?</h1><p>Две анкеты сейчас, короткие записи потом. К приёму будет проще вспомнить изменения.</p><ul class="patient-welcome-points"><li>PHQ-9 и GAD-7 · около 5–10 минут</li><li>Дневник · 1–2 минуты в день</li><li>Результаты и вопросы врачу — в одном месте</li></ul><label class="check-row"><input id="adult-confirm" type="checkbox"><span>Мне 18+. Это учебная версия: я буду использовать только вымышленные данные.</span></label>${actionButton('Начать анкеты','join')}<button class="text-link" data-action="seed-confirm">Посмотреть готовый пример</button><p class="small muted">Данные сохраняются на сервере. Врач не наблюдает за ними постоянно.</p></section>`;
  const baseline=!state.assessments.length,flow=state.flow,done=['done','handoff','review'].includes(state.task.kind);
  let title=baseline?'Начнём с двух анкет':state.task.kind==='assessment'?'Повторим анкеты':'Как прошёл день?';
  let description=baseline?'Вопросы о настроении и тревоге за последние две недели. Можно сделать паузу и продолжить позже.':state.task.kind==='assessment'?'Сравним ответы с исходной точкой. Отвечайте за последние две недели.':'Настроение, тревога, сон и обычные дела. Одна запись — около двух минут.';
  let cta=actionButton(flow?'Продолжить ответы':baseline||state.task.kind==='assessment'?'Пройти анкеты':'Заполнить дневник','start');
  if(done){title=state.task.kind==='review'?'Итоги готовы к беседе':state.appointment.attended?'Приём отмечен':'На сегодня всё';description=state.appointment.attended?'Дальнейший план согласуйте со специалистом.':state.task.kind==='review'?'Покажите врачу результаты и обсудите следующий шаг.':'Ответы сохранены. Сегодня больше не будем напоминать.';cta=linkButton(state.task.kind==='review'||state.appointment.attended?'Подготовиться к приёму':'Посмотреть результаты',state.task.kind==='review'||state.appointment.attended?'visit':'results');}
  return heading('Сегодня','', '',`<span class="patient-day">${baseline?'Первая запись':state.day>14?'Повторная оценка':`День ${state.day} из 14`}</span>`)+
    `<div class="patient-home"><section class="card patient-task"><div class="patient-task-top"><span>${done?'Готово':baseline||state.task.kind==='assessment'?'5–10 минут':'1–2 минуты'}</span>${done?icon('check'):icon('diary')}</div><h2>${title}</h2><p>${description}</p>${cta}${!done?`<a class="text-link patient-bot-link" href="${h(botUrl())}">Ответить в боте →</a>`:''}</section>${state.support?.urgent?recommendation():''}<section class="card patient-voice-shortcut"><div><h2>Есть что добавить?</h2><p>Расскажите своими словами. Текст останется в заметках.</p></div>${voiceButton('Записать голосом')}</section>${state.assessments.length?`<div class="patient-home-data">${miniScores()}${miniAppointment()}</div>`:`<p class="patient-reassurance">${flow?`Ответы сохраняются после каждого вопроса.`:'Начните с анкет. Для заметки голосом не нужно их заканчивать.'}</p>`}<div class="patient-quick-links"><a href="#settings">${icon('bell')}${state.reminders.enabled?'Напоминания: '+h(state.reminders.times.join(', ')):'Настроить напоминания'}</a><a href="#visit">${icon('visit')}Вопросы к приёму</a></div>${state.connection?.enabled?`<p class="patient-sharing">Профиль доступен врачу · ${h(state.connection.code)}</p>`:''}<details class="patient-details"><summary>Как устроены две недели наблюдения</summary>${journey()}${state.assessments.length?progressCard():''}</details><button class="attention-link" data-action="help">${icon('help')}Мне нужна помощь раньше</button></div>`;
}
function progressCard() {
  const entries = new Set(state.diary.map(e => e.day));
  const firstDay = state.stats.baselineRecorded ? 0 : 1;
  return `<section class="card"><div class="card-header"><h2>Ваши записи</h2><a class="text-link" href="#diary">Все записи →</a></div><div class="legend"><span><i class="dot"></i>Есть запись</span><span><i class="dot empty"></i>Нет данных</span></div><div class="day-strip" aria-label="Записи по дням">${Array.from({ length: 15 - firstDay }, (_, i) => { const day = i + firstDay; const filled = entries.has(day); return `<div class="day-cell ${filled ? 'filled' : day === state.day ? 'current' : day < state.day ? 'missed' : ''}"><span class="day-mark" title="День ${day}: ${filled ? 'есть запись' : 'нет записи'}">${filled ? '✓' : day < state.day ? '·' : ''}</span><span>${day}</span></div>`; }).join('')}</div><p class="coverage-note">Есть записи за ${state.stats.recorded} из ${state.stats.expected} дней наблюдения${state.stats.missing ? `; за ${state.stats.missing} дней состояние неизвестно` : ''}. ${state.stats.baselineRecorded ? 'Включена дополнительная запись дня 0 — дня исходного скрининга.' : 'День исходного скрининга в этот счёт не входит.'}</p></section>`;
}
function miniScores() {
  const a = state.assessments.at(-1), scores = scoreAssessment(a);
  return `<section class="card"><div class="card-header"><h2>Последние анкеты</h2><a class="text-link" href="#results">Подробнее →</a></div>${['phq', 'gad'].map(k => `<div class="mini-score"><div><strong>${FORMS[k].name}</strong><small>${k === 'phq' ? 'Депрессивные симптомы' : 'Тревожные симптомы'}</small></div><div class="number">${scores[k].score}<span> / ${FORMS[k].max}</span></div></div>`).join('')}<div class="card-date">${h(dateLabel(a.date))} · за предыдущие две недели</div></section>`;
}
function miniAppointment() {
  const plan = state.carePlan, date = plan?.nextDate || state.appointment.date, time = plan?.nextDate ? plan.nextTime : state.appointment.time;
  return `<section class="card"><div class="card-header"><h2>Следующий контакт</h2>${icon('visit')}</div>${date ? `<div class="appointment-mini">${h(dateLabel(date))}<span>${h(time)} · ${plan?.nextDate ? 'из демоплана врача' : 'дата введена вами'}</span></div>` : '<p>Договоритесь с направившим врачом или психиатром о сроке консультации. Приложение не записывает на приём.</p>'}<a class="text-link" href="#visit">${date ? 'Подготовиться к приёму' : 'Указать дату и собрать сводку'} →</a></section>`;
}
function journey() {
  const steps = [[0, 'Исходная точка', 'PHQ-9, GAD-7 и контекст'], [1, 'Дни 1–6', 'Короткие ежедневные записи'], [7, 'День 7', 'Проверка изменений'], [8, 'Дни 8–13', 'Записи и подготовка к контакту'], [14, 'День 14', 'Повтор анкет и сводка']];
  return `<section class="card"><h2>Ближайшие две недели</h2><p>Консультация может состояться раньше. Дневник не является условием доступа к врачу.</p><div class="journey">${steps.map(([day, title, text]) => `<div class="journey-item ${(day === 0 ? state.assessments.length : day === 1 ? state.diary.some(e => e.day >= 1 && e.day <= 6) : day === 7 ? state.diary.some(e => e.day >= 7 && e.change) : day === 8 ? state.diary.some(e => e.day >= 8 && e.day <= 13) : state.assessments.length > 1) ? 'complete' : ''}"><strong>${title}</strong>${text}</div>`).join('')}</div></section>`;
}
function empty(title, text, action = true) { return `<section class="card empty-state">${icon('diary')}<h2>${title}</h2><p>${text}</p>${action ? actionButton('Начать ' + icon('arrow'), state.joined ? 'start' : 'to-welcome') : ''}</section>`; }
function results() {
  const head=heading('Результаты');
  if(!state.assessments.length)return head+`<section class="card patient-empty"><h2>Сначала закончим анкеты</h2><p>Результаты PHQ-9 и GAD-7 появятся после всех ответов. Незавершённые анкеты не считаются нулевым результатом.</p>${actionButton(state.flow?'Продолжить ответы':'Пройти анкеты',state.joined?'start':'to-welcome')}</section>`;
  const last=state.assessments.at(-1),first=state.assessments[0],scores=scoreAssessment(last),initial=scoreAssessment(first);
  return head+`${state.support?.urgent?recommendation():''}<p class="patient-section-note">${h(dateLabel(last.date))} · ответы за последние две недели</p><div class="patient-score-grid">${['phq','gad'].map(k=>scoreCard(k,scores[k],state.assessments.length>1?scores[k].score-initial[k].score:null)).join('')}</div><p class="patient-section-note">Это оценки симптомов по вашим ответам, а не диагноз.</p><section class="card patient-result-next"><h2>Что обсудить с врачом</h2><p>${h(last.context.goal||'Что беспокоит, как давно это началось и как мешает обычным делам.')}</p><p class="small muted">Обычные дела: ${h(FUNCTION_LABELS[last.context.function])}. Изменения: ${h(last.context.duration.toLowerCase())}.</p><a class="text-link" href="#visit">Открыть вопросы к приёму →</a></section><details class="patient-details"><summary>Все ответы и история анкет</summary>${state.assessments.length>1?`<div class="table-scroll"><table class="data-table"><thead><tr><th>Дата</th><th>PHQ-9</th><th>GAD-7</th></tr></thead><tbody>${state.assessments.map(a=>{const v=scoreAssessment(a);return `<tr><td>${h(dateLabel(a.date))}</td><td>${v.phq.score}/27</td><td>${v.gad.score}/21</td></tr>`;}).join('')}</tbody></table></div>`:''}${['phq','gad'].map(k=>`<h3>${FORMS[k].name}</h3><ol class="answer-list">${FORMS[k].items.map((text,i)=>{const value=last.answers[(k==='phq'?0:9)+i];return `<li><span>${h(text)}</span><span class="answer-value">${h(FREQUENCY[value])} · ${value}</span></li>`;}).join('')}</ol>`).join('')}<p class="small muted">Период ответов: ${h(dateLabel(last.window.start))} — ${h(dateLabel(last.window.end))}. Русские формы: А.А. Золотарева, 2023 (CC BY-NC 4.0).</p><button class="text-link" data-action="sources">Источники и ограничения</button></details>`;
}
function scoreCard(kind,score,delta=null) {
  const explanation=score.level<2?'Обсудите длительность симптомов и то, как они влияют на жизнь. Небольшая сумма не отменяет обращения, если вас что-то беспокоит.':'Симптомы заметны по ответам. Обсудите результат с врачом и договоритесь о следующем шаге.';
  return `<section class="card score-card"><div class="patient-score-name">${FORMS[kind].name}<span>${kind==='phq'?'Настроение':'Тревога'}</span></div><div class="score-big">${score.score}<span> / ${score.max}</span></div><div class="score-label">${h(score.label)}</div>${delta!==null?`<p class="patient-score-change">${delta>0?'+':''}${delta} к исходной точке</p>`:''}<details class="patient-score-explain"><summary>Что это значит</summary><p>${explanation}</p></details></section>`;
}
function diary() {
  let html = heading('Дневник самочувствия', 'Короткие записи про день. Оценки настроения и тревоги здесь — ваши личные отметки, они не являются PHQ-9 и GAD-7.', 'Мои записи', state.diaryAvailable ? actionButton('Добавить запись', 'start-diary') : '');
  html += voiceNotesSection(state.voiceNotes || []);
  if (!state.diary.length && state.appointment.attended) return html + empty('Этап завершён', 'Вы отметили состоявшийся приём. Сводка сохранена; дальнейший план определите с врачом.', false) + linkButton('Посмотреть сводку', 'visit');
  if (!state.diary.length) return html + empty('Первой записи пока нет', state.assessments.length ? 'На короткий дневник уйдёт около пары минут. Можно пропустить часы сна и необязательную заметку.' : 'Сначала заполните исходные анкеты. Со следующего дня приложение предложит короткую запись о самочувствии.', false) + (state.diaryAvailable ? actionButton('Сделать запись', 'start-diary') : state.assessments.length ? linkButton('Посмотреть сводку', 'visit') : actionButton('Открыть исходные анкеты', state.joined ? 'start' : 'to-welcome')) + safetyNotice();
  html += `<div class="home-grid"><section class="card"><div class="card-header"><h2>История записей</h2><span class="small muted">${state.diary.length} записей</span></div>${[...state.diary].reverse().map(e => `<article class="entry"><div class="entry-head"><h3>${h(dateLabel(e.date))}</h3><small>День ${e.day}${e.retrospective ? ' · внесено позже' : ''}</small></div><div class="entry-metrics"><div><span>Настроение</span><b>${e.mood}<span> / 10</span></b></div><div><span>Тревога</span><b>${e.anxiety}<span> / 10</span></b></div><div><span>Сон</span><b>${e.sleep === null ? '—' : n(e.sleep)}<span> ${e.sleep === null ? '' : 'ч'}</span></b></div><div><span>Обычные дела</span><b>${['Не мешало', 'Немного', 'Сильно', 'Не получалось'][e.function]}</b></div></div>${e.note ? `<p class="entry-note">${h(e.note)}</p>` : ''}${e.change ? `<p class="small muted">С начала наблюдения: ${h(e.change.toLowerCase())}.</p>` : ''}</article>`).join('')}</section><div class="stack">${progressCard()}${note('Не нужно восстанавливать пропущенные дни по памяти. Отсутствие записи отображается как «нет данных», а не как плохое или хорошее состояние.', 'Если пропустили день')}<button class="attention-link" data-action="help">${icon('help')}Мне нужна помощь раньше</button></div></div>`;
  return html;
}
function buildChart() {
  const width = window.innerWidth < 700 ? 340 : 620, height = 245, left = 31, right = 17, top = 18, bottom = 37;
  const max = chartMode === 'sleep' ? Math.max(12, ...state.diary.map(e => e.sleep || 0)) : 10;
  const firstDay = state.stats.baselineRecorded ? 0 : 1;
  const x = day => left + (day - firstDay) / (14 - firstDay) * (width - left - right);
  const y = value => top + (max - Math.min(max, value)) / max * (height - top - bottom);
  const records = state.diary.filter(e => e.day >= firstDay && e.day <= Math.min(state.day, 14));
  const line = (field, className) => {
    let paths = '', previous = null;
    for (const entry of records) {
      if (entry[field] === null) { previous = null; continue; }
      if (previous && entry.day === previous.day + 1) paths += `<path class="${className}-line" d="M${x(previous.day)},${y(previous[field])} L${x(entry.day)},${y(entry[field])}"/>`;
      previous = entry;
    }
    return paths + records.filter(e => e[field] !== null).map(e => `<circle class="${className}-dot" cx="${x(e.day)}" cy="${y(e[field])}" r="3.7"><title>День ${e.day}: ${n(e[field])}${chartMode === 'sleep' ? ' ч' : ' из 10'}</title></circle>`).join('');
  };
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-description"><title id="chart-title">${chartMode === 'sleep' ? 'Продолжительность сна' : 'Настроение и тревога'} по дням</title><desc id="chart-description">${records.length} записей. Линии прерываются на пропусках. Числа доступны в таблице под графиком.</desc>${[0, max / 2, max].map(v => `<line class="grid-line" x1="${left}" y1="${y(v)}" x2="${width - right}" y2="${y(v)}"/><text x="3" y="${y(v) + 4}">${v}</text>`).join('')}${[firstDay, 3, 5, 7, 9, 11, 14].map(v => `<text x="${x(v)}" y="${height - 13}" text-anchor="middle">${v}</text>`).join('')}${chartMode === 'sleep' ? line('sleep', 'mood') : line('mood', 'mood') + line('anxiety', 'anxiety')}</svg>`;
}
function dynamics() {
  const head=heading('Динамика');
  if(!state.diary.length)return head+`<section class="card patient-empty"><h2>График появится после записи</h2><p>Отметьте настроение, тревогу и сон. Пропущенные дни останутся без данных.</p>${linkButton('Открыть дневник','diary')}</section>`;
  const stats=state.stats,firstDay=stats.baselineRecorded?0:1;
  return head+`${state.support?.urgent?recommendation():''}<section class="card patient-chart-card"><div class="patient-chart-controls" role="group" aria-label="Показатель графика"><button data-action="chart" data-value="feelings" aria-pressed="${chartMode==='feelings'}">Настроение и тревога</button><button data-action="chart" data-value="sleep" aria-pressed="${chartMode==='sleep'}">Сон</button></div><div class="chart-wrap">${buildChart()}</div><div class="legend">${chartMode==='sleep'?'<span><i class="dot line"></i>Сон, часы</span>':'<span><i class="dot line"></i>Настроение · выше лучше</span><span><i class="dot red line"></i>Тревога · выше сильнее</span>'}</div><p class="patient-section-note">Дни ${firstDay}–14 · разрыв линии означает пропуск</p><div class="metric-grid"><div class="metric-box"><small>Настроение</small><strong>${n(stats.mood)}<span>/10</span></strong></div><div class="metric-box"><small>Тревога</small><strong>${n(stats.anxiety)}<span>/10</span></strong></div><div class="metric-box"><small>Сон</small><strong>${stats.sleep===null?'—':n(stats.sleep)}<span>${stats.sleep===null?'':'ч'}</span></strong></div></div><p class="patient-section-note">Среднее по заполненным значениям. Дневник: ${stats.recorded} из ${stats.expected} дней, сон: ${stats.sleepCount} ответов.</p></section><details class="patient-details"><summary>Как читать график и сравнивать записи</summary><p>Настроение: 0 — очень плохое, 10 — очень хорошее. Тревога: 0 — её нет, 10 — очень сильная. Длительность сна не показывает его качество. Это авторский дневник, не диагностическая шкала.</p>${stats.comparison?`<p>В первых трёх записях настроение в среднем ${n(stats.comparison.firstMood)}/10, тревога ${n(stats.comparison.firstAnxiety)}/10; в последних трёх — ${n(stats.comparison.recentMood)}/10 и ${n(stats.comparison.recentAnxiety)}/10. Это сравнение отдельных заполненных дней, а не доказательство улучшения или эффекта лечения.</p>`:'<p>После шести записей появится сравнение начала и конца периода.</p>'}<p>За ${stats.missing} дней состояние неизвестно. Пропуски не заменяются нулями.</p></details><details class="patient-details"><summary>Данные по дням</summary><div class="table-scroll"><table class="data-table"><thead><tr><th>День</th><th>Настроение</th><th>Тревога</th><th>Сон, ч</th></tr></thead><tbody>${Array.from({length:Math.max(0,Math.min(14,state.day)-firstDay+1)},(_,i)=>{const day=i+firstDay,e=state.diary.find(e=>e.day===day);return `<tr><td>${day}</td><td>${e?e.mood:'нет данных'}</td><td>${e?e.anxiety:'нет данных'}</td><td>${e?n(e.sleep):'нет данных'}</td></tr>`;}).join('')}</tbody></table></div></details>`;
}
function legacySummaryText() {
  const first = state.assessments[0], last = state.assessments.at(-1), s = last && scoreAssessment(last), f = first && scoreAssessment(first), stats = state.stats;
  return `ТРЕКЕР СЕЧЕНОВКА — ТЕСТОВАЯ СВОДКА\nСформирована ${dateLabel(state.today)}. Все данные демонстрационные.\nСамоотчёт, не диагноз. Врачом не проверено.\n\nПРИЧИНА И КОНТЕКСТ\n${last?.context.goal || 'Главный вопрос не указан.'}\nДлительность: ${last?.context.duration || 'не указана'}.\nВлияние на обычные дела: ${last ? FUNCTION_LABELS[last.context.function] : 'не оценено'}.\n\nАНКЕТЫ\n${first ? `Исходно ${dateLabel(first.date)}: PHQ-9 ${f.phq.score}/27, GAD-7 ${f.gad.score}/21.` : 'Исходные анкеты не завершены.'}\n${last && last !== first ? `Повтор ${dateLabel(last.date)}: PHQ-9 ${s.phq.score}/27, GAD-7 ${s.gad.score}/21.` : 'Повторных анкет пока нет.'}\nКаждая анкета: предшествующие две недели, русская форма А.А. Золотаревой (2023).\n\nДНЕВНИК\nЗаписи за ${stats.recorded} из ${stats.expected} дней; ${stats.missing} без данных.${stats.baselineRecorded ? " Включена запись дня исходного скрининга (день 0)." : ""}\nНастроение в среднем ${n(stats.mood)}/10; тревога ${n(stats.anxiety)}/10.\nСон ${n(stats.sleep)} ч (заполнено ${stats.sleepCount} значений). Пропуски не заменялись нулями.\n${state.diary.filter(e => e.note).map(e => `${dateLabel(e.date)}: ${e.note}`).join('\n') || 'Дополнительных заметок нет.'}\n\nВОПРОСЫ БЕЗОПАСНОСТИ\n${state.safetyEvents.length ? state.safetyEvents.map(e => `${e.at}: ${e.source}; ответ — ${e.level === 'contact' ? 'сейчас нет' : e.level === 'urgent' ? 'да / не уверен(а)' : 'не хочу отвечать'}.`).join('\n') : 'Отдельных обращений о безопасности не зафиксировано. Это не подтверждение отсутствия риска.'}\n${last ? `Пункт 9 PHQ-9: ${last.answers[8]} из 3.` : ''}\n\nКОНТАКТ С ВРАЧОМ\n${state.appointment.date ? `${dateLabel(state.appointment.date)}, ${state.appointment.time}; дата введена пользователем, запись клиникой не подтверждена.` : 'Дата контакта не указана; запись не организована.'}\nГлавный вопрос: ${state.appointment.question || 'не указан'}.\n\nЧТО НУЖНО УТОЧНИТЬ НА ПРИЁМЕ\nДиагноз и клинический маршрут; безопасность; соматические причины; предыдущие эпизоды и необычная активация; текущие лекарства и вещества; личные цели. Лечение, диагноз и назначения в прототипе не подтверждались.`;
}
function connectionCard() {
  if (!state.connection?.available) return '';
  const c = state.connection;
  return `<section class="card" id="connection-panel"><div class="card-header"><h2>Связь с кабинетом</h2><span class="pill">${c.enabled ? 'Подключено' : 'По вашему согласию'}</span></div>${c.enabled ? `<p><strong>${h(c.name || 'Мой тестовый профиль')}</strong><br>Код для врача: <strong>${h(c.code)}</strong></p><p>Анкеты, дневник и вопрос к приёму доступны в закрытом учебном кабинете. Новые записи обновляются автоматически.</p><div class="row">${actionButton('Изменить имя', 'connect-doctor', true)}${actionButton('Отключить передачу', 'disconnect-doctor', true)}</div>` : `<p>Передайте результаты и дневник в учебный кабинет психиатра. Врач сможет подготовиться к беседе, а вы увидите подтверждённый план здесь.</p>${state.joined ? actionButton('Передать тестовый профиль', 'connect-doctor') : '<p>Сначала подтвердите возраст и условия демонстрации.</p>'}`}<p class="small muted">Только вымышленные данные. Передача не означает запись на приём. Данные не просматриваются круглосуточно.</p></section>`;
}
function connectionDialog() {
  showModal('Передать профиль в учебный кабинет', `<p>Психиатру будут доступны завершённые и незавершённые PHQ-9 и GAD-7, отдельные ответы о безопасности, дневник и подготовка к приёму. Новые записи будут обновляться автоматически.</p><p>Доступ к кабинету защищён отдельным входом. Это учебная версия: вводите только придуманные сведения. Передачу можно отключить; это не удаление уже сохранённой истории.</p><form id="connection-form"><label class="form-field">Имя или псевдоним · необязательно<input name="name" maxlength="60" value="${h(state.connection?.name || '')}" placeholder="Например, Тестовый пациент" autocomplete="off"></label><p class="small muted">Telegram-имя и номер телефона не передаются. Без имени будет виден только код профиля.</p><label class="check-row"><input type="checkbox" name="consent" required><span>Разрешаю передать вымышленные данные в учебный кабинет и понимаю, что врач не наблюдает за ними постоянно.</span></label><button class="button" type="submit">${state.connection?.enabled ? 'Сохранить' : 'Подключить профиль'}</button></form>`);
}
function carePlanCard() {
  const plan = state.carePlan;
  if (!plan) return '';
  return `<section class="card section-gap"><div class="card-header"><h2>Согласованный план · демо</h2><span class="pill">Подтверждён в кабинете</span></div><p>План из учебного кабинета психиатра. Это учебная запись, реальное врачебное ведение не подключено.</p><dl class="care-plan-fields">${[['Цель', plan.goal], ['Что делать', plan.plan], ['Что отмечать', plan.watch], ['Когда связаться раньше', plan.earlyContact], ['Следующий контакт', dateLabel(plan.nextDate) + ', ' + plan.nextTime + ' · ' + (plan.timeZone || state.reminders.timeZone)]].map(([label, value]) => `<div><dt>${h(label)}</dt><dd>${h(value)}</dd></div>`).join('')}</dl></section>`;
}
function visit() {
  const prep=visitPreparation(state),draft=appointmentDrafts.get(state.episodeId)||state.appointment;
  return heading('К приёму')+`${state.support?.urgent?recommendation():''}<section class="card patient-visit-prep" id="visit-prep-panel"><div class="card-header"><h2>С чего начать разговор</h2><button class="text-link" data-action="copy-visit-note">Копировать</button></div><p class="patient-opening">${h(prep.opening)}</p><h3>Спросите врача</h3><ol class="patient-visit-questions">${prep.questions.map(q=>`<li>${h(q.text)}</li>`).join('')}</ol><p class="patient-section-note">Возьмите список лекарств и БАДов с дозами. Для обращения к врачу не нужно ждать 14 дней или окончания анкет.</p></section><div id="care-plan-panel">${carePlanCard()}</div><details class="patient-details patient-visit-settings"><summary>Дата приёма и передача профиля</summary><section class="card"><h2>Заметка о контакте</h2><p class="small muted">Укажите уже согласованную дату. Приложение не записывает в клинику.</p><form id="appointment-form"><div class="form-row"><label class="form-field">Дата<input type="date" name="date" value="${h(draft.date)}"></label><label class="form-field">Время<input type="time" name="time" value="${h(draft.time)}" required></label></div><label class="form-field">Главный вопрос<textarea name="question" maxlength="1000" placeholder="Что хотелось бы понять?">${h(draft.question)}</textarea></label><button class="button" type="submit">Сохранить к приёму</button></form></section>${connectionCard()}${!state.appointment.attended?'<button class="text-link" data-action="attended-confirm">Приём уже состоялся →</button>':note('Напоминания выключены. Дальнейший план согласуйте с врачом.','Приём отмечен')}</details><details class="patient-details"><summary>Полная сводка и скачивание</summary><p class="small muted">Самоотчёт, не медицинское заключение.</p><pre id="summary-text" class="summary-box">${h(summaryText())}</pre><div class="row"><button class="button" data-action="download-summary">Скачать TXT</button><button class="button secondary" data-action="copy-summary">Копировать сводку</button></div></details>`;
}
function settings() {
  reminderCount = state.reminders.times.length;
  const deliveryNote = state.telegram?.authenticated
    ? state.telegram.messagesEnabled && state.telegram.remindersScheduled
      ? note('Сообщения придут в Telegram. В бесплатной демонстрации расписание проверяется примерно раз в 30 минут: возможны задержки. После завершения задания остальные напоминания сегодня отменяются. Выключить их можно здесь или командой /stop в боте.', 'Напоминания в Telegram')
      : note('Для сообщений откройте бота и нажмите /start. Доставка по расписанию доступна после подключения планировщика.', 'Подключение напоминаний')
    : note('Этот браузерный профиль работает отдельно от Telegram. Для общей истории откройте дневник кнопкой под сообщением бота или через его меню. Кнопка симуляции ниже проверяет только этот тестовый профиль.', 'Браузерная демонстрация');
  return heading('Напоминания', 'До трёх попыток напомнить об одном задании. После его завершения остальные сообщения в этот день отменяются.') + `<div class="two-col"><section class="card"><h2>Когда вам удобно</h2><form id="reminders-form" class="section-gap"><label class="check-row"><input name="enabled" type="checkbox" ${state.reminders.enabled ? 'checked' : ''}><span>Напоминать о запланированной записи</span></label><span class="small muted">Сколько раз можно напомнить за день</span><div class="count-options">${[1, 2, 3].map(v => `<label><input type="radio" name="count" value="${v}" ${reminderCount === v ? 'checked' : ''}><span>${v} ${v === 1 ? 'раз' : 'раза'}</span></label>`).join('')}</div><div id="time-fields" class="time-row">${reminderFields(reminderCount)}</div><label class="form-field section-gap">Часовой пояс<select name="timeZone">${[['Europe/Kaliningrad', 'Калининград · UTC+2'], ['Europe/Moscow', 'Москва · UTC+3'], ['Asia/Yekaterinburg', 'Екатеринбург · UTC+5'], ['Asia/Novosibirsk', 'Новосибирск · UTC+7'], ['Asia/Vladivostok', 'Владивосток · UTC+10'], ['Asia/Kamchatka', 'Камчатка · UTC+12']].map(([v, label]) => `<option value="${v}" ${state.reminders.timeZone === v ? 'selected' : ''}>${label}</option>`).join('')}</select><span>Даты новых записей и напоминаний определяются в этом поясе. Даты сохранённых записей не меняются.</span></label><button class="button" type="submit">Сохранить расписание</button></form><p>Полные PHQ-9 и GAD-7 проходят в начале и повторно на 14-й день. Между ними напоминание относится к короткому дневнику, а не к повторению двухнедельных анкет.</p></section><div class="stack"><section class="card"><div class="card-header"><h2>Как это работает сейчас</h2>${icon('bell')}</div>${deliveryNote}<p>${state.task.kind === 'done' ? 'Задание за сегодня завершено. Сегодня больше не напоминаем.' : state.nextReminder ? `Ближайшее: ${h(dateLabel(state.nextReminder.date))}, ${h(state.nextReminder.time)}.` : 'Ближайших напоминаний нет. Проверьте, включено ли расписание и есть ли задание.'}</p><button class="text-link" data-action="simulate-reminder">Переместить демо к ближайшему напоминанию →</button><a class="text-link" href="${h(botUrl())}">Посмотреть сообщения бота →</a></section><section class="card"><h2>Последние напоминания</h2>${state.deliveries.length ? [...state.deliveries].reverse().slice(0, 5).map(d => `<div class="notification-log"><strong>${h(d.task)}</strong><span>${h(dateLabel(d.date))}, ${h(d.time)} · ${d.transport === 'telegram' ? 'отправлено в Telegram' : 'показано в симуляторе'}</span></div>`).join('') : '<p>Пока нет доставленных напоминаний.</p>'}</section><section class="card"><h2>Установка на телефон</h2><p>В Safari: «Поделиться» → «На экран Домой». В Chrome: меню → «Установить приложение». Для сохранения ответов и загрузки данных нужен доступ к интернету и работающий сервис. При ошибке соединения приложение предложит повторить действие.</p></section></div></div>`;
}
function reminderFields(count) { return Array.from({ length: count }, (_, i) => `<label>Напоминание ${i + 1}<input type="time" name="time-${i}" value="${h(state.reminders.times[i] || ['09:00', '14:00', '20:00'][i])}" required></label>`).join(''); }
function flow() {
  const f = state.flow;
  if (!f) return heading('Запланированное задание') + empty('Текущего задания нет', 'Вернитесь на главный экран, чтобы увидеть следующий шаг.', false) + linkButton('На сегодня', 'today');
  if (state.safety?.needsGuidance && !state.safety.pending) return heading('Сейчас важнее получить помощь', 'Обычный опрос поставлен на паузу.') + '<section class="card">' + note(h(URGENT_TEXT), 'При непосредственной опасности', 'red') + '<p class="section-gap small muted">Приложение не вызывает помощь и не отправляет экстренное уведомление врачу. Если непосредственной опасности нет, обсудите отмеченные мысли с врачом как можно скорее.</p><div class="row section-gap"><a class="button danger" href="tel:112">Позвонить 112</a><button class="text-link" data-action="resume-after-help">Вернуться к заданию</button></div></section>';
  const q = f.question;
  const scale = f.kind === 'assessment' && q.kind;
  const stale = f.kind === 'assessment' && Date.parse(state.now) - Date.parse(f.startedAt) > 86400000;
  let input;
  if (q.options) input = `<div class="${q.type === 'number' ? 'number-options' : 'option-list'}">${q.options.map((o, i) => `<button class="answer-button ${f.selected === o.value ? 'chosen' : ''}" data-action="answer-option" data-option="${i}">${scale ? `<span class="option-number">${o.value}</span>` : ''}<span>${h(o.label)}</span></button>`).join('')}</div>${q.minLabel ? `<div class="range-labels"><span>${q.minLabel}</span><span>${q.maxLabel}</span></div>` : ''}`;
  else input = `<form id="answer-form">${q.type === 'sleep' ? `<label class="form-field">Часы сна<input name="answer" type="number" inputmode="decimal" min="0" max="24" step="0.5" placeholder="Например, 7,5" value="${f.selected === null ? '' : h(f.selected)}"><span>Если не помните, можно пропустить. Пропуск не считается нулём часов.</span></label>` : `<label class="form-field"><span class="sr-only">Ваш ответ</span><textarea name="answer" maxlength="1000" placeholder="${h(q.placeholder)}">${h(f.selected || '')}</textarea></label>`}<div class="row"><button class="button" type="submit">Сохранить и продолжить ${icon('arrow')}</button>${q.optional ? '<button class="text-link" data-action="skip" type="button">Пропустить</button>' : ''}</div></form>`;
  return `<div class="question-shell"><div class="question-top"><a href="#today" class="text-link">${icon('back')}На сегодня</a><span>${f.kind === 'safety' ? 'Уточнение' : `${f.cursor + 1} из ${f.total}`}</span></div>${f.kind !== 'safety' ? `<div class="progress-track" aria-label="Отвечено ${f.cursor} из ${f.total}">${Array.from({ length: f.total }, (_, i) => `<span class="${i < f.cursor ? 'filled' : ''}"></span>`).join('')}</div>` : ''}${stale ? `<div class="error-box">С начала анкет прошли сутки. Начните заново, чтобы ответы относились к одному периоду.<div>${actionButton('Начать заново', 'restart')}</div></div>` : ''}<section class="card question-card"><div class="question-window">${scale ? `${FORMS[q.kind].name} · вопрос ${q.index + 1} из ${FORMS[q.kind].items.length}<br>` : ''}${h(q.window)}</div>${scale && q.index === 0 ? `<p class="question-instruction">${h(INSTRUCTION)} Для ответов используйте варианты ниже.</p>` : ''}<h1 tabindex="-1">${h(q.text)}</h1>${f.kind === 'safety' ? note('Этот ответ не заменяет клиническую оценку. Если опасность есть сейчас, не ждите завершения анкеты или ответа в чате. При непосредственной опасности — 112.', 'Врач не следит за ответами онлайн', 'red') : ''}<div class="${f.kind === 'safety' ? 'section-gap' : ''}">${input}</div>${f.kind !== 'safety' ? `<div class="question-actions"><button class="text-link" data-action="back" ${f.cursor === 0 ? 'disabled' : ''}>${icon('back')}Предыдущий вопрос</button><a class="text-link" href="${h(botUrl())}">Продолжить в боте →</a></div>` : ''}</section>${safetyNotice()}<p class="question-footnote">Ответы сохраняются после каждого шага.<br>${f.kind === 'assessment' ? 'Русские формы: А.А. Золотарева, 2023. Порядок вопросов, варианты ответов и двухнедельное окно сохранены.' : 'Дневник — авторская форма самоотчёта. Врач прочитает записи только когда вы их покажете.'}</p>${f.kind !== 'safety' ? '<button class="attention-link" data-action="help">Мне нужна помощь раньше</button>' : ''}</div>`;
}
function summaryText() {
  const c = state.healthContext;
  const context = c ? `\n\nДОПОЛНИТЕЛЬНЫЕ СВЕДЕНИЯ · СО СЛОВ\nОбновлено ${c.at}.\nТрудности: ${c.functionExample || 'не указаны'}.\nЛекарства и БАДы: ${c.medicines || 'не указаны'}.\nПредыдущее лечение: ${c.previousTreatment || 'не указано'}.\nЗаболевания и вещества: ${c.conditions || 'не указаны'}.\nНеобычная активность и меньшая потребность во сне: ${{ yes: 'отмечены, требуют уточнения', no: 'не отмечены в дополнительном вопросе; это не исключает расстройство', unknown: 'не оценено' }[c.activation]}.` : '';
  const reports = (state.treatmentCheckins || []).map(r => `${r.date}: выполнение плана — ${{ taken: 'полностью', partly: 'частично', missed: 'не выполнено', 'not-prescribed': 'плана / назначений нет', unknown: 'не оцениваю' }[r.adherence]}; явление — ${{ drowsy: 'сонливость', dizzy: 'головокружение', other: 'другое', none: 'не отмечаю', unknown: 'не оцениваю' }[r.effect]}; влияние ${r.impact}/3. ${r.note || ''} Изменения средств со слов: ${r.changes || 'не указаны'}.`).join('\n');
  const draft = !state.aiSupport?.stale && !state.support?.urgent ? state.aiSupport?.draft : null;
  const ai = draft ? `\n\nКРАТКИЙ РАЗБОР · НЕ ДИАГНОЗ И НЕ НАЗНАЧЕНИЕ\n${draft.generatedAt} · ${draft.model}\n${draft.facts.map(f => f.text).join('\n')}\nВопросы к беседе:\n${draft.questions.map(q => q.text).join('\n')}` : '';
  return legacySummaryText() + ((state.voiceNotes || []).filter(n => !n.archivedAt).map(voiceText).join('\n\n') ? '\n\nЗАМЕТКИ СВОИМИ СЛОВАМИ\n' + (state.voiceNotes || []).filter(n => !n.archivedAt).map(voiceText).join('\n\n') : '') + (state.carePlan?.nextDate ? `\n\nКОНТАКТ ИЗ ДЕМОПЛАНА ВРАЧА\n${dateLabel(state.carePlan.nextDate)}, ${state.carePlan.nextTime} (${state.carePlan.timeZone}). Эта дата приоритетна для сводки; запись в клинику не создана.` : '') + context + (reports ? '\n\nВЫПОЛНЕНИЕ ПЛАНА И НОВЫЕ ЯВЛЕНИЯ · САМООТЧЁТ\n' + reports + '\nСхема и число доз не проверены; процент приверженности и причинная связь с лечением не устанавливаются.' : '') + ai;
}
function receipt(kind) {
  if ((kind === 'assessment' && !state.assessments.length) || (kind === 'diary' && !state.diary.length)) return empty('Завершённых ответов пока нет', 'Перейдите на главный экран и выполните запланированное задание.', false) + linkButton('На сегодня', 'today');
  const a = state.assessments.at(-1), scores = a && scoreAssessment(a);
  return `<section class="card receipt-card"><div class="receipt-check">${icon('check')}</div><h1 tabindex="-1">${kind === 'assessment' ? 'Анкеты завершены' : 'Запись сохранена'}</h1><p>${kind === 'assessment' ? `Вы ответили на все 16 вопросов и добавили контекст. PHQ-9: ${scores?.phq.score ?? '—'} из 27. GAD-7: ${scores?.gad.score ?? '—'} из 21. Ниже — расшифровка и следующий шаг.` : 'Вы отметили настроение, тревогу, сон и влияние на дела. Запись появилась в истории и на графике. Пропущенные поля остаются без данных.'}<br>${state.task.kind === "assessment" ? "Повтор PHQ-9 и GAD-7 ещё не заполнен. Запись дневника его не заменяет; напоминания о повторе остаются." : "Напоминаний о выполненном задании сегодня больше не будет."}</p><div class="row receipt-actions">${linkButton(kind === 'assessment' ? 'Понять результаты' : 'Посмотреть динамику', kind === 'assessment' ? 'results' : 'dynamics')}${linkButton('Мой разбор', 'support', true)}${linkButton('На сегодня', 'today', true)}</div></section><div class="section-gap">${recommendation()}</div><div class="two-col section-gap"><section class="card"><h2>Задайте удобное время</h2><p>Одна короткая запись в день. От одного до трёх напоминаний, пока задание не завершено.</p><a class="text-link" href="#settings">Настроить напоминания →</a></section>${miniAppointment()}</div>`;
}
function showToast(text, error = false) {
  const toast = document.getElementById('toast'); clearTimeout(toastTimer); toast.textContent = text; toast.classList.toggle('error', error); toast.hidden = false; toastTimer = setTimeout(() => toast.hidden = true, error ? 6000 : 3200);
}
function showModal(title, content) { modal.innerHTML = `<div class="modal-head"><h2 id="modal-title">${title}</h2><button class="close" data-action="close-modal" aria-label="Закрыть">×</button></div>${content}`; if (!modal.open) modal.showModal(); enhanceVoiceFields(modal, extra => openPatientVoice(extra)); }
function demoDialog() { showModal('Тестовые данные', `<p>Вымышленные данные хранятся в базе демонстрации. В Telegram бот и Mini App используют один профиль. Прямой сайт в браузере — отдельный профиль. После вашего согласия анкеты и дневник доступны в закрытом учебном кабинете психиатра. Настоящие пациенты и клиническая эксплуатация не подключены.</p><p>Демонстрационная дата: <strong>${h(dateLabel(state.today))}</strong>. День наблюдения: ${state.day}. Перемещение даты позволяет проверить двухнедельный путь.</p><div class="row">${actionButton('Следующий день', 'advance-one', true)}${actionButton('На 7 дней вперёд', 'advance-seven', true)}</div><hr><p>Пример содержит придуманные анкеты, записи и дату приёма. Загрузка заменит текущую тестовую историю.</p><div class="row">${actionButton('Загрузить пример за 13 дней', 'seed', true)}${actionButton('Начать с чистого профиля', 'reset-confirm', true)}</div><p><a class="source-link" href="${h(botUrl())}">Открыть диалог бота</a> · <a class="source-link" href="/">Памятка ВОП</a></p>`); }
function sourcesDialog() { showModal('Об анкетах и данных', `<p>PHQ-9: 9 ответов по 0–3, сумма 0–27. GAD-7: 7 ответов по 0–3, сумма 0–21. Окно каждой анкеты — последние две недели. Результаты описывают выраженность симптомов и не устанавливают диагноз.</p><p>Использованы тексты русских форм А.А. Золотаревой (2023), без изменения пунктов и вариантов ответов. Показ одного вопроса за раз — интерфейсная адаптация; этот цифровой формат отдельно не валидирован.</p><p><a class="source-link" href="https://psyjournals.ru/journals/cpse/archive/2023_n4/Zolotareva" target="_blank" rel="noopener noreferrer">PHQ-9: публикация и приложение</a><br><a class="source-link" href="https://psyjournals.ru/journals/cpp/archive/2023_n4/Zolotareva" target="_blank" rel="noopener noreferrer">GAD-7: публикация и приложение</a><br>© А.А. Золотарева, 2023. Публикации: <a class="source-link" href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noopener noreferrer">CC BY-NC 4.0</a>. Использование в коммерческом продукте требует отдельной проверки прав на эти русские формы.</p><p><a class="source-link" href="https://manual.jointcommission.org/pub/BHCInstruments/RomInstr00054/instructions_PHQ.pdf" target="_blank" rel="noopener noreferrer">Руководство разработчиков: подсчёт и зоны выраженности</a>. Пороги не используются для постановки диагноза или назначения лекарств.</p><p>Ежедневный дневник и график дней 1–14 — авторские продуктовые настройки. Врачом они не утверждены. Небольшая сумма баллов не отменяет необходимую консультацию. Вопросы о безопасности не образуют «рейтинг риска».</p><p>Вымышленные ответы сохраняются в базе демонстрации. В Telegram и Mini App используется один профиль. По отдельному согласию можно отправить вымышленные структурированные данные в OpenRouter для краткого разбора; имена, свободный текст и внутренняя запись врача туда не передаются. Бесплатный поставщик может хранить данные и использовать их для обучения. Удалить текущие тестовые данные можно через «Тестовые данные» → «Начать с чистого профиля».</p>`); }
async function act(action, options = {}) {
  if (busy) return;
  setBusy(true);
  const before = state.flow?.kind;
  const submittedQuestion = state.flow?.question?.id;
  const submittedValue = document.querySelector('#answer-form [name="answer"]')?.value;
  try {
    state = await sendAction(state, action);
    if (action.type === 'health-context') { const d = supportFormDrafts.get(state.episodeId); if (d) delete d.health; }
    if (action.type === 'treatment-checkin') { const d = supportFormDrafts.get(state.episodeId); if (d) delete d.treatment; }
    if (['reset', 'seed'].includes(action.type)) { supportFormDrafts.clear(); appointmentDrafts.clear(); }
    if(action.type==='appointment')appointmentDrafts.delete(state.episodeId);
    if (action.type === 'answer' && before === 'assessment' && !state.active) location.hash = 'saved-assessment';
    else if (action.type === 'answer' && before === 'diary' && !state.diaryDraft) location.hash = 'saved-diary';
    else if (options.route) location.hash = options.route;
    render();
    if (options.reveal) requestAnimationFrame(() => requestAnimationFrame(() => revealViewportElement(document.querySelector(options.reveal))));
    if (['answer', 'back', 'restart', 'resumeAfterHelp'].includes(action.type)) {
      document.querySelector('main h1')?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    if (options.message) showToast(options.message);
    if (before === 'safety' && action.type === 'answer' && state.safety?.level !== 'contact') showModal('Помощь важнее анкеты', `<div class="notice red">${h(URGENT_TEXT)}</div><p>Прототип не вызывает помощь и не отправляет экстренное сообщение врачу. При возможности попросите человека, которому доверяете, побыть рядом.</p><a class="button danger" href="tel:112">Позвонить 112</a><p>Если непосредственной опасности нет, всё равно обсудите ответ с врачом как можно скорее.</p>`);
  } catch (error) {
    if (error.state) state = error.state;
    else if (error.uncertain) { try { state = await getState(); } catch { /* Keep the last confirmed state; retry remains explicit. */ } }
    render();
    const answerInput = document.querySelector('#answer-form [name="answer"]');
    if (answerInput && submittedValue !== undefined && state.flow?.question?.id === submittedQuestion) answerInput.value = submittedValue;
    showToast(error.message, true);
  } finally { setBusy(false); }
}
async function start(kind) { if (!state.joined) { location.hash = 'today'; return; } if (state.flow) { location.hash = 'flow'; render(); return; } await act({ type: 'start', kind }, { route: 'flow' }); }
document.addEventListener('click', async event => {
  const telegramLink = event.target.closest('a[href^="https://t.me/"]');
  if (telegramLink && globalThis.Telegram?.WebApp?.openTelegramLink && state.telegram?.authenticated) { event.preventDefault(); globalThis.Telegram.WebApp.openTelegramLink(telegramLink.href); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const name = button.dataset.action;
  if (name === 'open-recommendations') { location.hash='support'; return; }
  if (name === 'close-modal') { modal.close(); return; }
  if (name === 'demo') return demoDialog();
  if (name === 'sources') return sourcesDialog();
  if (name === 'to-welcome') { location.hash = 'today'; return; }
  if (name === 'connect-doctor') { connectionDialog(); return; }
  if (name === 'disconnect-doctor') { showModal('Отключить передачу данных?', `<p>Профиль исчезнет из списка учебного кабинета. Новые записи не будут передаваться, карточка станет недоступна. Ваши ответы и ранее подтверждённый план сохранятся.</p><div class="row">${actionButton('Отключить передачу', 'disconnect-doctor-confirm')}${actionButton('Оставить подключение', 'close-modal', true)}</div>`); return; }
  if (name === 'disconnect-doctor-confirm') { modal.close(); await act({ type: 'disconnect-doctor' }, { message: 'Передача в кабинет отключена' }); return; }
  if (name === 'join') { if (!document.getElementById('adult-confirm')?.checked) return showToast('Подтвердите возраст и условия демонстрации', true); await act({ type: 'join', adult: true }); await start(); return; }
  if (name === 'patient-ai-info') {
    showModal('Короткий разбор тестовых данных', '<p>В OpenRouter будут отправлены вымышленные баллы анкет, даты и закрытые ответы. Имена, Telegram ID, свободные заметки, перечень лекарств и запись врача не отправляются. Бесплатный провайдер может хранить данные и использовать их для обучения.</p><p>ИИ выбирает главное из готовых фактов и подсказок. Он не ставит диагноз, не назначает лекарства и не изменяет план врача.</p><label class="confirm-check"><input type="checkbox" id="patient-ai-consent">Подтверждаю: данные вымышленные, согласен(на) на указанную обработку.</label><div class="row"><button class="button secondary" data-action="close-modal">Вернуться</button><button class="button" data-action="patient-ai-generate">Подготовить разбор</button></div>'); return;
  }
  if (name === 'patient-ai-generate') {
    if (patientAiBusy || !document.querySelector('#patient-ai-consent')?.checked) return showToast('Подтвердите обработку только вымышленных данных', true);
    modal.close(); patientAiBusy = true; patientAiError = '';
    const updateCard = () => { if(recommendationsOpen('patient'))showPatientRecommendations(); };
    updateCard();
    try { await generatePatientSupport(state); const next = await getState(); if (next.revision >= state.revision) state = next; showToast('Короткий разбор сохранён. Он доступен и в боте: /insights.'); }
    catch (error) { patientAiError = error.message; showToast(error.message, true); }
    finally { patientAiBusy = false; updateCard(); for (const [id, renderer] of [['support-step', renderSupportStep], ['support-questions', renderSupportQuestions]]) { const el = document.getElementById(id); if (el) el.outerHTML = renderer(state); } }
    return;
  }
  if (name === 'support-done' || name === 'support-skip') return act({ type: 'support-feedback', stepId: button.dataset.step, status: name === 'support-done' ? 'done' : 'skip' }, { message: name === 'support-done' ? 'Отмечено: сделано сегодня' : 'Выбран другой вариант' });
  if (name === 'support-question') {
    const q = state.support.questions.find(q => q.id === button.dataset.question);
    if (!q) return;
    const old = state.appointment.question, next = old.includes(q.text) ? old : [old, q.text].filter(Boolean).join('\n');
    if (next.length > 1000) return showToast('Вопрос уже длинный. Отредактируйте его в разделе «К приёму».', true);
    return act({ type: 'appointment', date: state.appointment.date, time: state.appointment.time, question: next }, { message: 'Вопрос сохранён. Проверить его можно в разделе «К приёму».' });
  }
  if (name === 'start' || name === 'start-diary') return start(name === 'start-diary' ? 'diary' : undefined);
  if (name === 'answer-option') { const f = state.flow; return act({ type: 'answer', questionId: f.question.id, value: f.question.options[Number(button.dataset.option)].value }); }
  if (name === 'skip') return act({ type: 'answer', questionId: state.flow.question.id, value: state.flow.question.type === 'sleep' ? null : '' });
  if (name === 'resume-after-help') return act({ type: 'resumeAfterHelp' }, { route: 'flow' });
  if (name === 'back' || name === 'restart') return act({ type: name });
  if (name === 'help') { await act({ type: 'help' }, { route: 'flow' }); window.scrollTo({ top: 0 }); return; }
  if (name === 'chart') { chartMode = button.dataset.value; render(); return; }
  if (name === 'seed-confirm') { showModal('Посмотреть вымышленную историю', '<p>Откроется пример за 13 дней: исходные анкеты, дневник с пропусками и демонстрационная дата приёма. Текущие тестовые ответы будут заменены.</p>' + actionButton('Открыть пример', 'seed')); return; }
  if (name === 'seed' || name === 'reset') { modal.close(); await act({ type: name }, { route: 'today', message: name === 'seed' ? 'Загружена вымышленная история за 13 дней' : 'Открыт чистый тестовый профиль' }); return; }
  if (name === 'reset-confirm') { showModal('Начать с чистого профиля', '<p>Текущие вымышленные ответы, дневник и расписание будут удалены из этого тестового профиля.</p>' + actionButton('Очистить тестовые данные', 'reset')); return; }
  if (name === 'advance-one' || name === 'advance-seven') { await act({ type: 'advance', days: name === 'advance-one' ? 1 : 7 }, { message: 'Демонстрационная дата изменена' }); demoDialog(); return; }
  if (name === 'simulate-reminder') return act({ type: 'simulateReminder' }, { message: 'Демо перемещено к ближайшему напоминанию. Сообщение доступно в диалоге бота.' });
  if (name === 'download-summary') { const url = URL.createObjectURL(new Blob([summaryText()], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `sechenovka-summary-${state.today}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return; }
  if (name === 'copy-summary') { try { await navigator.clipboard.writeText(summaryText()); showToast('Сводка скопирована'); } catch { showToast('Не удалось скопировать. Можно скачать .txt.', true); } return; }
  if (name === 'attended-confirm') { showModal('Отметить состоявшийся приём', '<p>Напоминания этого этапа выключатся. Анкеты и записи останутся в сводке. Следующий план ведения нужно согласовать со специалистом.</p>' + actionButton('Приём состоялся', 'attended')); return; }
  if(name==='copy-visit-note'){try{await navigator.clipboard.writeText(visitPreparation(state).opening);showToast('Текст к приёму скопирован');}catch{showModal('Текст к приёму',`<textarea readonly aria-label="Текст к приёму">${h(visitPreparation(state).opening)}</textarea>`);}return;}
  if (name === 'attended') { modal.close(); return act({ type: 'attended' }, { message: 'Этап завершён. Напоминания выключены.' }); }
});
document.addEventListener('change', event => {
  captureSupportForm(event);
  if (event.target.name === 'count') {
    const values = [...document.querySelectorAll('#time-fields input')].map(e => e.value);
    reminderCount = Number(event.target.value);
    document.getElementById('time-fields').innerHTML = reminderFields(reminderCount);
    [...document.querySelectorAll('#time-fields input')].forEach((e, i) => { if (values[i]) e.value = values[i]; });
  }
});
document.addEventListener('input', event => { captureSupportForm(event); if(event.target.closest('#appointment-form'))appointmentDrafts.set(state.episodeId,Object.fromEntries(new FormData(event.target.closest('form')))); });
document.addEventListener('submit', async event => {
  event.preventDefault(); const data = new FormData(event.target);
  if (['health-context-form', 'treatment-checkin-form'].includes(event.target.id) && event.target.dataset.episode !== state.episodeId) { showToast('Начат другой эпизод. Проверьте данные перед сохранением.', true); render(); return; }
  if (event.target.id === 'treatment-checkin-form' && event.target.dataset.date !== state.today) { showToast('Дата дня изменилась. Проверьте сегодняшнюю отметку перед сохранением.', true); render(); return; }
  if (event.target.id === 'health-context-form') { await act({ type: 'health-context', values: Object.fromEntries(data) }, { message: 'Сведения сохранены. Это самоотчёт для беседы.', reveal: '#health-context-form' }); return; }
  if (event.target.id === 'treatment-checkin-form') { await act({ type: 'treatment-checkin', date: state.today, values: { ...Object.fromEntries(data), impact: Number(data.get('impact')) } }, { message: 'Отметка за сегодня сохранена', reveal: '#treatment-checkin-form' }); return; }
  if (event.target.id === 'connection-form') { if (data.get('consent') !== 'on') return showToast('Подтвердите передачу тестовых данных', true); await act({ type: 'connect-doctor', consent: true, name: String(data.get('name') || '') }, { message: 'Профиль подключён к учебному кабинету' }); if (state.connection?.enabled) modal.close(); return; }
  if (event.target.id === 'answer-form') { const q = state.flow.question; const raw = String(data.get('answer')); if (q.type === 'sleep' && !raw) { showToast('Укажите часы сна или нажмите «Пропустить»', true); return; } await act({ type: 'answer', questionId: q.id, value: q.type === 'sleep' ? Number(raw) : raw }); }
  if (event.target.id === 'reminders-form') await act({ type: 'reminders', settings: { enabled: data.get('enabled') === 'on', times: Array.from({ length: Number(data.get('count')) }, (_, i) => data.get(`time-${i}`)), timeZone: data.get('timeZone') } }, { message: 'Расписание сохранено' });
  if (event.target.id === 'appointment-form') await act({ type: 'appointment', date: String(data.get('date')), time: String(data.get('time')), question: String(data.get('question')) }, { message: state.connection?.enabled ? 'Заметка сохранена и доступна в учебном кабинете' : 'Заметка сохранена в вашем профиле' });
});
window.addEventListener('hashchange', () => { if(!route().startsWith('support'))closeRecommendations();render(); window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('main h1')?.focus({ preventScroll: true }); refreshState(); });
window.addEventListener('online', () => showToast('Соединение восстановлено. Повторите незавершённое действие.'));
window.addEventListener('offline', () => showToast('Нет связи с сервером. Новые ответы не сохраняются.', true));
try { state = await getState(); render(); } catch { app.innerHTML = '<main class="loading"><h1>Сервер временно недоступен</h1><p>Проверьте соединение и обновите страницу. Новые ответы пока не сохраняются.</p></main>'; }
let refreshing = false;
async function refreshState() {
  if (!state || busy || refreshing || document.hidden || document.activeElement?.matches('input,textarea,select') || route() === 'settings' || modal.open) return;
  refreshing = true;
  try {
    const next = await getState();
    if (!busy && next.revision >= state.revision && (next.revision !== state.revision || next.today !== state.today || next.carePlan?.id !== state.carePlan?.id || JSON.stringify(next.telegram) !== JSON.stringify(state.telegram) || JSON.stringify(next.connection) !== JSON.stringify(state.connection) || next.aiSupport?.draft?.id !== state.aiSupport?.draft?.id || next.aiSupport?.stale !== state.aiSupport?.stale)) {
      if (route() === 'visit') { state = next; const panel = document.querySelector('#care-plan-panel'); if (panel) panel.innerHTML = carePlanCard(); const connection = document.querySelector('#connection-panel'); if (connection) connection.outerHTML = connectionCard(); }
      else { state = next; render(); }
    }
  } catch { /* No offline writes or fabricated success. */ }
  finally { refreshing = false; }
}
setInterval(refreshState, 5000);
window.addEventListener('focus', refreshState);
document.addEventListener('visibilitychange', refreshState);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/patient/service-worker.js', { scope: '/patient/' }).catch(() => {});


async function openPatientVoice(extra={}) {
  if(!state?.joined){showToast('Сначала подтвердите возраст и условия демонстрации.',true);location.hash='today';return;}
  const voiceEpisode=state.episodeId;
  return openVoice({scope:'patient',endpoint:'/api/voice',ownerLabel:'Моя заметка',sharing:state.connection?.enabled,urgent:state.support?.urgent,isCurrent:()=>state?.episodeId===voiceEpisode,onError:text=>showToast(text,true),onSaved:async()=>{state=await getState();render();},...patientVoiceOptions(state,extra)});
}
async function requestJSONVoiceInbox() { const { requestJSON } = await import('/shared/client.js'); const { telegramHeaders } = await import('/shared/telegram.js'); return requestJSON('/api/voice/inbox', { headers: telegramHeaders() }); }
document.addEventListener('click', event => {
  if (event.target.closest('[data-voice-start]')) { event.preventDefault(); void openPatientVoice(); }
  const note = event.target.closest('[data-voice-note]'); if (note) void openPatientVoice({ existing: (state.voiceNotes || []).find(n => n.id === note.dataset.voiceNote) });
  if (event.target.closest('[data-voice-library]')) void openPatientVoice({ library: true });
});

// Open the received-note tool directly from the bot; recording still requires a user click.
if(state?.joined&&route()==='voice'){let inbox=false;if(state.telegram?.authenticated){try{inbox=(await requestJSONVoiceInbox()).available;}catch{}}void openPatientVoice({autoRecord:false,inbox});}

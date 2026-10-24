import { randomUUID } from 'node:crypto';
import { createPatient, applyAction, botKeyboard, currentTask, flowView, reminderSlots, snapshot } from './patient.mjs';
import { demoNow } from './time.mjs';
import { telegramSessionId } from './telegram-auth.mjs';
import { clinicWorkspaceId } from './care-link.mjs';
import { patientCarePlan } from './clinician.mjs';
import { buildPatientSupport, supportWindowText } from './insights.mjs';
import { patientAiWorkspaceId, patientAiView, supportFingerprint } from './patient-ai.mjs';

export function createTelegram({ config, store, wallClock = () => Date.now(), logger = () => {}, callApi = null, generatePatientAi = null, fileFetch = fetch }) {
  const status = { enabled: Boolean(config.telegramToken), ready: false };
  const appUrl = (route = '') => `${config.publicOrigin}/patient/${route ? '?view=' + route : ''}`;
  const appMarkup = (route = '') => ({ inline_keyboard: [[{ text: route === 'voice' ? 'Проверить голосовую заметку' : route === 'settings' ? 'Настроить напоминания' : route === 'support' ? 'Открыть рекомендации' : route === 'visit' ? 'Профиль и план врача' : 'Открыть дневник', web_app: { url: appUrl(route) } }]] });
  const replyMarkup = state => ({ keyboard: botKeyboard(state, demoNow(state, wallClock())).map(row => row.map(text => ({ text }))), resize_keyboard: true, is_persistent: true, one_time_keyboard: false, input_field_placeholder: 'Выберите ответ или напишите текст' });
  const promptKey = state => {
    const flow = flowView(state, demoNow(state, wallClock()));
    return flow ? JSON.stringify([state.episodeId, flow.kind, flow.id || '', flow.cursor, flow.question.id]) : null;
  };
  const questionText = flow => `${flow.kind !== 'safety' ? `Вопрос ${flow.cursor + 1} из ${flow.total}\n` : ''}${flow.question.window}\n${flow.question.text}`;
  const navigation = new Set(['Мне 18+, начать', 'Продолжить', 'Начать скрининг', 'Сегодняшняя запись', 'Начать заново', 'Назад', 'Пауза', 'Результаты', 'Нужна помощь', 'Вернуться к заданию']);
  const api = callApi || (async (method, payload = {}) => {
    let response, data;
    try {
      response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
      data = await response.json();
    } catch { throw Object.assign(new Error('Telegram временно недоступен'), { transient: true }); }
    if (!data.ok) throw Object.assign(new Error('Telegram не подтвердил отправку'), { code: data.error_code || response.status, retryAfter: data.parameters?.retry_after });
    return data.result;
  });
  function append(state, text, extra = {}) {
    const message = { id: randomUUID(), role: 'bot', text, at: demoNow(state, wallClock()), ...extra };
    state.messages.push(message); state.messages = state.messages.slice(-320);
    return message;
  }
  function enqueue(chat, method, payload, extra = {}) {
    chat.outbox.push({ id: randomUUID(), method, payload, status: 'pending', attempts: 0, queuedAt: wallClock(), ...extra });
    // Completed delivery records are bounded; unconfirmed messages are retained.
    const completed = chat.outbox.filter(m => m.status !== 'pending').slice(-60);
    chat.outbox = [...completed, ...chat.outbox.filter(m => m.status === 'pending')];
  }
  function enqueueText(chat, state, text, inlineRoute = null, extra = {}) {
    const chunks = [];
    while (text.length > 3500) {
      const cut = /[\uD800-\uDBFF]/.test(text[3499]) ? 3499 : 3500;
      chunks.push(text.slice(0, cut)); text = text.slice(cut);
    }
    chunks.push(text);
    chunks.forEach((part, index) => enqueue(chat, 'sendMessage', { chat_id: chat.chatId, text: part, reply_markup: index === chunks.length - 1 && inlineRoute !== null ? appMarkup(inlineRoute) : replyMarkup(state) }, { episodeId: state.episodeId, ...(index === chunks.length - 1 ? extra : {}) }));
  }
  async function configure() {
    if (!status.enabled) return;
    const me = await api('getMe');
    if (me.username !== config.telegramUsername || !me.is_bot) throw new Error('Токен относится к другому боту');
    await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Дневник', web_app: { url: appUrl() } } });
    await api('setMyCommands', { commands: [
      { command: 'start', description: 'Начать или продолжить' }, { command: 'app', description: 'Открыть дневник и динамику' },
      { command: 'results', description: 'Результаты анкет' }, { command: 'diary', description: 'Сегодняшняя запись' },
      { command: 'settings', description: 'Время напоминаний' }, { command: 'stop', description: 'Выключить напоминания' },
      { command: 'doctor', description: 'Передача данных и план врача' }, { command: 'share', description: 'Передать тестовый профиль врачу' }, { command: 'unshare', description: 'Отключить передачу врачу' },
      { command: 'insights', description: 'Понятный разбор и шаг на сегодня' }, { command: 'ai', description: 'Выбрать главное с ИИ (тестовые данные)' },
      { command: 'voice', description: 'Голосовая заметка с проверкой текста' },
      { command: 'help', description: 'Памятка помощи' },
    ] });
    await api('setMyDescription', { description: 'Трекер Сеченовка: PHQ-9 и GAD-7, короткий дневник, динамика и сводка к приёму. Учебная версия для взрослых 18+. Используйте только вымышленные данные. Врач не следит за перепиской в реальном времени.' });
    await api('setMyShortDescription', { short_description: 'Анкеты, дневник и динамика самочувствия. Учебная демонстрация 18+ на вымышленных данных.' });
    await api('setWebhook', { url: `${config.publicOrigin}/telegram/webhook`, secret_token: config.telegramWebhookSecret, allowed_updates: ['message'], max_connections: 1, drop_pending_updates: false });
    status.ready = true;
    logger({ event: 'telegram_ready', at: new Date(wallClock()).toISOString() });
  }
  async function flush(id) {
    // The same database lock serializes replies, app changes and reminder checks.
    const result = await store.withSession(id, async transaction => {
      const chat = await transaction.getTelegram(id), state = await transaction.get(id);
      if (!chat || !state || !Number.isSafeInteger(chat.chatId) || chat.chatId <= 0) return { sent: 0 };
      let sent = 0, retry = false;
      for (const message of chat.outbox.filter(m => m.status === 'pending').slice(0, 6)) {
        if (message.episodeId && message.episodeId !== state.episodeId) { message.status = 'cancelled'; continue; }
        if (message.nextAttemptAt > wallClock()) { retry = true; break; }
        if (message.promptKey && message.promptKey !== promptKey(state)) {
          const flow = flowView(state, demoNow(state, wallClock()));
          message.promptKey = promptKey(state);
          message.payload.text = flow ? questionText(flow) : 'Ответы в дневнике сохранены. Нажмите «Результаты» или «Продолжить», чтобы увидеть актуальный шаг.';
          message.payload.reply_markup = replyMarkup(state);
        }
        if (message.reminder) {
          const now = demoNow(state, wallClock());
          const task = currentTask(state, now);
          // Recheck at delivery, so finishing in the app cancels queued prompts.
          if (!state.reminders.enabled || !['assessment', 'diary'].includes(task.kind) || task.id !== message.reminder.taskId || task.date !== message.reminder.date || state.safety?.pending || ['urgent', 'unknown'].includes(state.safety?.level) || Date.parse(now) - Date.parse(message.reminder.at) > 5400000) { message.status = 'cancelled'; continue; }
          message.payload.reply_markup = replyMarkup(state);
        }
        try {
          let delivered;
          try { delivered = await api(message.method, message.payload); }
          catch (error) {
            // A photo fetch can fail without affecting the start of the dialogue.
            if (message.method !== 'sendPhoto' || error.code !== 400) throw error;
            delivered = await api('sendMessage', { chat_id: chat.chatId, text: message.payload.caption, reply_markup: message.payload.reply_markup });
          }
          message.status = 'sent'; message.sentAt = wallClock(); message.telegramMessageId = delivered?.message_id;
          if (message.promptKey) chat.lastPromptKey = message.promptKey;
          if (message.reminder) {
            state.deliveries.push({ ...message.reminder, deliveredAt: demoNow(state, wallClock()), transport: 'telegram' });
            append(state, message.payload.text, { reminder: true }); state.revision++;
            await transaction.save(id, state);
          }
          sent++;
        } catch (error) {
          message.attempts++;
          if (error.code === 403) {
            chat.blocked = true; state.reminders.enabled = false; state.revision++;
            for (const queued of chat.outbox) if (queued.status === 'pending') queued.status = 'blocked';
            await transaction.save(id, state);
          } else {
            message.nextAttemptAt = wallClock() + (error.retryAfter || 5) * 1000;
            retry = true;
          }
          logger({ event: 'telegram_delivery_error', at: new Date(wallClock()).toISOString(), code: Number(error.code) || 0 });
          break;
        }
      }
      await transaction.saveTelegram(id, chat);
      return { sent, retry };
    });
    return result;
  }
  async function handleUpdate(update) {
    const message = update?.message;
    if (!Number.isSafeInteger(update?.update_id) || !message || message.chat?.type !== 'private' || !Number.isSafeInteger(message.message_id) || !Number.isSafeInteger(message.from?.id) || message.from.is_bot || message.from.id !== message.chat.id || message.from.id <= 0) return { ignored: true };
    const id = telegramSessionId(message.from.id, config.telegramIdentitySecret);
    let aiJob = null;
    await store.withSession(id, async transaction => {
      let state = await transaction.get(id);
      const previousChat = await transaction.getTelegram(id);
      const first = !previousChat;
      const chat = previousChat || { chatId: message.chat.id, lastMessageId: 0, seen: [], outbox: [], blocked: false };
      if (chat.seen.includes(update.update_id) || message.message_id <= chat.lastMessageId) return;
      if (!state) state = createPatient(wallClock());
      chat.blocked = false;
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      const command = text.match(/^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i)?.[1]?.toLowerCase();
      const before = new Set(state.messages.map(m => m.id));
      if (first) enqueue(chat, 'sendPhoto', { chat_id: chat.chatId, photo: `${config.publicOrigin}/assets/welcome.png`, caption: state.messages[0].text, reply_markup: replyMarkup(state) }, { episodeId: state.episodeId });
      const audioNote = message.voice || message.audio;
      if (audioNote || command === 'voice') {
        if (!state.joined) enqueueText(chat, state, 'Сначала подтвердите возраст и условия демонстрации. Голосовое не является ответом на анкету.');
        else if (audioNote && (!Number.isFinite(audioNote.duration) || audioNote.duration <= 0 || audioNote.duration > 300 || !Number.isFinite(audioNote.file_size) || audioNote.file_size <= 0 || audioNote.file_size > 6 * 1024 * 1024 || typeof audioNote.file_id !== 'string' || !audioNote.file_id || audioNote.file_id.length > 512)) enqueueText(chat, state, 'Для заметки отправьте голосовое или аудио до 5 минут и 6 МБ. Можно также открыть голосовой ввод и загрузить файл. Только вымышленные сведения.', 'voice');
        else {
          if (audioNote) await transaction.saveWorkspace('voice-inbox:' + id, { episodeId: state.episodeId, fileId: audioNote.file_id, duration: audioNote.duration, expiresAt: wallClock() + 3600000 });
          enqueueText(chat, state, audioNote ? 'Аудио получено. Откройте заметку ниже: запись распознаётся на вашем устройстве. Проверьте текст и сохраните его. Это отдельная заметка; текущий вопрос анкеты не изменён. Ссылка действует один час. Используйте только вымышленную запись.' : 'Здесь можно надиктовать, загрузить аудио или написать заметку. Расшифровку нужно проверить перед сохранением. Она не заменяет ответы на анкеты.', 'voice');
        }
      } else if (['insights', 'ai', 'aiconsent'].includes(command)) {
        const plan = state.careConnection ? patientCarePlan(await transaction.getWorkspace(clinicWorkspaceId(id)), state, state.careConnection.id) : null;
        const support = buildPatientSupport(snapshot(state, wallClock()), plan);
        const ai = patientAiView(await transaction.getWorkspace(patientAiWorkspaceId(id)), support, config, wallClock());
        if (command === 'insights' || support.urgent || !state.assessments.length) {
          enqueueText(chat, state, supportWindowText(support), 'support');
        } else if (command === 'ai' && ai.draft && !ai.stale) {
          enqueueText(chat, state, supportWindowText(support), 'support');
        } else if (command === 'ai') {
          enqueueText(chat, state, 'ИИ поможет выделить главное из тестовых анкет и дневника. В OpenRouter отправятся только вымышленные структурированные баллы, даты и закрытые ответы. Имена, Telegram ID, свободные заметки, перечень лекарств и запись врача не отправляются. Бесплатный провайдер может хранить данные и использовать их для обучения. Для согласия отправьте /aiconsent. Обычный разбор без внешнего запроса: /insights.', 'support');
        } else if (generatePatientAi) {
          aiJob = { sessionId: id, action: { consent: true, episodeId: state.episodeId, sourceHash: supportFingerprint(support) } };
          enqueueText(chat, state, 'Готовлю разбор тестовых данных. Можно продолжать пользоваться дневником. Если сервис не ответит, обычный разбор останется доступен через /insights.', 'support');
        } else enqueueText(chat, state, 'ИИ-сервис пока не подключён. Обычный разбор доступен через /insights.', 'support');
      } else if (['doctor', 'share', 'unshare'].includes(command)) {
        try {
          if (!config.clinicianAccessKey) throw new Error('Учебный кабинет пока не подключён');
          if (command === 'share') {
            state = applyAction(structuredClone(state), { type: 'connect-doctor', consent: true, name: state.careConnection?.name || '' }, wallClock());
            append(state, `Тестовый профиль ${state.careConnection.code} доступен в закрытом учебном кабинете психиатра. Передаются анкеты, отдельные ответы о безопасности, дневник, даты и вопрос к приёму. Новые записи обновляются автоматически. Врач не наблюдает за данными круглосуточно. Отключить передачу: /unshare.`);
          } else if (command === 'unshare') {
            state = applyAction(structuredClone(state), { type: 'disconnect-doctor' }, wallClock());
            append(state, 'Передача отключена. Кабинет больше не может открывать этот профиль. Ваши ответы и ранее подтверждённый план сохранены; это не удаление истории.');
          } else {
            const link = state.careConnection;
            const plan = link ? patientCarePlan(await transaction.getWorkspace(clinicWorkspaceId(id)), state, link.id) : null;
            enqueueText(chat, state, link?.enabled ? `Профиль ${link.code} подключён к учебному кабинету. Новые анкеты и дневник доступны после сохранения. Врач не следит за перепиской в реальном времени.\n\n${plan ? `Подтверждённый демоплан\nЦель: ${plan.goal}\nПлан: ${plan.plan}\nОтслеживать: ${plan.watch}\nОбратиться раньше: ${plan.earlyContact}\nСледующий контакт: ${plan.nextDate}, ${plan.nextTime} (${plan.timeZone}).` : 'Подтверждённого плана пока нет.'}\n\nОтключить передачу: /unshare.` : 'Можно передать тестовые анкеты, ответы о безопасности, дневник и подготовку к приёму в закрытый учебный кабинет. После согласия данные обновляются автоматически. Только вымышленные сведения; это не запись на приём и не экстренная связь. Чтобы согласиться, отправьте /share или откройте раздел ниже. Отключить передачу: /unshare.', 'visit');
          }
        } catch (error) { append(state, error.message); state.revision++; }
      } else if (command === 'app' || command === 'settings' || text === 'Открыть Mini App') {
        enqueueText(chat, state, command === 'settings' ? 'Выберите от одного до трёх времён в разделе «Напоминания». Здесь же можно их выключить.' : 'В дневнике — ваши ответы, результаты и динамика. Открывайте его этой кнопкой: профиль будет общим с перепиской.', command === 'settings' ? 'settings' : '');
      } else if (command === 'stop') {
        state.reminders.enabled = false; state.revision++;
        append(state, 'Напоминания выключены. Ответы сохранены. Можно продолжить по кнопке ниже; заново включить напоминания — через /settings.');
      } else if (!(first && command === 'start')) {
        const normalized = command === 'results' ? 'Результаты' : command === 'diary' ? 'Сегодняшняя запись' : command === 'start' ? '/start' : text;
        try {
          if (!text) throw new Error('Пока можно отвечать текстом и кнопками. Для голосовой заметки используйте /voice. Фото и документы не обрабатываются.');
          if (command === 'help' && !state.joined) {
            const { URGENT_TEXT } = await import('../public/shared/clinical.js');
            append(state, URGENT_TEXT);
          } else if (!['start', 'results', 'diary', 'help', 'restart'].includes(command) && !navigation.has(normalized) && promptKey(state) && chat.lastPromptKey !== promptKey(state)) {
            // Reply keyboards do not identify the question they came from.
            // Never assign a stale chat answer to a question advanced in Mini App.
            append(state, 'Текущий вопрос изменился. Этот ответ пока не сохранён. Ниже — актуальный вопрос; ответьте на него ещё раз.');
            state = applyAction(state, { type: 'bot', text: 'Продолжить' }, wallClock());
          } else state = applyAction(structuredClone(state), { type: 'bot', text: normalized }, wallClock());
        } catch (error) { append(state, /[А-Яа-яЁё]/.test(error.message) ? error.message : 'Не удалось обработать ответ. Повторите его кнопкой ниже.'); state.revision++; }
      }
      const flow = flowView(state, demoNow(state, wallClock()));
      for (const item of state.messages.filter(m => m.role === 'bot' && !before.has(m.id))) {
        const isQuestion = item.questionId && item.questionId === flow?.question.id;
        const prefix = isQuestion && flow.kind !== 'safety' ? `Вопрос ${flow.cursor + 1} из ${flow.total}\n` : '';
        enqueueText(chat, state, prefix + item.text, null, isQuestion ? { promptKey: promptKey(state) } : {});
      }
      if (command === 'start' || state.assessments.length && state.messages.some(m => !before.has(m.id) && /Анкеты завершены|Запись сохранена/.test(m.text))) enqueueText(chat, state, 'Результаты, дневник и настройки — по кнопке «Открыть дневник». В переписке можно отвечать нижними кнопками. Передача данных в учебный кабинет и план врача: /doctor.', '');
      chat.lastMessageId = message.message_id;
      chat.seen = [...chat.seen, update.update_id].slice(-200);
      await transaction.save(id, state); await transaction.saveTelegram(id, chat);
    });
    const result = await flush(id);
    if (aiJob) {
      let generated, error;
      try { generated = await generatePatientAi(aiJob); } catch (e) { error = e; }
      await store.withSession(id, async transaction => {
        const chat = await transaction.getTelegram(id), state = await transaction.get(id);
        if (!chat || !state || chat.blocked) return;
        const plan = state.careConnection ? patientCarePlan(await transaction.getWorkspace(clinicWorkspaceId(id)), state, state.careConnection.id) : null;
        const support = buildPatientSupport(snapshot(state, wallClock()), plan);
        const valid = generated?.draft?.episodeId === state.episodeId && generated.draft.sourceHash === supportFingerprint(support) && !support.urgent;
        enqueueText(chat, state, valid ? supportWindowText(support) : (error?.message || 'Данные изменились. Откройте актуальный разбор; старый ответ не применён.'), 'support');
        await transaction.saveTelegram(id, chat);
      });
      const final = await flush(id); result.sent += final.sent; result.retry ||= final.retry;
    }
    return { ok: !result.retry, sent: result.sent };
  }
  async function tick() {
    let sent = 0, retry = false;
    for (const { id } of await store.allTelegram()) {
      const eligible = await store.withSession(id, async transaction => {
        const chat = await transaction.getTelegram(id), state = await transaction.get(id);
        if (!state || !chat || !Number.isSafeInteger(chat.chatId) || chat.chatId <= 0 || chat.blocked) return false;
        const now = demoNow(state, wallClock());
        const due = reminderSlots(state, now, 0).filter(slot => Date.parse(slot.at) <= Date.parse(now) && Date.parse(now) - Date.parse(slot.at) <= 5400000 && !state.deliveries.some(d => d.key === slot.key) && !chat.outbox.some(m => m.reminder?.key === slot.key)).at(-1);
        if (due) {
          enqueueText(chat, state, `Время короткой записи: ${due.task.toLowerCase()}. Если сегодня всё уже заполнено, повторять не нужно. Ответьте здесь по кнопке «Продолжить» или откройте дневник.`, null, { reminder: due });
          await transaction.saveTelegram(id, chat);
        }
        return true;
      });
      if (!eligible) continue;
      const result = await flush(id); sent += result.sent; retry ||= result.retry;
    }
    if (retry) throw new Error('Telegram пока не подтвердил все отправки');
    return sent;
  }
  async function readVoice(id, download = false) {
    const record = await store.withSession(id, async transaction => {
      const item = await transaction.getWorkspace('voice-inbox:' + id), state = await transaction.get(id);
      if (!item || item.expiresAt < wallClock() || item.episodeId !== state?.episodeId) { if (item) await transaction.saveWorkspace('voice-inbox:' + id, {}); return null; }
      return item;
    });
    if (!record) { if (download) throw Object.assign(new Error('Голосовое устарело. Отправьте новое в бот.'), { status: 404 }); return { available: false }; }
    if (!download) return { available: true, duration: record.duration, expiresAt: record.expiresAt };
    const file = await api('getFile', { file_id: record.fileId });
    if (!file?.file_path || !/^[A-Za-z0-9_./-]+$/.test(file.file_path) || file.file_path.split('/').includes('..') || file.file_size > 6 * 1024 * 1024) throw Object.assign(new Error('Telegram не вернул доступную запись.'), { status: 502 });
    const response = await fileFetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Object.assign(new Error('Telegram временно не отдал запись. Повторите попытку.'), { status: 503 });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 6 * 1024 * 1024) throw Object.assign(new Error('Слишком большое голосовое.'), { status: 413 }); chunks.push(chunk); }
    const audioTypes = { oga:'audio/ogg',ogg:'audio/ogg',opus:'audio/ogg',m4a:'audio/mp4',mp4:'audio/mp4',mp3:'audio/mpeg',wav:'audio/wav',webm:'audio/webm',aac:'audio/aac' };
    const extension=file.file_path.split('.').at(-1).toLowerCase(), supplied=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const contentType=audioTypes[extension] || (Object.values(audioTypes).includes(supplied)?supplied:'application/octet-stream');
    return { bytes: Buffer.concat(chunks), contentType };
  }
  return { status, configure, handleUpdate, tick, flush, readVoice };
}

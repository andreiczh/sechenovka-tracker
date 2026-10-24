// Transport-neutral payload. This module never sends a network request.
// Production integration must supply a verified Telegram chat ID and backend auth.
import { botKeyboard } from './patient.mjs';
export function telegramReplyPayload(state, chatId, now) {
  if (!Number.isSafeInteger(chatId)) throw new Error('Требуется проверенный Telegram chat_id');
  return {
    chat_id: chatId,
    text: [...state.messages].reverse().find(m => m.role === 'bot')?.text || 'Откройте Mini App, чтобы посмотреть данные.',
    reply_markup: { keyboard: botKeyboard(state, now).map(row => row.map(text => ({ text }))), resize_keyboard: true, is_persistent: true, one_time_keyboard: false, input_field_placeholder: 'Выберите ответ или напишите текст' },
  };
}

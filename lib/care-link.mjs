import { randomUUID } from 'node:crypto';

// This is a single, protected teaching workspace. No Telegram names or IDs are
// copied into the doctor's roster. The patient can choose a display name.
export const CLINIC_ID = 'teaching-clinic';
export const clinicWorkspaceId = sessionId => `clinic:${sessionId}`;
export function connectPatient(state, name, wallNow) {
  if (!state.joined) throw new Error('Сначала подтвердите возраст и условия демонстрации');
  if (typeof name !== 'string' || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Укажите имя или псевдоним до 60 символов');
  const previous = state.careConnection;
  const id = previous?.id || `care-${randomUUID()}`;
  state.careConnection = { id, clinicId: CLINIC_ID, code: previous?.code || `ТС-${id.slice(5, 13).toUpperCase()}`, name: name.trim(), enabled: true, consentAt: new Date(wallNow).toISOString(), connectedAt: previous?.connectedAt || new Date(wallNow).toISOString(), disconnectedAt: null };
}
export function disconnectPatient(state, wallNow) {
  if (state.careConnection) state.careConnection = { ...state.careConnection, enabled: false, disconnectedAt: new Date(wallNow).toISOString() };
}
export const isSharedPatient = state => Boolean(state?.joined && state.careConnection?.enabled && state.careConnection.clinicId === CLINIC_ID);
export function connectedCase(state, sessionId) {
  const link = state.careConnection;
  return { id: link.id, identity: { name: link.name || `Пациент ${link.code}`, code: link.code, age: null, synthetic: true }, state,
    referral: { reason: 'Пациент подключил свой тестовый профиль к учебному кабинету. Медицинское направление и диагноз не подтверждены.', by: sessionId.startsWith('tg-') ? 'Telegram · бот и Mini App' : 'Сайт пациента', at: link.consentAt, confirmed: false },
    intake: {}, medications: [], events: [], adherence: null };
}
export function emptyClinicWorkspace(wallNow) {
  return { schema: 1, revision: 0, createdAt: new Date(wallNow).toISOString(), reviews: {}, audit: [], patients: [] };
}

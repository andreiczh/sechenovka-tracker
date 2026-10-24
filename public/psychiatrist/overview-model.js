// Presentation only: use saved facts and the same question catalogue as the
// full recommendations window. Never infer risk, diagnosis or missing values.
import { DOCTOR_QUESTIONS } from '../shared/evidence.js';
export function initialWorkspaceMode(session, patientId=null) {
  return session?.enabled && patientId?.startsWith('care-') ? 'clinic' : 'demo';
}

const briefQuestions = {
  general: 'Начало, длительность, прежние эпизоды и ожидания от помощи.',
  sleep: 'Сон, пробуждения, дневная сонливость и потребность во сне.',
  anxiety: 'Содержание и управляемость тревоги, избегание и влияние на дела.',
  function: 'Что конкретно стало трудно делать дома, на работе и в общении?',
  medicines: 'Лекарства и БАДы: режим, даты изменений и новые неприятные явления.',
  activation: 'Периоды необычной активности и меньшей потребности во сне.',
};

export function meetingQuestions(patient) {
  const questions = (patient.support?.questions || []).map(q => ({
    id: q.id, text: DOCTOR_QUESTIONS[q.id] || q.text,
    brief: briefQuestions[q.id] || q.text,
  })).filter(q => q.text);
  const safety = {
    id: 'current-safety',
    text: 'Уточнить актуальную безопасность при контакте; сумма анкеты не заменяет беседу.',
    brief: 'Уточнить актуальную безопасность в беседе с пациентом.',
  };
  return [safety, ...questions.filter(q => q.id !== safety.id)];
}

export function overviewModel(patient) {
  const latest = patient.assessments.at(-1);
  const records = patient.diary.filter(e => Number.isInteger(e.day) && e.day >= 0 && e.day <= Math.min(patient.day ?? 14, 14));
  return {
    scores: ['phq', 'gad'].map(kind => ({
      kind,
      value: latest?.scores[kind]?.complete ? latest.scores[kind].score : null,
      delta: patient.delta[kind] ?? null,
      date: latest?.date || null,
    })),
    lastDiary: records.at(-1) || null,
    recordCount: records.length,
    functionDifficult: records.filter(e => e.function === 2 || e.function === 3).length,
    questions: meetingQuestions(patient),
    // Pending answers stay visible even if the overall totals are low or empty.
    safetyNeedsClarification: Boolean(patient.safety.needsClarification),
    safetyAnswer: patient.safety.phq9 ?? null,
  };
}

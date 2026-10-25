import { scoreAssessment, FUNCTION_LABELS } from '../shared/clinical.js';

// A preparation aid from saved self-report, never an inferred diagnosis.
export function visitPreparation(state) {
  const last=state.assessments?.at(-1), scores=last?scoreAssessment(last):null;
  const goal=state.appointment?.question?.trim()||last?.context?.goal?.trim();
  const parts=[goal?`Хочу обсудить: ${goal}`:'Хочу обсудить своё самочувствие: что меня беспокоит и как это влияет на мою жизнь.'];
  if(last?.context?.duration)parts.push(`Замечаю изменения: ${last.context.duration.toLowerCase()}.`);
  if(last&&FUNCTION_LABELS[last.context?.function])parts.push(`В анкете отметил(а), что состояние ${FUNCTION_LABELS[last.context.function].toLowerCase()}.`);
  if(scores)parts.push(`Мои последние результаты: PHQ-9 — ${scores.phq.score} из 27, GAD-7 — ${scores.gad.score} из 21. Хочу понять их значение вместе с врачом.`);
  else parts.push('Анкеты пока не завершены. Я могу рассказать о самочувствии без готовых баллов.');
  const questions=[{id:'reason',text:'Что может объяснять моё состояние и что стоит уточнить или проверить?'}];
  if(last?.answers[2]>0||state.diary?.some(e=>Number.isFinite(e.sleep)&&e.sleep<6))questions.push({id:'sleep',text:'Как обсудить нарушения сна и что безопасно делать до следующего приёма?'});
  questions.push({id:'function',text:'Что поможет справляться с обычными делами и как понять, что стало лучше?'});
  if(state.healthContext?.medicines?.trim()||state.treatmentCheckins?.some(e=>!['none','unknown'].includes(e.effect)))questions.push({id:'medicines',text:'Нужно ли пересмотреть принимаемые лекарства и БАДы с учётом новых ощущений? Возьму с собой названия, дозы и даты начала.'});
  questions.push({id:'contact',text:'Когда следующий контакт и при каких изменениях обращаться раньше?'});
  if(state.safety?.pending||state.safety?.needsGuidance||state.safetyEvents?.length||last?.answers[8]>0)questions.unshift({id:'safety',text:'Расскажу врачу об ответах на вопрос о смерти или причинении себе вреда и о том, что чувствую сейчас. Уточним, какая помощь нужна.'});
  return {opening:parts.join(' '),questions,scores,complete:Boolean(last)};
}

export function patientVoiceOptions(state, extra={}) {
  const existing=Boolean(extra.existing||extra.library||extra.inbox);
  return {syntheticConfirmed:state.joined===true,autoRecord:!existing&&extra.autoRecord!==false,...extra};
}

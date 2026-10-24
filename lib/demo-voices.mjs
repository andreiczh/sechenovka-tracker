import manifest from '../public/assets/demo-voice/manifest.json' with { type: 'json' };

// Scripted, synthetic examples. No recordings or private notes are copied
// from connected Telegram profiles into these publicly accessible fixtures.
export const DEMO_VOICE_SCENARIOS = {
  anna: {
    patient: [
      ['patient', 'Стало легче выходить на прогулку, но вечером я всё ещё долго засыпаю.', ['sleep', 'course']],
      ['patient', 'Хочу спокойнее работать и меньше уставать к концу дня.', ['function', 'goal']],
    ],
    session: [
      ['doctor', 'Что изменилось со времени первых анкет?', ['course']],
      ['patient', 'Тревоги стало меньше, но сон пока не восстановился.', ['complaints', 'sleep']],
      ['doctor', 'Какие обычные дела ещё даются труднее?', ['function']],
      ['patient', 'К вечеру сложнее сосредоточиться на работе.', ['function']],
      ['doctor', 'На встрече уточним сон, предыдущую помощь и все принимаемые средства.', ['history', 'medicines']],
      ['patient', 'Хочу обсудить, как снова высыпаться и работать спокойнее.', ['goal']],
    ],
  },
  mikhail: {
    patient: [
      ['patient', 'Я часто тревожусь, плохо сплю и откладываю даже обычные дела.', ['complaints', 'sleep', 'function']],
      ['patient', 'Пропустил рабочую встречу и хочу обсудить, какая помощь мне нужна сейчас.', ['function', 'goal']],
    ],
    session: [
      ['doctor', 'Что сейчас больше всего мешает в повседневной жизни?', ['function']],
      ['patient', 'Мне трудно справляться с работой и бытовыми делами.', ['function']],
      ['doctor', 'Отдельно уточним актуальную безопасность и доступную помощь. Ответы анкеты этого не заменяют.', ['safety']],
      ['patient', 'Хочу понять, как получить помощь и когда снова связаться с врачом.', ['goal']],
      ['doctor', 'Также обсудим сон, длительность изменений и все принимаемые средства.', ['sleep', 'course', 'medicines']],
    ],
  },
  olga: {
    patient: [
      ['patient', 'Я заполняла дневник не каждый день: иногда просто забывала.', ['course']],
      ['patient', 'Ночью просыпаюсь и днём устаю. Хочу обсудить это на встрече.', ['sleep', 'goal']],
    ],
    session: [
      ['doctor', 'Расскажите о самочувствии в дни, когда не было записей.', ['course']],
      ['patient', 'Я не могу точно восстановить каждый день, но помню частые пробуждения.', ['sleep']],
      ['doctor', 'Пропуски оставим неизвестными. Как сон влияет на обычные дела?', ['function']],
      ['patient', 'Днём устаю, но конкретные примеры хочу вспомнить вместе с врачом.', ['function', 'goal']],
      ['doctor', 'Уточним актуальное состояние, начало изменений и принимаемые средства.', ['course', 'medicines']],
    ],
  },
  egor: {
    patient: [
      ['patient', 'Я начал заполнять анкеты, но ещё не закончил.', ['course']],
      ['patient', 'Хочу понять, как связаны мой сон и тревога и что стоит обсудить с врачом.', ['sleep', 'goal']],
    ],
    session: [
      ['doctor', 'Какие изменения вы заметили?', ['complaints']],
      ['patient', 'Меня беспокоят сон и тревога, но я пока не всё описал в анкетах.', ['sleep', 'complaints']],
      ['doctor', 'Уточним длительность, влияние на дела и актуальную безопасность. Суммы незавершённых анкет не рассчитываем.', ['course', 'function', 'safety']],
      ['patient', 'Я хочу закончить ответы и подготовить вопросы к приёму.', ['goal']],
    ],
  },
  irina: {
    patient: [
      ['patient', 'Стало труднее справляться с работой, ночью часто просыпаюсь.', ['function', 'sleep']],
      ['patient', 'После нового средства заметила тошноту и сонливость. Не знаю, связано ли это с ним.', ['medicines']],
    ],
    session: [
      ['doctor', 'Что изменилось со времени исходных анкет?', ['course']],
      ['patient', 'Самочувствие стало хуже, труднее работать и высыпаться.', ['complaints', 'function', 'sleep']],
      ['doctor', 'Какие лекарства и добавки вы принимаете?', ['medicines']],
      ['patient', 'Авиандр и добавку, название которой не помню. Дозу и даты начала нужно уточнить.', ['medicines']],
      ['doctor', 'Сверим названия, дозы, даты и новые явления. По совпадению во времени нельзя установить причину.', ['medicines']],
      ['patient', 'Хочу снова справляться с работой и спать без частых пробуждений.', ['goal']],
    ],
  },
};

export function ensureDemoVoiceHistory(workspace) {
  if (!workspace?.patients?.length || workspace.demoVoiceVersion === 1) return false;
  let changed=false;
  for (const entry of workspace.patients) {
    const script=DEMO_VOICE_SCENARIOS[entry.id];
    if (!script || entry.identity?.synthetic !== true) continue;
    const state=entry.state, episode=state.episodeId || state.assessments[0]?.id || state.createdAt;
    const key=`${entry.id}:${episode}`;
    const at=[state.active?.startedAt,...state.assessments.map(a=>a.completedAt),...state.diary.map(d=>d.recordedAt)].filter(Boolean).sort().at(-1)||state.createdAt;
    const make=(kind,scope,title)=>{
      const asset=manifest[`${entry.id}-${kind}`];
      return {
        id:`example-${entry.id}-${kind}-v1`, at, date:at.slice(0,10), episodeId:episode,
        scope, title, duration:asset?.duration || 0, timeZone:state.reminders.timeZone,
        engine:'text-reviewed', source:'Подготовленный вымышленный аудиопример; текст и роли заданы сценарием.',
        synthetic:true, reviewed:true, participantsConsent:scope!=='patient', incomplete:false,
        archivedAt:null, ai:null, clinicalFacts:[], questions:['onset','function','goal'],
        example:{version:1,method:'scripted-speech',audioPath:`/assets/demo-voice/${entry.id}-${kind}.wav`},
        segments:script[kind].map(([role,text,topics],i)=>({id:`s${i}`,role,text,topics,roleSource:'manual',start:asset?.segments[i]?.start??null,end:asset?.segments[i]?.end??null})),
      };
    };
    state.voiceNotes ||= [];
    const patientNote=make('patient','patient','О самочувствии · заметка пациента');
    if (!state.voiceNotes.some(n=>n.id===patientNote.id)) { state.voiceNotes.push(patientNote);state.revision++;changed=true; }
    workspace.voices ||= {}; workspace.voices[key] ||= [];
    const session=make('session','psychiatrist','Беседа с врачом · к приёму');
    if (!workspace.voices[key].some(n=>n.id===session.id)) {
      workspace.voices[key].push(session);workspace.voiceRevisions ||= {};
      workspace.voiceRevisions[key]=(workspace.voiceRevisions[key]||0)+1;changed=true;
    }
  }
  workspace.demoVoiceVersion=1;
  return changed;
}

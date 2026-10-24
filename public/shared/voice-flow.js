// User-facing destinations are shared by capture, review and the save receipt.
export function voiceTimeline(notes = []) {
  const stamp = note => Date.parse(note?.at) || 0;
  return [...notes].sort((a,b) => stamp(b)-stamp(a));
}
export function voiceDestination({ scope, sharing = false, insertTarget, ownerLabel = '' }) {
  if (insertTarget) return { title: 'Текст в выбранное поле', detail: 'Проверите расшифровку и вставите её в поле. Чтобы сохранить данные, отправьте саму форму.', action: 'Вставить в поле', href: null };
  if (scope === 'patient') return { title: 'Дневник → Заметки', detail: sharing ? 'Заметка сохранится в вашем профиле. Её увидит подключённый врач, когда откроет карточку.' : 'Заметка сохранится в вашем профиле. Врачу она станет доступна после вашего согласия на передачу.', action: 'Сохранить в дневник', href: '#diary' };
  if (scope === 'psychiatrist') return { title: 'Карточка пациента → Приём → Записи бесед', detail: `${ownerLabel ? ownerLabel + '. ' : ''}Запись доступна в кабинете врача. Пациент её не увидит; план публикуется отдельно.`, action: 'Сохранить в карточку', href: null };
  return { title: 'Памятка ВОП → Мои беседы', detail: 'Беседа и отметки чек-листа сохранятся в рабочем профиле этого браузера. К карточке пациента они автоматически не прикрепляются.', action: 'Сохранить беседу', href: null };
}

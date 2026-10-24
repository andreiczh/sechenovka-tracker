// An assumption model, NOT trial results. Units: people, minutes, RUB/hour.
// Compare the same clinical work and number of contacts. Clinical interview,
// diagnosis, safety assessment and prescribing are not counted as savings.
export const RESOURCE_SCENARIOS = Object.freeze({
  conservative: {
    completion: .50, attendance: .50, physicianUse: .60, repeat: .30,
    inviteMinutes: 1.5, scaleBefore: 1.5, scaleAfter: 1.5,
    prepBefore: 3, prepAfter: 2.5, noteBefore: 7, noteAfter: 9,
    planBefore: 2, planAfter: 1.5, ehrCopy: 1.5,
    repeatBefore: 2, repeatAfter: 1.5,
    supportRate: .05, supportMinutes: 8, monthlyTraining: 60,
  },
  base: {
    completion: .75, attendance: .60, physicianUse: .80, repeat: .60,
    inviteMinutes: 1, scaleBefore: 3, scaleAfter: 1.25,
    prepBefore: 5, prepAfter: 2, noteBefore: 7, noteAfter: 6.5,
    planBefore: 2, planAfter: 1, ehrCopy: 1,
    repeatBefore: 3, repeatAfter: 1,
    supportRate: .02, supportMinutes: 5, monthlyTraining: 30,
  },
  optimistic: {
    completion: .90, attendance: .80, physicianUse: .90, repeat: .80,
    inviteMinutes: .5, scaleBefore: 3, scaleAfter: 1,
    prepBefore: 6, prepAfter: 2, noteBefore: 7, noteAfter: 5,
    planBefore: 2, planAfter: .75, ehrCopy: .5,
    repeatBefore: 3, repeatAfter: .75,
    supportRate: .01, supportMinutes: 5, monthlyTraining: 15,
  },
});

export function resourceEstimate(scenario = RESOURCE_SCENARIOS.base, offered = 100) {
  if (!Number.isFinite(offered) || offered < 0) throw new RangeError('offered must be non-negative');
  for (const key of ['completion', 'attendance', 'physicianUse', 'repeat', 'supportRate']) {
    if (!Number.isFinite(scenario[key]) || scenario[key] < 0 || scenario[key] > 1) throw new RangeError(key);
  }
  const completed = offered * scenario.completion;
  const usedVisits = completed * scenario.attendance * scenario.physicianUse;
  const repeats = usedVisits * scenario.repeat;
  const row = (id, role, count, before, after) => ({ id, role, count, before, after, netMinutes: count * (before - after) });
  const rows = [
    row('invite', 'gp', offered, 0, scenario.inviteMinutes),
    row('initial-scales', 'gp', completed, scenario.scaleBefore, scenario.scaleAfter),
    row('pre-visit', 'psychiatrist', usedVisits, scenario.prepBefore, scenario.prepAfter),
    row('documentation', 'psychiatrist', usedVisits, scenario.noteBefore, scenario.noteAfter),
    row('plan-handoff', 'psychiatrist', usedVisits, scenario.planBefore, scenario.planAfter),
    row('ehr-copy', 'psychiatrist', usedVisits, 0, scenario.ehrCopy),
    row('repeat-scales', 'psychiatrist', repeats, scenario.repeatBefore, scenario.repeatAfter),
    row('support', 'coordinator', offered * scenario.supportRate, 0, scenario.supportMinutes),
    // Training is a fixed allocated overhead, not a per-patient saving.
    row('training', 'physician', offered > 0 ? 1 : 0, 0, scenario.monthlyTraining),
  ];
  const netMinutes = rows.reduce((sum, r) => sum + r.netMinutes, 0);
  const physicianMinutes = rows.filter(r => r.role !== 'coordinator').reduce((sum, r) => sum + r.netMinutes, 0);
  const coordinatorMinutes = netMinutes - physicianMinutes;
  return { offered, completed, usedVisits, repeats, rows, netMinutes, netHours: netMinutes / 60, physicianMinutes, coordinatorMinutes };
}

export function patientWorkload({ offered=100, completed=75, usedVisits=36, repeats=21.6, diaryDays=8 }={}) {
  // Both groups complete the same self-report scales. New diaries have no
  // comparable time saving when the control group did not keep a diary.
  const before = completed * 6 + repeats * 6 + usedVisits * (5 + 2);
  const after = offered * 2 + completed * (6 + diaryDays) + repeats * 6 + usedVisits * 2;
  return { before, after, addedMinutes: after - before, diaryEntries: completed * diaryDays };
}

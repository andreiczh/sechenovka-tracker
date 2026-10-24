import { RESOURCE_SCENARIOS, resourceEstimate, patientWorkload } from '../lib/resource-model.mjs';

const cases = Object.fromEntries(Object.entries(RESOURCE_SCENARIOS).map(([name, assumptions]) => [name, { assumptions, estimate: resourceEstimate(assumptions) }]));
const base=cases.base.estimate;
const patient=patientWorkload();
const value=base.physicianMinutes/60*1500+base.coordinatorMinutes/60*500;
console.log(JSON.stringify({
  status: 'ASSUMPTIONS_NOT_OBSERVED_RESULTS', cases,
  patient, illustrativeMonthlyCapacityValueRub:value,
  sensitivity: {
    scalesAlreadyDigital:resourceEstimate({...RESOURCE_SCENARIOS.base,scaleBefore:1.25,repeatBefore:1}).netHours,
    firstMonth180MinTraining:resourceEstimate({...RESOURCE_SCENARIOS.base,monthlyTraining:180}).netHours,
    extraDocumentationReviewPerVisitMinutes:1,
    afterExtraReviewHours:(base.netMinutes-base.usedVisits)/60,
    breakEvenExtraReviewPerVisit:base.netMinutes/base.usedVisits,
    fullyCompletedCycleNetBeforeFixedSupportMinutes:1.75+3+.5+1-1+.6*2-1,
  },
},null,2));

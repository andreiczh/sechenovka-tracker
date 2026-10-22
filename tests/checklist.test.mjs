import test from 'node:test';
import assert from 'node:assert/strict';
import { checklistGroups, evaluateChecklist } from '../public/clinical-data.js';

const ids = checklistGroups.flatMap(group => group.items.map(item => item.id));

test('demo CTA boundary is six of ten observations, never a risk probability', () => {
  assert.equal(ids.length, 10);
  assert.equal(evaluateChecklist(ids.slice(0, 5)).thresholdReached, false);
  const atBoundary = evaluateChecklist(ids.slice(0, 6));
  assert.equal(atBoundary.thresholdReached, true);
  assert.equal(atBoundary.requiredCount, 6);
  assert.equal(atBoundary.fraction, 0.6);
  assert.equal('diagnosis' in atBoundary, false);
  assert.equal('riskProbability' in atBoundary, false);
});

test('safety concern is visible with zero routine observations and not counted toward the CTA', () => {
  const result = evaluateChecklist([], ['current-danger']);
  assert.equal(result.count, 0);
  assert.equal(result.safetyConcern, true);
  assert.equal(result.thresholdReached, false);
});

test('repeated and unknown identifiers cannot inflate the demonstration counter', () => {
  const result = evaluateChecklist([ids[0], ids[0], 'unknown'], ['unknown']);
  assert.equal(result.count, 1);
  assert.equal(result.safetyConcern, false);
  assert.equal(result.total, 10);
});

test('safety indication survives a fully selected routine checklist', () => {
  const result = evaluateChecklist(ids, ['other-urgent']);
  assert.equal(result.count, 10);
  assert.equal(result.safetyConcern, true);
});

test('invalid threshold configuration fails explicitly', () => {
  for(const value of [0,-1,1.1,NaN,Infinity]) assert.throws(() => evaluateChecklist([],[],value), RangeError);
});

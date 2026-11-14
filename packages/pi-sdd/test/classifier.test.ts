import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type ClassificationSignals } from '../src/classifier.ts';

const base: ClassificationSignals = {
  changeType: 'feature',
  featureCount: 1,
  acCount: 8,
  componentCount: 1,
  parallelMarkers: false,
  existingSurfaceOnly: false,
};

test('broad refactor takes precedence over direct rule', () => {
  const result = classify({ ...base, changeType: 'refactor', componentCount: 3 });
  assert.equal(result.tier, 'incremental');
  assert.ok(result.reasons.length);
});
test('multiple features select factory', () => {
  assert.equal(classify({ ...base, featureCount: 2 }).tier, 'factory');
});
test('documentation only selects direct', () => {
  assert.equal(classify({ ...base, changeType: 'doc' }).tier, 'direct');
});
test('many criteria in one component select incremental', () => {
  assert.equal(classify(base).tier, 'incremental');
});
test('parallel markers select factory', () => {
  assert.equal(classify({ ...base, parallelMarkers: true }).tier, 'factory');
});
test('existing surface beats factory breadth', () => {
  assert.equal(classify({ ...base, featureCount: 4, existingSurfaceOnly: true }).tier, 'direct');
});
test('invalid counts are refused', () => {
  assert.throws(() => classify({ ...base, acCount: -1 }), /INVALID_CLASSIFIER_SIGNAL/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillNames, commandSkills } from '../src/catalog.ts';

test('20 namespaced skills and no existing command takeover', () => {
  assert.equal(skillNames.length, 20);
  assert.equal(new Set(skillNames).size, 20);
  assert.ok(skillNames.every(name => name.startsWith('sdd-')));
  assert.equal(commandSkills.specify, 'sdd-specify');
  assert.equal(commandSkills.review, 'sdd-review');
  assert.equal(Object.hasOwn(commandSkills, 'start'), false);
});

test('only the eleven workflow verbs map to skills', () => {
  assert.deepEqual(Object.keys(commandSkills).sort(), [
    'analyze', 'brainstorm', 'constitution', 'debug', 'document',
    'implement', 'refactor', 'review', 'specify', 'test', 'validate',
  ]);
  for (const [verb, skill] of Object.entries(commandSkills)) {
    assert.equal(skill, `sdd-${verb}`);
    assert.ok(skillNames.includes(skill));
  }
  for (const name of ['focus', 'land', 'status', 'doctor', 'off', 'subagent']) {
    assert.equal(Object.hasOwn(commandSkills, name), false);
  }
});

test('the catalog matches the twenty pinned Start skill names', () => {
  assert.deepEqual([...skillNames].sort(), [
    'analyze', 'brainstorm', 'constitution', 'debug', 'document',
    'implement-direct', 'implement-factory', 'implement-incremental',
    'implement', 'refactor', 'review', 'specify-factory',
    'specify-incremental', 'specify-meta', 'specify-requirements',
    'specify-solution', 'specify', 'test', 'validate', 'writing-skills',
  ].map(name => `sdd-${name}`).sort());
});

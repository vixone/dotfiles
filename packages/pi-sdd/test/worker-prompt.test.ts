import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkerPrompt, loadWorkerPolicy, parseWorkerTask, policyFiles } from '../src/worker-prompt.ts';
import { workerRoles } from '../src/models.ts';

const policiesDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'policies');

const unit = {
  role: 'code' as const,
  brief: 'Implement parser. SOURCE_SECRET',
  projectInstructions: [{ label: 'AGENTS.md', text: 'Use node:test. SOURCE_SECRET' }],
  publicContext: [{ label: 'acceptance', text: 'Parser accepts empty input.' }],
  feedback: [{ kind: 'review_finding' as const, text: 'Handle CRLF.' }],
};
const evaluation = {
  role: 'eval' as const,
  publicContext: [{ label: 'interface', text: 'CLI: parse <file>' }],
  scenarios: [{ id: 'S1', text: 'Given CRLF input. SCENARIO_SECRET' }],
};

test('coding prompt carries explicit unit context and never scenarios', async () => {
  const policy = await loadWorkerPolicy('code', policiesDir);
  const prompt = buildWorkerPrompt({ ...parseWorkerTask(unit), policy });
  assert.match(prompt, /SOURCE_SECRET/);
  assert.match(prompt, /Handle CRLF/);
  assert.match(prompt, /Parser accepts empty input/);
  assert.doesNotMatch(prompt, /SCENARIO_SECRET/);
  assert.throws(() => parseWorkerTask({ ...unit, scenarios: evaluation.scenarios }), /PROMPT_FIELD_FORBIDDEN: code.*scenarios/);
  assert.throws(() => parseWorkerTask({ ...unit, feedback: [{ kind: 'evaluation_report', text: 'SCENARIO_SECRET' }] }), /PROMPT_INPUT_INVALID/);
});

test('evaluator prompt carries scenarios and never unit brief, project instructions or transcripts', async () => {
  const policy = await loadWorkerPolicy('eval', policiesDir);
  const prompt = buildWorkerPrompt({ ...parseWorkerTask(evaluation), policy });
  assert.match(prompt, /SCENARIO_SECRET/);
  assert.doesNotMatch(prompt, /SOURCE_SECRET/);
  for (const field of ['brief', 'projectInstructions', 'feedback', 'transcript'] as const) {
    const leaking = { ...evaluation, [field]: field === 'brief' || field === 'transcript' ? 'SOURCE_SECRET' : unit[field] };
    assert.throws(() => parseWorkerTask(leaking), new RegExp(`PROMPT_FIELD_FORBIDDEN: eval.*${field}`));
  }
  assert.throws(() => parseWorkerTask({ ...evaluation, scenarios: [] }), /PROMPT_INPUT_INVALID/);
});

test('buildWorkerPrompt rechecks role separation and requires a policy', () => {
  const smuggled = { ...unit, scenarios: evaluation.scenarios, policy: 'x' };
  assert.throws(() => buildWorkerPrompt(smuggled), /PROMPT_FIELD_FORBIDDEN/);
  assert.throws(() => buildWorkerPrompt({ ...unit, policy: '' }), /PROMPT_INPUT_INVALID/);
});

test('every role builds from its editable common and role policy files', async () => {
  const common = await readFile(join(policiesDir, 'worker-common.md'), 'utf8');
  for (const role of workerRoles) {
    const policy = await loadWorkerPolicy(role, policiesDir);
    assert.ok(policy.startsWith(common.trim()), role);
    const own = await readFile(join(policiesDir, policyFiles[role]), 'utf8');
    assert.ok(policy.endsWith(own.trim()), role);
    const task = role === 'eval' ? evaluation : { ...unit, role };
    assert.ok(buildWorkerPrompt({ ...parseWorkerTask(task), policy }).includes(own.trim()));
  }
  const evalPolicy = await loadWorkerPolicy('eval', policiesDir);
  const codePolicy = await readFile(join(policiesDir, 'worker-code.md'), 'utf8');
  assert.ok(!evalPolicy.includes(codePolicy.trim()));
});

test('common worker policy states the parent-owned capabilities', async () => {
  const common = await readFile(join(policiesDir, 'worker-common.md'), 'utf8');
  for (const rule of [/beads/i, /nested agent/i, /push/i, /merge/i, /curl/i, /detached/i, /web/i, /MCP/, /skills/i]) assert.match(common, rule);
});

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { WorkerRole } from './models.ts';

const strict = { additionalProperties: false } as const;
const Text = Type.String({ minLength: 1, maxLength: 200_000 });
const ContextItem = Type.Object({ label: Type.String({ minLength: 1, maxLength: 200 }), text: Text }, strict);
const Feedback = Type.Object({
  kind: Type.Union([Type.Literal('review_finding'), Type.Literal('test_failure'), Type.Literal('parent_note')]),
  text: Text,
}, strict);
const Scenario = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), text: Text }, strict);

export const UnitTaskSchema = Type.Object({
  role: Type.Union([
    Type.Literal('code'), Type.Literal('fix'), Type.Literal('performance'), Type.Literal('research'),
    Type.Literal('review'), Type.Literal('prose'), Type.Literal('hardest'),
  ]),
  brief: Text,
  projectInstructions: Type.Array(ContextItem),
  publicContext: Type.Array(ContextItem),
  feedback: Type.Array(Feedback),
}, strict);

export const EvalTaskSchema = Type.Object({
  role: Type.Literal('eval'),
  publicContext: Type.Array(ContextItem),
  scenarios: Type.Array(Scenario, { minItems: 1 }),
}, strict);

export const WorkerTaskSchema = Type.Union([UnitTaskSchema, EvalTaskSchema]);
export type WorkerTask = Static<typeof WorkerTaskSchema>;
export type WorkerPromptInput = WorkerTask & { policy: string };

const unitOnly = ['brief', 'projectInstructions', 'feedback', 'transcript'];
const evalOnly = ['scenarios', 'evaluationReport'];

export const policyFiles: Record<WorkerRole, string> = {
  code: 'worker-code.md',
  fix: 'worker-code.md',
  performance: 'worker-code.md',
  hardest: 'worker-code.md',
  research: 'worker-research.md',
  review: 'worker-review.md',
  prose: 'worker-review.md',
  eval: 'worker-eval.md',
};

export function parseWorkerTask(value: unknown): WorkerTask {
  if (typeof value === 'object' && value !== null && 'role' in value) {
    const forbidden = value.role === 'eval' ? unitOnly : evalOnly;
    const present = forbidden.filter(field => Object.hasOwn(value, field));
    if (present.length > 0) throw new Error(`PROMPT_FIELD_FORBIDDEN: ${String(value.role)} workers cannot receive ${present.join(', ')}`);
  }
  if (!Value.Check(WorkerTaskSchema, value)) {
    const first = Value.Errors(WorkerTaskSchema, value)[0];
    throw new Error(`PROMPT_INPUT_INVALID: ${first?.instancePath || '/'} ${first?.message ?? 'does not match the worker task schema'}`);
  }
  return value;
}

export async function loadWorkerPolicy(role: WorkerRole, policiesDir: string): Promise<string> {
  const [common, own] = await Promise.all([
    readFile(join(policiesDir, 'worker-common.md'), 'utf8'),
    readFile(join(policiesDir, policyFiles[role]), 'utf8'),
  ]);
  return `${common.trim()}\n\n${own.trim()}`;
}

function section(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

function items(list: readonly { label: string; text: string }[]): string {
  return list.map(item => `## ${item.label}\n${item.text}`).join('\n\n');
}

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const { policy, ...rest } = input;
  if (typeof policy !== 'string' || !policy.trim()) throw new Error('PROMPT_INPUT_INVALID: /policy must be non-empty');
  const task = parseWorkerTask(rest);
  const parts = [section('worker-policy', policy.trim())];
  if (task.role === 'eval') {
    if (task.publicContext.length) parts.push(section('public-context', items(task.publicContext)));
    parts.push(section('scenarios', task.scenarios.map(scenario => `## ${scenario.id}\n${scenario.text}`).join('\n\n')));
    return parts.join('\n\n');
  }
  parts.push(section('unit-brief', task.brief));
  if (task.projectInstructions.length) parts.push(section('project-instructions', items(task.projectInstructions)));
  if (task.publicContext.length) parts.push(section('public-context', items(task.publicContext)));
  if (task.feedback.length) parts.push(section('parent-feedback', task.feedback.map(item => `- ${item.kind}: ${item.text}`).join('\n')));
  return parts.join('\n\n');
}

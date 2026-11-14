import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { EvaluationConfigSchema, parseEvaluationConfig } from './evaluation-schema.ts';

const text = Type.String({ minLength: 1, pattern: '\\S' });
const key = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' });
const path = Type.String({ pattern: '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\\\u0000]+$' });
const nullablePath = Type.Union([path, Type.Null()]);

export const TaskDefinitionSchema = Type.Object({
  key,
  title: text,
  kind: Type.Union([
    Type.Literal('feature'),
    Type.Literal('fix'),
    Type.Literal('refactor'),
    Type.Literal('doc'),
  ]),
  phase: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  dependsOn: Type.Array(key, { uniqueItems: true }),
  files: Type.Array(path, { minItems: 1, uniqueItems: true }),
  brief: path,
  unit: nullablePath,
  scenarios: Type.Array(path, { uniqueItems: true }),
}, { additionalProperties: false });
export type TaskDefinition = Static<typeof TaskDefinitionSchema>;

export const SpecSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  evaluation: Type.Union([EvaluationConfigSchema, Type.Null()]),
  specId: Type.String({ pattern: '^(?!000)[0-9]{3}$' }),
  slug: Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }),
  tier: Type.Union([
    Type.Literal('unselected'),
    Type.Literal('direct'),
    Type.Literal('incremental'),
    Type.Literal('factory'),
  ]),
  documents: Type.Object({
    requirements: nullablePath,
    solution: nullablePath,
  }, { additionalProperties: false }),
  omissions: Type.Object({
    requirements: Type.Optional(text),
    solution: Type.Optional(text),
  }, { additionalProperties: false }),
  tasks: Type.Array(TaskDefinitionSchema),
  binding: Type.Union([
    Type.Null(),
    Type.Object({
      missionId: text,
      taskIds: Type.Record(key, text),
    }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
export type SpecDescriptor = Static<typeof SpecSchema>;

export function validateGraph(tasks: TaskDefinition[]): void {
  const byKey = new Map(tasks.map(t => [t.key, t]));
  if (byKey.size !== tasks.length) throw new Error('DUPLICATE_TASK');
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(task: TaskDefinition): void {
    if (visiting.has(task.key)) throw new Error('TASK_CYCLE');
    if (done.has(task.key)) return;
    visiting.add(task.key);
    for (const dep of task.dependsOn) {
      const parent = byKey.get(dep);
      if (!parent) throw new Error('UNKNOWN_DEPENDENCY');
      if (task.phase !== null && parent.phase !== null && parent.phase > task.phase) {
        throw new Error('INVALID_PHASE_ORDER');
      }
      visit(parent);
    }
    visiting.delete(task.key);
    done.add(task.key);
  }
  tasks.forEach(visit);
}

export function parseSpec(input: unknown): SpecDescriptor {
  if (typeof input === 'object' && input !== null && !('evaluation' in input)) input = { ...input, evaluation: null };
  if (!Value.Check(SpecSchema, input)) throw new Error('INVALID_SPEC');
  if (input.evaluation) parseEvaluationConfig(input.evaluation);
  validateGraph(input.tasks);
  for (const name of ['requirements', 'solution'] as const) {
    if (input.documents[name] === null && !input.omissions[name] && input.tier !== 'unselected') {
      throw new Error('OMISSION_REASON_REQUIRED');
    }
  }
  if (input.tier !== 'unselected' && input.tasks.length === 0) throw new Error('TASKS_REQUIRED');
  if (input.tier === 'direct' && input.tasks.length > 3) throw new Error('DIRECT_TASK_LIMIT');
  if (input.tier === 'incremental') {
    if (input.tasks.some(t => t.phase === null)) throw new Error('PHASE_REQUIRED');
    const phases = [...new Set(input.tasks.map(t => t.phase))].sort((a, b) => (a ?? 0) - (b ?? 0));
    if (phases.some((phase, index) => phase !== index + 1)) throw new Error('PHASE_GAP');
  }
  if (input.tier === 'factory' && input.tasks.some(t => t.scenarios.length === 0)) {
    throw new Error('SCENARIOS_REQUIRED');
  }
  if (input.binding && Object.keys(input.binding.taskIds).some(k => !input.tasks.some(t => t.key === k))) {
    throw new Error('UNKNOWN_BINDING');
  }
  return input;
}

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSddMetadata, type ChildIssue, type Issue, type SddMetadata } from './beads-schema.ts';
import type { BeadsClient } from './beads.ts';
import { acquireProjectLock, repositoryRoot } from './project-lock.ts';
import { parseSpec, type SpecDescriptor, type TaskDefinition } from './spec-schema.ts';
import { contentRevision, resolveSpec } from './spec-store.ts';

export interface MaterializeResult {
  spec: SpecDescriptor;
  createdIds: string[];
  reusedIds: string[];
}

interface BoundSpec {
  root: string;
  path: string;
  spec: SpecDescriptor;
}

async function loadDescriptor(projectRoot: string, supplied: SpecDescriptor): Promise<BoundSpec> {
  const spec = parseSpec(supplied);
  const root = await repositoryRoot(projectRoot);
  const resolved = await resolveSpec({ projectRoot: root, target: spec.specId });
  if (resolved.kind !== 'descriptor' || resolved.spec.slug !== spec.slug) throw new Error('SPEC_IDENTITY_MISMATCH');
  return { root, path: resolved.path, spec: resolved.spec };
}

function assertActionRow(issue: Issue, epicId: string): void {
  const valid = issue.parent === epicId && issue.issue_type === 'task' && issue.title.startsWith('[action] ');
  if (!valid) throw new Error(`TASK_IDENTITY_MISMATCH: ${issue.id}`);
}

function matchingChildren(children: ChildIssue[], specPath: string, epicId: string): Map<string, ChildIssue[]> {
  const byKey = new Map<string, ChildIssue[]>();
  for (const child of children) {
    const sdd = readSddMetadata(child);
    if (!sdd || sdd.specPath !== specPath) continue;
    assertActionRow(child, epicId);
    byKey.set(sdd.taskKey, [...byKey.get(sdd.taskKey) ?? [], child]);
  }
  return byKey;
}

async function describe(path: string, task: TaskDefinition): Promise<string> {
  const brief = await readFile(join(path, task.brief), 'utf8');
  return [
    `Spec: ${path}`,
    `Task: ${task.key} (${task.kind}${task.phase === null ? '' : `, phase ${task.phase}`})`,
    `Files:\n${task.files.map(file => `- ${file}`).join('\n')}`,
    `Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none'}`,
    `Brief (${task.brief}):\n${brief.trim()}`,
  ].join('\n\n');
}

async function writeBinding(path: string, expected: SpecDescriptor['binding'], binding: NonNullable<SpecDescriptor['binding']>): Promise<SpecDescriptor> {
  const file = join(path, 'spec.json');
  const current = parseSpec(JSON.parse(await readFile(file, 'utf8')));
  if (JSON.stringify(current.binding) !== JSON.stringify(expected)) throw new Error('BINDING_CHANGED_DURING_MATERIALIZE');
  const spec = parseSpec({ ...current, binding });
  if (JSON.stringify(current.binding) === JSON.stringify(binding)) return spec;
  const staging = `${file}.${process.pid}.tmp`;
  await writeFile(staging, JSON.stringify(spec, null, 2) + '\n', { flag: 'wx' });
  await rename(staging, file);
  return spec;
}

export async function materialize({ client, projectRoot, spec: supplied, missionId, sessionId = process.env.PI_SESSION_ID }: {
  client: BeadsClient;
  projectRoot: string;
  spec: SpecDescriptor;
  missionId: string;
  sessionId?: string | undefined;
}): Promise<MaterializeResult> {
  const lock = await acquireProjectLock({ projectRoot, sessionId });
  try {
    const { root, path, spec } = await loadDescriptor(projectRoot, supplied);
    const revision = await contentRevision({ projectRoot: root, spec: supplied });
    if (spec.tier === 'unselected') throw new Error('TIER_UNSELECTED');
    for (const binding of [spec.binding, supplied.binding]) {
      if (binding && binding.missionId !== missionId) {
        throw new Error(`BINDING_CONFLICT: spec is bound to ${binding.missionId}`);
      }
    }

    const epic = await client.show(missionId);
    if (epic.issue_type !== 'epic') throw new Error(`MISSION_NOT_EPIC: ${missionId} is ${epic.issue_type}`);
    if (epic.status === 'closed') throw new Error(`MISSION_CLOSED: ${missionId}`);

    const children = await client.children(missionId);
    const found = matchingChildren(children, path, missionId);
    for (const [key, matches] of found) {
      if (matches.length > 1) throw new Error(`DUPLICATE_TASK_KEY: ${key} -> ${matches.map(child => child.id).join(', ')}`);
    }
    for (const [key, id] of Object.entries(spec.binding?.taskIds ?? {})) {
      const match = found.get(key)?.[0];
      if (match?.id !== id) throw new Error(`BOUND_TASK_MISSING: ${key} -> ${id}`);
    }

    const ids: Record<string, string> = {};
    const rows = new Map<string, ChildIssue>();
    const createdIds: string[] = [];
    const reusedIds: string[] = [];
    for (const task of spec.tasks) {
      const sdd: SddMetadata = { schemaVersion: 1, specPath: path, taskKey: task.key, revision };
      const title = `[action] ${task.title}`;
      const description = await describe(path, task);
      const existing = found.get(task.key)?.[0];
      if (existing) {
        const current = readSddMetadata(existing);
        if (current && current.revision !== revision) {
          await client.update(existing.id, {
            title,
            description,
            metadata: { ...existing.metadata, sdd: { ...current, revision } },
          });
        }
        ids[task.key] = existing.id;
        rows.set(task.key, existing);
        reusedIds.push(existing.id);
        continue;
      }
      const created = await client.createAction({
        epicId: missionId,
        title,
        description,
        specPath: path,
        metadata: { sdd },
      });
      assertActionRow(created, missionId);
      const confirmed = readSddMetadata(created);
      if (confirmed?.taskKey !== task.key || confirmed.specPath !== path) throw new Error(`CREATE_NOT_CONFIRMED: ${created.id}`);
      ids[task.key] = created.id;
      createdIds.push(created.id);
    }

    for (const task of spec.tasks) {
      const dependentId = ids[task.key];
      if (!dependentId) throw new Error(`UNRESOLVED_TASK: ${task.key}`);
      const present = new Set((rows.get(task.key)?.dependencies ?? []).map(edge => edge.depends_on_id));
      for (const key of task.dependsOn) {
        const prerequisiteId = ids[key];
        if (!prerequisiteId) throw new Error(`UNRESOLVED_TASK: ${key}`);
        if (present.has(prerequisiteId)) continue;
        await client.addDependency({ dependentId, prerequisiteId });
      }
    }

    if (await contentRevision({ projectRoot: root, spec: supplied }) !== revision) {
      throw new Error('SPEC_CHANGED_DURING_MATERIALIZE');
    }
    const bound = await writeBinding(path, spec.binding, { missionId, taskIds: ids });
    return { spec: bound, createdIds, reusedIds };
  } finally {
    await lock.release();
  }
}

export async function readTaskStates({ client, projectRoot, spec: supplied }: {
  client: BeadsClient;
  projectRoot: string;
  spec: SpecDescriptor;
}): Promise<Record<string, string>> {
  const { path, spec } = await loadDescriptor(projectRoot, supplied);
  if (!spec.binding || !supplied.binding) throw new Error('SPEC_NOT_BOUND');
  if (JSON.stringify(spec.binding) !== JSON.stringify(supplied.binding)) throw new Error('STALE_BINDING');
  const found = matchingChildren(await client.children(spec.binding.missionId), path, spec.binding.missionId);
  const states: Record<string, string> = {};
  for (const [key, id] of Object.entries(spec.binding.taskIds)) {
    const matches = found.get(key) ?? [];
    if (matches.length !== 1 || matches[0]?.id !== id) throw new Error(`BOUND_TASK_MISSING: ${key} -> ${id}`);
    states[key] = matches[0].status;
  }
  return states;
}

import { mkdir, readFile, writeFile, readdir, realpath, stat, rm } from 'node:fs/promises';
import { resolve, relative, dirname, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSpec, type SpecDescriptor } from './spec-schema.ts';

export type ResolvedSpec =
  | { kind: 'descriptor'; path: string; spec: SpecDescriptor }
  | {
      kind: 'legacy';
      path: string;
      inferredTier: 'direct' | 'incremental' | 'factory';
      requiresImport: true;
      requiresApproval: true;
    };

const locations = ['.start/specs', 'docs/specs'];

async function repositoryRoot(projectRoot: string): Promise<string> {
  const supplied = await realpath(projectRoot);
  let current = supplied;
  while (true) {
    if (await exists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return supplied;
    current = parent;
  }
}

function escapeName(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').replace(/[&<>\\`*_{}\[\]()#+.!|~-]/g, character => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    return `&#${character.charCodeAt(0)};`;
  });
}

function inside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('OUTSIDE_PROJECT');
  }
}

async function safe(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  inside(root, absolute);
  let current = absolute;
  while (true) {
    try {
      inside(root, await realpath(current));
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  return absolute;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function inventory(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const location of locations) {
    const base = await safe(root, location);
    if (!await exists(base)) continue;
    for (const entry of await readdir(base)) {
      if (!/^[0-9]{3}-[a-z0-9-]+$/.test(entry)) continue;
      const path = await safe(root, join(location, entry));
      if ((await stat(path)).isDirectory()) result.push(path);
    }
  }
  return result.sort();
}

export async function resolveSpec({ projectRoot, target }: {
  projectRoot: string;
  target: string;
}): Promise<ResolvedSpec> {
  const root = await repositoryRoot(projectRoot);
  if (!target || target.split(/[\\/]/).includes('..')) throw new Error('INVALID_TARGET');
  let path: string;
  if (/^\d+$/.test(target)) {
    if (!/^(?!000)[0-9]{3}$/.test(target)) throw new Error('INVALID_SPEC_ID');
    const matches = (await inventory(root)).filter(p => p.split('/').at(-1)?.startsWith(target + '-'));
    if (matches.length > 1) throw new Error('AMBIGUOUS_SPEC');
    const match = matches[0];
    if (!match) throw new Error('SPEC_NOT_FOUND');
    path = match;
  } else {
    const artifact = await safe(root, target);
    if (!await exists(artifact)) throw new Error('SPEC_NOT_FOUND');
    const matches = (await inventory(root)).filter(p => artifact === p || artifact.startsWith(p + '/'));
    const match = matches[0];
    if (matches.length !== 1 || !match) throw new Error('INVALID_SPEC_PATH');
    path = match;
  }
  const descriptor = await safe(root, join(path, 'spec.json'));
  if (await exists(descriptor)) {
    const input: unknown = JSON.parse(await readFile(descriptor, 'utf8'));
    const spec = parseSpec(input);
    if (path.split('/').at(-1) !== `${spec.specId}-${spec.slug}`) throw new Error('SPEC_IDENTITY_MISMATCH');
    return { kind: 'descriptor', path, spec };
  }
  const plan = await exists(await safe(root, join(path, 'plan')));
  const factory = await exists(await safe(root, join(path, 'manifest.md')));
  if (plan && factory) throw new Error('AMBIGUOUS_LEGACY_TIER');
  let hasDocuments = false;
  for (const name of ['requirements.md', 'solution.md', 'product-requirements.md', 'solution-design.md']) {
    if (await exists(await safe(root, join(path, name)))) hasDocuments = true;
  }
  if (!plan && !factory && !hasDocuments) throw new Error('NO_SPEC_ARTIFACTS');
  return {
    kind: 'legacy',
    path,
    inferredTier: factory ? 'factory' : plan ? 'incremental' : 'direct',
    requiresImport: true,
    requiresApproval: true,
  };
}

export async function createSpec({ projectRoot, name }: {
  projectRoot: string;
  name: string;
}): Promise<Extract<ResolvedSpec, { kind: 'descriptor' }>> {
  const root = await repositoryRoot(projectRoot);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('EMPTY_SLUG');
  const base = await safe(root, '.start/specs');
  await mkdir(base, { recursive: true });
  const lock = join(base, '.creation-lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('SPEC_CREATION_LOCKED');
    throw error;
  }
  try {
    const owner = { pid: process.pid, createdAt: new Date().toISOString() };
    await writeFile(join(lock, 'owner.json'), JSON.stringify(owner) + '\n', { flag: 'wx' });
    const ids = (await inventory(root)).map(p => Number(p.split('/').at(-1)?.slice(0, 3)));
    const id = Math.max(0, ...ids) + 1;
    if (id > 999) throw new Error('SPEC_ID_EXHAUSTED');
    const spec = parseSpec({
      schemaVersion: 1,
      evaluation: null,
      specId: String(id).padStart(3, '0'),
      slug,
      tier: 'unselected',
      documents: { requirements: null, solution: null },
      omissions: {},
      tasks: [],
      binding: null,
    });
    const path = await safe(root, join(base, `${spec.specId}-${slug}`));
    await mkdir(path);
    const template = await readFile(new URL('../templates/spec-readme.md', import.meta.url), 'utf8');
    await writeFile(join(path, 'README.md'), template.replaceAll('{{name}}', escapeName(name)), { flag: 'wx' });
    await writeFile(join(path, 'spec.json'), JSON.stringify(spec, null, 2) + '\n', { flag: 'wx' });
    return { kind: 'descriptor', path, spec };
  } finally {
    await rm(lock, { recursive: true });
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

function staticData({ binding, ...data }: SpecDescriptor) {
  return data;
}

export async function contentRevision({ projectRoot, spec }: {
  projectRoot: string;
  spec: SpecDescriptor;
}): Promise<string> {
  spec = parseSpec(spec);
  const root = await repositoryRoot(projectRoot);
  const resolved = await resolveSpec({ projectRoot: root, target: spec.specId });
  if (resolved.kind !== 'descriptor' || resolved.spec.slug !== spec.slug) throw new Error('SPEC_IDENTITY_MISMATCH');
  const data = staticData(resolved.spec);
  if (canonical(staticData(spec)) !== canonical(data)) throw new Error('STALE_SPEC');
  spec = resolved.spec;
  const hash = createHash('sha256');
  hash.update(canonical(data));
  const paths = new Set<string>([
    ...Object.values(spec.documents).filter(p => p !== null),
    ...spec.tasks.flatMap(t => [t.brief, ...(t.unit ? [t.unit] : []), ...t.scenarios]),
  ]);
  for (const path of [...paths].sort()) {
    const file = await safe(root, join(resolved.path, path));
    inside(resolved.path, file);
    inside(resolved.path, await realpath(file));
    const bytes = await readFile(file);
    hash.update(canonical([path, bytes.toString('base64')]));
  }
  const dirs = new Set([root, resolved.path]);
  for (const task of spec.tasks) {
    for (const file of task.files) {
      let dir = dirname(await safe(root, file));
      while (dir !== root) {
        dirs.add(dir);
        dir = dirname(dir);
      }
    }
  }
  for (const dir of [...dirs].sort()) {
    for (const name of ['CONSTITUTION.md', 'AGENTS.md']) {
      const file = await safe(root, join(dir, name));
      if (await exists(file)) {
        hash.update(canonical([relative(root, file), (await readFile(file)).toString('base64')]));
      }
    }
  }
  return hash.digest('hex');
}

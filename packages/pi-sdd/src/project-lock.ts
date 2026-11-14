import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const LockOwnerSchema = Type.Object({
  token: Type.String({ minLength: 1 }),
  pid: Type.Integer(),
  hostname: Type.String(),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  acquiredAt: Type.String(),
});
export type LockOwner = Static<typeof LockOwnerSchema>;

export class ProjectLockError extends Error {
  readonly owner: LockOwner | null;

  constructor(code: string, owner: LockOwner | null) {
    const detail = owner
      ? `held by session ${owner.sessionId ?? 'unknown'} pid ${owner.pid} on ${owner.hostname} since ${owner.acquiredAt}`
      : 'owner evidence unreadable; reconcile explicitly';
    super(`${code}: ${detail}`);
    this.name = 'ProjectLockError';
    this.owner = owner;
  }
}

export interface ProjectLock {
  readonly root: string;
  readonly owner: LockOwner;
  held(): boolean;
  verify(): Promise<void>;
  release(): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export async function repositoryRoot(projectRoot: string): Promise<string> {
  const supplied = await realpath(projectRoot);
  let current = supplied;
  while (true) {
    try {
      await stat(join(current, '.git'));
      return current;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return supplied;
    current = parent;
  }
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const owner: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Value.Check(LockOwnerSchema, owner) ? owner : null;
  } catch {
    return null;
  }
}

async function confinedDirectory(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const resolved = await realpath(current);
    if (resolved !== current || !resolved.startsWith(root + sep)) {
      throw new Error(`PROJECT_LOCK_PATH_ESCAPES: ${current} -> ${resolved}`);
    }
  }
  return current;
}

export async function acquireProjectLock({ projectRoot, sessionId }: {
  projectRoot: string;
  sessionId?: string | undefined;
}): Promise<ProjectLock> {
  const root = await repositoryRoot(projectRoot);
  const locks = await confinedDirectory(root, ['.pi', 'sdd', 'locks']);
  const path = join(locks, 'project.lock');
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    sessionId: sessionId ?? null,
    acquiredAt: new Date().toISOString(),
  };
  const staging = join(locks, `.staging-${owner.token}`);
  await writeFile(staging, JSON.stringify(owner) + '\n', { flag: 'wx' });
  try {
    await link(staging, path);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new ProjectLockError('PROJECT_LOCKED', await readOwner(path));
    throw error;
  } finally {
    await unlink(staging);
  }
  let released = false;
  const verify = async () => {
    const current = await readOwner(path);
    if (current?.token !== owner.token) throw new ProjectLockError('PROJECT_LOCK_OWNER_CHANGED', current);
  };
  return {
    root,
    owner,
    held: () => !released,
    verify,
    release: async () => {
      if (released) return;
      await verify();
      await unlink(path);
      released = true;
    },
  };
}

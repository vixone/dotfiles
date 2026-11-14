import { constants, lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isWithin, type DenyRules, type Policy } from "./policy.ts";

export class PathError extends Error {
  override name = "PathError";
}

/** A path that passed confinement. Only constructors in this module create it. */
export type ConfinedPath = string & { readonly __brand: "ConfinedPath" };

export type Access = "read" | "write";

export interface Root {
  readonly name: string;
  readonly path: string;
}

/** Workspace, repos, then the read-only roots. Writes use only the workspace (confineWrite). */
export function readRoots(policy: Policy): Root[] {
  return [
    { name: "workspace", path: policy.workspace },
    ...Object.entries(policy.repos).map(([name, path]) => ({ name, path })),
    ...Object.entries(policy.readOnlyRoots).map(([name, path]) => ({ name, path })),
  ];
}

export function isDeniedName(name: string, deny: DenyRules): boolean {
  const lower = name.toLowerCase();
  if (deny.fileNames.includes(lower)) return true;
  if (deny.fileNamePrefixes.some((p) => lower.startsWith(p))) return true;
  return deny.suffixes.some((s) => lower.endsWith(s));
}

/** Rejects a path when any segment below its root is a denied directory or file name. */
export function assertNotDenied(root: string, target: string, deny: DenyRules): void {
  const rel = relative(root, target);
  if (rel === "") return;
  for (const segment of rel.split(sep)) {
    if (deny.pathSegments.includes(segment)) throw new PathError(`access to '${segment}' paths is denied`);
    if (isDeniedName(segment, deny)) throw new PathError(`access to '${segment}' is denied`);
  }
}

function realRoot(root: Root): Root | undefined {
  try {
    return { name: root.name, path: realpathSync(root.path) };
  } catch {
    return undefined;
  }
}

/** Normalizes the model's argument. Relative paths resolve against the workspace. */
export function normalizeInput(input: string, workspace: string): string {
  let p = input.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (p.length === 0) throw new PathError("path is empty");
  if (p.includes("\0")) throw new PathError("path contains a NUL byte");
  if (p.startsWith("~")) throw new PathError("'~' paths are not supported; use an absolute path (fs_list with no path shows the roots)");
  return isAbsolute(p) ? resolve(p) : resolve(workspace, p);
}

function lexicalRoot(roots: readonly Root[], abs: string): Root {
  const root = roots.find((r) => isWithin(r.path, abs));
  if (!root) throw new PathError(`path is outside the allowed roots (${roots.map((r) => r.name).join(", ")})`);
  return root;
}

/**
 * Resolves an existing file or directory for reading. Both the lexical path and its realpath must lie under an
 * allowed root and pass the deny rules, so traversal and symlinks out of the roots are refused.
 */
export function confineRead(policy: Policy, input: string): ConfinedPath {
  const roots = readRoots(policy);
  const abs = normalizeInput(input, policy.workspace);
  const lexRoot = lexicalRoot(roots, abs);
  assertNotDenied(lexRoot.path, abs, policy.deny);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new PathError(`path does not exist: ${input}`);
  }
  const realRoots = roots.map(realRoot).filter((r): r is Root => r !== undefined);
  const root = realRoots.find((r) => isWithin(r.path, real));
  if (!root) throw new PathError("path resolves outside the allowed roots (symlink)");
  assertNotDenied(root.path, real, policy.deny);
  return real as ConfinedPath;
}

/**
 * Resolves a file path for writing inside the workspace. Refuses symlinks at the target, missing or symlinked
 * ancestors outside the workspace, and denied names. Creates missing parent directories after the checks.
 */
export function confineWrite(policy: Policy, input: string): ConfinedPath {
  const abs = normalizeInput(input, policy.workspace);
  const roots: Root[] = [{ name: "workspace", path: policy.workspace }];
  lexicalRoot(roots, abs);
  if (abs === policy.workspace) throw new PathError("cannot write the workspace directory itself");
  assertNotDenied(policy.workspace, abs, policy.deny);
  const realWorkspace = realpathSync(policy.workspace);

  let existing = dirname(abs);
  const missing: string[] = [];
  for (;;) {
    let st: Stats | undefined;
    try {
      st = lstatSync(existing);
    } catch {
      st = undefined;
    }
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        const realExisting = realpathSync(existing);
        if (!isWithin(realWorkspace, realExisting)) throw new PathError("parent directory resolves outside the workspace");
        if (!lstatSync(realExisting).isDirectory()) throw new PathError("parent is not a directory");
      }
      break;
    }
    missing.unshift(existing);
    existing = dirname(existing);
  }
  const realParent = realpathSync(existing);
  if (!isWithin(realWorkspace, realParent)) throw new PathError("parent directory resolves outside the workspace");
  assertNotDenied(realWorkspace, realParent, policy.deny);
  for (const dir of missing) mkdirSync(dir, { mode: 0o755 });

  let target: Stats | undefined;
  try {
    target = lstatSync(abs);
  } catch {
    target = undefined;
  }
  if (target?.isSymbolicLink()) throw new PathError("refusing to write through a symlink");
  if (target && !target.isFile()) throw new PathError("target exists and is not a regular file");
  const finalPath = resolve(realpathSync(dirname(abs)), basename(abs));
  if (!isWithin(realWorkspace, finalPath)) throw new PathError("target resolves outside the workspace");
  assertNotDenied(realWorkspace, finalPath, policy.deny);
  return finalPath as ConfinedPath;
}

/** open(2) flags for writes: never follow a symlink at the final component. */
export const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
export const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

/** Display form for tool output: root name plus relative path. */
export function displayPath(policy: Policy, abs: string): string {
  for (const root of readRoots(policy)) {
    let real = root.path;
    try {
      real = realpathSync(root.path);
    } catch {
      /* keep lexical */
    }
    if (isWithin(real, abs)) return `${root.name}:${relative(real, abs) || "."}`;
  }
  return abs;
}

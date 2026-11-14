import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertNotDenied, PathError } from "./paths.ts";
import { isWithin, type Policy } from "./policy.ts";
import { childEnv, type CommandRunner } from "./runner.ts";
import { truncateText } from "./text.ts";

export class GitError extends Error {
  override name = "GitError";
}

export type GitOp = "status" | "diff" | "log" | "show" | "fetch" | "worktree_add" | "add" | "commit" | "push";

export interface GitParams {
  readonly op: GitOp;
  readonly repo?: string;
  readonly worktree?: string;
  readonly rev?: string;
  readonly paths?: readonly string[];
  readonly staged?: boolean;
  readonly maxCount?: number;
  readonly name?: string;
  readonly branch?: string;
  readonly base?: string;
  readonly subject?: string;
  readonly body?: string;
}

export const WORKTREE_NAME = /^[a-z0-9][a-z0-9._-]{0,60}$/;
export const REV = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}:-]{0,200}$/;
export const GIT_LIMITS = { name: 61, rev: 201, path: 500, paths: 100, body: 2000 } as const;
const SUBJECT = /^[a-z]+(\([a-z0-9._/-]+\))?!?: \S.*$/;

/** Fixed config for every git call: no hooks, no fsmonitor, no pager, no ext:: transport. */
const GIT_PREFIX = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "protocol.ext.allow=never", "-c", "color.ui=false",
  // Network git only over ssh to the checked origin, never prompting.
  "-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always", "-c", "core.sshCommand=/usr/bin/ssh -o BatchMode=yes"];

export function worktreesRoot(policy: Policy): string {
  return join(policy.workspace, "worktrees");
}

interface Location {
  readonly kind: "repo" | "worktree";
  readonly dir: string;
  readonly label: string;
}

function repoDir(policy: Policy, name: string | undefined): Location {
  if (!name) throw new GitError("repo is required");
  const dir = policy.repos[name];
  if (!dir) throw new GitError(`unknown repo '${name}'; known: ${Object.keys(policy.repos).join(", ")}`);
  return { kind: "repo", dir, label: `repo ${name}` };
}

function worktreeDir(policy: Policy, name: string | undefined): Location {
  if (!name || !WORKTREE_NAME.test(name)) throw new GitError("worktree must be a simple name under workspace/worktrees");
  const dir = join(worktreesRoot(policy), name);
  let st;
  try {
    st = lstatSync(join(dir, ".git"));
  } catch {
    throw new GitError(`worktree '${name}' does not exist; create it with op worktree_add`);
  }
  if (!st.isFile()) throw new GitError(`'${name}' is not a linked worktree`);
  if (!isWithin(realpathSync(worktreesRoot(policy)), realpathSync(dir))) throw new GitError("worktree resolves outside the workspace");
  return { kind: "worktree", dir, label: `worktree ${name}` };
}

/** The shared git dir of a checkout or linked worktree, from its .git directory or `gitdir:` file. */
function commonDir(dir: string): string | undefined {
  try {
    const dotGit = join(dir, ".git");
    if (lstatSync(dotGit).isDirectory()) return realpathSync(dotGit);
    const m = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m?.[1]) return undefined;
    const gitdir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim());
    let common = gitdir;
    try {
      common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
    } catch {
      // No commondir file: gitdir is itself the shared dir.
    }
    return realpathSync(common);
  } catch {
    return undefined;
  }
}

/**
 * The worktree when one is named, else the repo. Models fill every field, so a repo next to a worktree is accepted
 * when the worktree was made from that repo and refused when it was not.
 */
function location(policy: Policy, p: GitParams, needWorktree: boolean): Location {
  if (!needWorktree && p.worktree === undefined) return repoDir(policy, p.repo);
  const wt = worktreeDir(policy, p.worktree);
  if (p.repo !== undefined) {
    const repo = repoDir(policy, p.repo);
    const want = commonDir(repo.dir);
    if (want === undefined || commonDir(wt.dir) !== want) throw new GitError(`worktree '${p.worktree}' is not a worktree of repo '${p.repo}'; give only worktree`);
  }
  return wt;
}

function checkRev(rev: string | undefined, what: string): string | undefined {
  if (rev === undefined) return undefined;
  if (!REV.test(rev)) throw new GitError(`invalid ${what}`);
  return rev;
}

function checkPaths(policy: Policy, loc: Location, paths: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const p of paths ?? []) {
    if (p.length === 0 || p.length > GIT_LIMITS.path || p.startsWith("-") || p.startsWith(":") || p.includes("\0")) throw new GitError(`invalid path '${p}'`);
    const abs = resolve(loc.dir, p);
    if (!isWithin(loc.dir, abs)) throw new GitError(`path '${p}' leaves the ${loc.label}`);
    try {
      assertNotDenied(loc.dir, abs, policy.deny);
    } catch (error) {
      throw new GitError(error instanceof PathError ? error.message : String(error));
    }
    out.push(p);
  }
  if (out.length > GIT_LIMITS.paths) throw new GitError("too many paths");
  return out;
}

export function validateCommitMessage(policy: Policy, subject: string, body: string | undefined): void {
  if (!SUBJECT.test(subject)) throw new GitError("subject must look like 'type(scope): summary'");
  if (subject.length > policy.git.subjectMaxLength) throw new GitError(`subject is ${subject.length} characters; limit is ${policy.git.subjectMaxLength}`);
  if ((body ?? "").length > GIT_LIMITS.body) throw new GitError(`body is longer than ${GIT_LIMITS.body} characters`);
  const text = `${subject}\n${body ?? ""}`;
  for (const pattern of policy.git.forbiddenCommitPatterns) {
    if (pattern.test(text)) throw new GitError(`commit message matches forbidden pattern ${pattern.source}`);
  }
}

/** Translates a structured request into git argv. Returns the directory to run in and the argv. */
export function buildGitArgs(policy: Policy, p: GitParams): { loc: Location; args: string[]; branch?: string } {
  switch (p.op) {
    case "status": {
      const loc = location(policy, p, false);
      return { loc, args: ["status", "--short", "--branch"] };
    }
    case "diff": {
      const loc = location(policy, p, false);
      const rev = checkRev(p.rev, "rev");
      const args = ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch"];
      if (p.staged) args.push("--cached");
      if (rev) args.push(rev);
      args.push("--", ...checkPaths(policy, loc, p.paths));
      return { loc, args };
    }
    case "log": {
      const loc = location(policy, p, false);
      const rev = checkRev(p.rev, "rev");
      const n = Math.min(Math.max(p.maxCount ?? 20, 1), 200);
      const args = ["log", "--no-ext-diff", "--no-textconv", `--max-count=${n}`, "--format=%h %ad %an %s", "--date=short"];
      if (rev) args.push(rev);
      args.push("--", ...checkPaths(policy, loc, p.paths));
      return { loc, args };
    }
    case "show": {
      const loc = location(policy, p, false);
      const rev = checkRev(p.rev, "rev");
      if (!rev) throw new GitError("show needs rev (a commit, or commit:path)");
      const colon = rev.indexOf(":");
      if (colon >= 0) checkPaths(policy, loc, [rev.slice(colon + 1)]);
      return { loc, args: ["show", "--no-ext-diff", "--no-textconv", "--stat", "--patch", rev] };
    }
    case "fetch": {
      // A worktree shares its repo's refs, so fetching there fetches the repo.
      const loc = location(policy, p, false);
      return { loc, args: ["fetch", "--no-recurse-submodules", "origin"] };
    }
    case "worktree_add": {
      const loc = repoDir(policy, p.repo);
      if (!p.name || !WORKTREE_NAME.test(p.name)) throw new GitError("name must match [a-z0-9][a-z0-9._-]*");
      if (!p.branch || !policy.git.pushBranchPattern.test(p.branch)) throw new GitError("branch must be a new feature/ or bugfix/ branch");
      const base = checkRev(p.base, "base");
      if (!base) throw new GitError("base is required, e.g. origin/main");
      const dest = join(worktreesRoot(policy), p.name);
      return { loc, args: ["worktree", "add", "--no-track", "-b", p.branch, "--", dest, base] };
    }
    case "add": {
      const loc = location(policy, p, true);
      const paths = checkPaths(policy, loc, p.paths);
      if (paths.length === 0) throw new GitError("add needs explicit paths");
      return { loc, args: ["add", "--", ...paths] };
    }
    case "commit": {
      const loc = location(policy, p, true);
      if (!p.subject) throw new GitError("commit needs subject");
      validateCommitMessage(policy, p.subject, p.body);
      const args = ["commit", "--no-verify", "-m", p.subject];
      if (p.body) args.push("-m", p.body);
      return { loc, args };
    }
    case "push": {
      const loc = location(policy, p, true);
      return { loc, args: ["push", "--set-upstream", "origin"] };
    }
    default: {
      const exhaustive: never = p.op;
      throw new GitError(`unsupported op ${String(exhaustive)}`);
    }
  }
}

export function compareUrl(remote: string, branch: string): string | undefined {
  const m = /^(?:git@([^:]+):|https:\/\/([^/]+)\/)(.+?)(?:\.git)?$/.exec(remote.trim());
  if (!m) return undefined;
  const host = m[1] ?? m[2];
  return `https://${host}/${m[3]}/compare/${branch}`;
}

export async function runGit(policy: Policy, runner: CommandRunner, p: GitParams, signal?: AbortSignal): Promise<string> {
  const { loc, args } = buildGitArgs(policy, p);
  const network = p.op === "fetch" || p.op === "push";
  // Only fetch and push see the ssh agent; every other git call and every other tool runs without it.
  const sshSock = network ? process.env.SSH_AUTH_SOCK : undefined;
  const env = childEnv({ home: policy.home, path: policy.childPath, extra: sshSock ? { SSH_AUTH_SOCK: sshSock } : undefined });
  const run = (argv: readonly string[]) =>
    runner({ command: policy.binaries.git, args: [...GIT_PREFIX, "-C", loc.dir, ...argv], env, timeoutMs: policy.limits.commandTimeoutSeconds * 1000, signal });

  let finalArgs = args;
  let compare: string | undefined;
  let remoteUrl: string | undefined;
  if (network) {
    const remote = await run(["remote", "get-url", "origin"]);
    remoteUrl = remote.stdout.trim();
    if (remote.code !== 0 || !policy.git.remotePattern.test(remoteUrl)) {
      throw new GitError(`refusing ${p.op}: origin '${remoteUrl || "unset"}' does not match ${policy.git.remotePattern.source}`);
    }
  }
  if (p.op === "push") {
    const head = await run(["symbolic-ref", "--short", "HEAD"]);
    const branch = head.stdout.trim();
    if (head.code !== 0 || !policy.git.pushBranchPattern.test(branch)) {
      throw new GitError(`refusing to push branch '${branch || "detached HEAD"}'; only feature/ or bugfix/ branches`);
    }
    finalArgs = [...args, `refs/heads/${branch}:refs/heads/${branch}`];
    compare = remoteUrl ? compareUrl(remoteUrl, branch) : undefined;
  }
  const result = await run(finalArgs);
  const out = truncateText(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim(), policy.limits.outputBytes);
  const header = `git ${finalArgs.join(" ")}  [${loc.label}]`;
  if (result.code !== 0) throw new GitError(`${header}\nexit ${result.code}\n${out.text}`);
  return `${header}\n${out.text}${out.truncated ? "\n[output truncated]" : ""}${compare ? `\ncompare: ${compare}` : ""}`;
}

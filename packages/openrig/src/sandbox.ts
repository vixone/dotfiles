// Sandboxed bash for seats. Every command runs under a macOS Seatbelt profile with a scratch HOME and a
// clean environment: no credential files, no keychain, no daemon or local sockets, writes only to the
// workspace, the scratch dir and (outside .git) the configured repos. No localhost port is open.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { childEnv } from "./runner.ts";
import type { Policy } from "./policy.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const SHELL = "/bin/bash";

/** Outer shell line. Command and profile travel in env vars, so nothing is re-quoted. */
export const WRAPPED_COMMAND = `exec ${SANDBOX_EXEC} -p "$DEVRIG_SB_PROFILE" ${SHELL} -c "$DEVRIG_SB_CMD"`;

export class SandboxError extends Error {
  override name = "SandboxError";
}

const quote = (text: string): string => {
  if (/[\0\n\r]/.test(text)) throw new SandboxError(`path contains control characters: ${JSON.stringify(text)}`);
  return `"${text.replace(/[\\"]/g, "\\$&")}"`;
};

/** Seatbelt matches resolved paths; a symlinked path would slip past an unresolved rule. */
function real(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

export interface SandboxLayout {
  /** Account home whose credential paths are denied. */
  readonly home: string;
  readonly scratch: string;
  readonly workspace: string;
  /** Repos bash may edit (not their .git). Empty means read-only repos. */
  readonly writableRepos: readonly string[];
  /** Extra paths denied for both read and write (control root, rig policy). */
  readonly denyPaths: readonly string[];
  /**
   * Extra writable directories by name prefix, for the seat shell only: powerline bash-mode deletes its own
   * command files from <TMPDIR>/powerline-bash-mode-*. Matched as a literal prefix plus one more path segment.
   */
  readonly writableDirPrefixes?: readonly string[];
}

const regexQuote = (text: string): string => {
  if (/[\0\n\r"]/.test(text)) throw new SandboxError(`path contains a quote or control character: ${JSON.stringify(text)}`);
  return text.replace(/[\\.^$*+?()[\]{}|]/g, "\\$&");
};

export function sandboxProfile(policy: Policy, layout: SandboxLayout): string {
  const b = policy.bash;
  const sub = (p: string): string => `(subpath ${quote(real(p))})`;
  const denied = [...b.denyHomePaths.map((p) => join(layout.home, p)), ...layout.denyPaths].map(sub);
  const writable = [layout.workspace, layout.scratch, ...layout.writableRepos].map(sub);
  const gitDirs = layout.writableRepos.map((r) => sub(join(r, ".git")));
  const lines = [
    "(version 1)",
    "(allow default)",
    // Writes: nowhere, then the allowlist, then never into a repo's .git (commits go through the git tool).
    "(deny file-write*)",
    `(allow file-write* ${writable.join(" ")} (subpath "/dev"))`,
    ...(layout.writableDirPrefixes ?? []).map((p) => `(allow file-write* (regex #"^${regexQuote(real(dirname(p)))}/${regexQuote(basename(p))}[^/]+(/|$)"))`),
    ...(gitDirs.length > 0 ? [`(deny file-write* ${gitDirs.join(" ")})`] : []),
    // macOS /usr/bin/diff spools pipe and <(...) input to a hardcoded /tmp//diff.XXXXXXXX and ignores TMPDIR.
    // SBPL regex has no {n} quantifier (it silently never matches), so the 8 template chars are spelled out.
    `(allow file-write* (regex #"^/private/tmp/diff\\.${"[A-Za-z0-9]".repeat(8)}$"))`,
    // Credentials and rig controls last, so no allow above can reopen them.
    `(deny file-read* file-write* ${denied.join(" ")})`,
    // No unix sockets (tmux, ssh-agent, wezterm, docker) except DNS; no localhost (OpenRig daemon, LLM proxy).
    "(deny network-outbound (remote unix-socket))",
    `(allow network-outbound (remote unix-socket ${b.allowUnixSockets.map((p) => `(path-literal ${quote(p)})`).join(" ")}))`,
    '(deny network-outbound (remote ip "localhost:*"))',
    `(deny mach-lookup ${b.denyMachServices.map((n) => `(global-name ${quote(n)})`).join(" ")})`,
    // Other processes' args and env can hold tokens.
    "(deny process-info* (target others))",
  ];
  return `${lines.join("\n")}\n`;
}

/** Creates the scratch HOME (with a git identity) and TMPDIR. Returns the scratch root. */
export function prepareScratch(root: string, gitIdentity: { name?: string; email?: string }): { scratch: string; home: string; tmp: string } {
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const ident = [gitIdentity.name ? `\tname = ${gitIdentity.name}` : "", gitIdentity.email ? `\temail = ${gitIdentity.email}` : ""].filter(Boolean);
  writeFileSync(join(home, ".gitconfig"), ident.length > 0 ? `[user]\n${ident.join("\n")}\n` : "", { mode: 0o600 });
  return { scratch: real(root), home: real(home), tmp: real(tmp) };
}

/** Full environment for the outer shell. Built from nothing; the seat's env never leaks in. */
export function sandboxEnv(policy: Policy, scratchHome: string, scratchTmp: string, profile: string, command: string): Record<string, string> {
  const base = childEnv({ home: scratchHome, path: policy.childPath });
  return {
    ...base,
    TMPDIR: scratchTmp,
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    KUBECONFIG: "/dev/null",
    DEVRIG_SB_PROFILE: profile,
    DEVRIG_SB_CMD: command,
  };
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The sandbox env as KEY=VALUE lines for bin/seat-shell/bash, without the command and profile variables (the
 * wrapper passes the profile as a file and runs an interactive shell). Throws on a value with a line break.
 */
export function shellEnvFile(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key === "DEVRIG_SB_PROFILE" || key === "DEVRIG_SB_CMD") continue;
    if (!ENV_NAME.test(key)) throw new SandboxError(`env name ${key} is not a plain name`);
    if (/[\0\n\r]/.test(value)) throw new SandboxError(`env ${key} contains a line break`);
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

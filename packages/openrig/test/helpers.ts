import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePolicy, type Policy } from "../src/policy.ts";
import type { CommandRequest, CommandResult, CommandRunner } from "../src/runner.ts";

export const RIG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export interface TestEnv {
  readonly dir: string;
  readonly home: string;
  readonly rigRoot: string;
  readonly policy: Policy;
  cleanup(): void;
}

/** All mutable paths belong to a temporary home and rig root. */
export function makeEnv(overrides: Record<string, unknown> = {}): TestEnv {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "devrig-test-")));
  const home = join(dir, "home");
  const rigRoot = join(dir, "rig");
  for (const d of [join(rigRoot, "workspace"), join(home, "sandbox", "sample"), join(home, ".aws")]) mkdirSync(d, { recursive: true });
  const raw: Record<string, unknown> = JSON.parse(readFileSync(join(RIG_ROOT, "policy", "safety.json"), "utf8"));
  const merged = {
    ...raw,
    repos: { sample: "~/sandbox/sample" },
    controlRoot: "~/.devrig/control",
    binaries: { git: "/fake/git", gh: "/fake/gh", rg: "/opt/homebrew/bin/rg", mx: "/fake/mx" },
    bash: { ...Object(raw.bash), writableRepos: ["sample"] },
    ...overrides,
  };
  try {
    const policy = parsePolicy(merged, rigRoot, home);
    return { dir, home, rigRoot, policy, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function ok(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr, timedOut: false, truncated: false };
}

export function recordingRunner(handler: (req: CommandRequest) => CommandResult | Promise<CommandResult>): CommandRunner & { calls: CommandRequest[] } {
  const calls: CommandRequest[] = [];
  const runner: CommandRunner = async (req) => { calls.push(req); return handler(req); };
  return Object.assign(runner, { calls });
}

export function policySnapshot(policy: unknown, rigRoot: string, home: string): string {
  const json = JSON.stringify(policy, (_k, v: unknown) => v instanceof RegExp ? `/${v.source}/${v.flags}` : v, 2);
  return `${json.split(rigRoot).join("<RIG>").split(home).join("<HOME>")}\n`;
}
export const GOLDEN_HOME = "/Users/golden";

// Automatic expert restarts. Each locked seat's extension writes its context use and whether it is running to
// <seat root>/context.json. The lead's extension (role.autoFresh) reads those files on a timer and runs
// `devrig fresh <member> [--blank]` for a seat past policy.context.warnTokens once it has been idle for
// idleSeconds. Without open queue rows the restart is --blank; otherwise the seat writes a handover first. The
// model never decides.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshMember } from "./fresh.ts";
import type { QueueRow } from "./pace.ts";
import { rigCliArgs, type Policy } from "./policy.ts";
import type { CommandRequest, CommandResult } from "./runner.ts";
import type { TeamCall } from "./team.ts";

export const CONTEXT_FILE = "context.json";

export interface ContextStatus {
  /** Pi's context estimate after the last settled run; null until the conversation has a usage figure. */
  readonly tokens: number | null;
  /** True from agent_start until agent_settled. */
  readonly running: boolean;
  /** When the seat last wrote the file (ISO). */
  readonly at: string;
  /** Pi conversation identity. Absent in status files written by older extensions. */
  readonly sessionId?: string;
  /** True once this conversation got the rig's wrap-up steer; the lead then waits only steeredIdleSeconds. */
  readonly steered?: boolean;
}

export type FreshMode = "handover" | "blank";
export type FreshPlan = { readonly wait: string } | { readonly mode: FreshMode };

/** Rows a --blank restart would lose; `devrig fresh --blank` refuses on the same set. */
const OPEN_ROWS = new Set(["in-progress", "blocked"]);
const QUEUE_OUTPUT_BYTES = 1024 * 1024;
/** Upper bound for one `devrig fresh`: the handover wait (DEVRIG_FRESH_TIMEOUT, 900 s) plus launch and priming. */
export const FRESH_TIMEOUT_MS = 20 * 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** <seat root>/context.json, next to the seat's sessions dir. */
export function contextStatusPath(sessionsDir: string): string {
  return join(dirname(sessionsDir), CONTEXT_FILE);
}

/** Atomic write, so the lead never reads half a file. */
export function writeContextStatus(file: string, status: ContextStatus): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status)}\n`);
  renameSync(tmp, file);
}

/** undefined for a missing or malformed file: the lead then leaves the seat alone. */
export function readContextStatus(file: string): ContextStatus | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(raw)) return undefined;
    const { tokens, running, at, sessionId, steered } = raw;
    if (tokens !== null && (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)) return undefined;
    if (typeof running !== "boolean" || typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim() === "")) return undefined;
    if (steered !== undefined && typeof steered !== "boolean") return undefined;
    return { tokens, running, at, ...(sessionId === undefined ? {} : { sessionId }), ...(steered === undefined ? {} : { steered }) };
  } catch {
    return undefined;
  }
}

/** Backoff belongs to the conversation that was checked, not to the seat forever. */
export class FreshRetries {
  private readonly holds = new Map<string, { readonly at: number; readonly sessionId: string | undefined }>();

  hold(seat: string, status: ContextStatus | undefined, at: number): void {
    this.holds.set(seat, { at, sessionId: status?.sessionId });
  }

  until(seat: string, status: ContextStatus | undefined): number {
    const held = this.holds.get(seat);
    if (held === undefined) return 0;
    // Missing identity is not proof of replacement. In particular, compaction can also lower the token count.
    if (held.sessionId !== undefined && status?.sessionId !== undefined && held.sessionId !== status.sessionId) {
      this.holds.delete(seat);
      return 0;
    }
    return held.at;
  }

  /** Only clears backoff. The caller must still check running, idle duration and queue rows. */
  reset(seats: readonly string[]): void {
    for (const seat of seats) this.holds.delete(seat);
  }
}

type AutoFreshCommand =
  | { readonly kind: "show" }
  | { readonly kind: "pause"; readonly paused: boolean }
  | { readonly kind: "retry"; readonly seats: readonly string[] };

/** Resolve command targets only within this lead's auto-managed seats. */
export function parseAutoFreshCommand(args: string, seats: readonly string[]): AutoFreshCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "show" };
  const [command, target] = parts;
  if (parts.length === 1 && (command === "on" || command === "off")) return { kind: "pause", paused: command === "off" };
  if (command === "retry" && parts.length <= 2) {
    if (target === undefined) return { kind: "retry", seats };
    const seat = seats.find((s) => s === target || s.split("@")[0] === target || freshMember(s) === target);
    if (seat === undefined) throw new Error(`not an auto-managed seat: ${target}; choose ${seats.join(", ")}`);
    return { kind: "retry", seats: [seat] };
  }
  throw new Error("usage: /autofresh [on|off|retry [seat]]");
}

export interface PlanInput {
  readonly seat: string;
  readonly status: ContextStatus | undefined;
  readonly now: Date;
  readonly warnTokens: number;
  readonly idleMs: number;
  /** The idle wait once the seat got the wrap-up steer; idleMs when unset. */
  readonly steeredIdleMs?: number;
}

/**
 * Whether the seat should restart now, before looking at its queue. A wait carries the reason for the lead's
 * footer. Pure.
 */
export function freshDue(p: PlanInput): { readonly wait: string } | undefined {
  const s = p.status;
  if (s === undefined) return { wait: "no context figure" };
  if (s.tokens === null || s.tokens <= p.warnTokens) return { wait: "under budget" };
  if (s.running) return { wait: "running" };
  const idle = p.now.getTime() - Date.parse(s.at);
  // Waits stay short: the footer joins every extension status into one segment and drops it whole when it does not fit.
  if (idle < idleWaitMs(s, p.idleMs, p.steeredIdleMs)) return { wait: `idle ${Math.max(0, Math.round(idle / 1000))}s` };
  return undefined;
}

function idleWaitMs(s: ContextStatus, idleMs: number, steeredIdleMs: number | undefined): number {
  return s.steered === true && steeredIdleMs !== undefined ? steeredIdleMs : idleMs;
}

/** Milliseconds until a settled seat has been idle long enough (0 when it has); undefined while running or unknown. */
export function idleRemainingMs(s: ContextStatus | undefined, now: Date, idleMs: number, steeredIdleMs: number | undefined): number | undefined {
  if (s === undefined || s.running) return undefined;
  return Math.max(0, idleWaitMs(s, idleMs, steeredIdleMs) - (now.getTime() - Date.parse(s.at)));
}

/** handover while the seat holds in-progress or blocked rows, blank otherwise. */
export function freshMode(seat: string, rows: readonly QueueRow[]): FreshMode {
  return rows.some((r) => r.destinationSession === seat && OPEN_ROWS.has(r.state)) ? "handover" : "blank";
}

export function freshPlan(p: PlanInput, rows: readonly QueueRow[]): FreshPlan {
  return freshDue(p) ?? { mode: freshMode(p.seat, rows) };
}

/** The seat's in-progress and blocked rows, the same query `devrig fresh --blank` checks. */
export function openRowsCall(seat: string): TeamCall {
  return { args: ["queue", "list", `--destination=${seat}`, "--state=in-progress,blocked", "--json"], maxOutputBytes: QUEUE_OUTPUT_BYTES };
}

/** `devrig fresh <member> [--blank]`. The script builds its own private env, so this passes only the basics. */
export function freshRequest(policy: Policy, seat: string, mode: FreshMode, env: NodeJS.ProcessEnv): CommandRequest {
  const keep: Record<string, string> = { HOME: policy.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
  for (const k of ["USER", "LOGNAME", "TMPDIR", "TERM"]) {
    const v = env[k];
    if (v !== undefined) keep[k] = v;
  }
  return {
    command: join(policy.rigRoot, "bin", "devrig"),
    args: [...rigCliArgs(policy), "fresh", freshMember(seat), ...(mode === "blank" ? ["--blank"] : [])],
    env: keep,
    timeoutMs: FRESH_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
  };
}

/** The `devrig fresh` command line for a seat, as the operator types it. */
export function freshHint(policy: Policy, seat: string, flags = ""): string {
  return ["devrig", ...rigCliArgs(policy), "fresh", freshMember(seat), ...(flags ? [flags] : [])].join(" ");
}

/** One footer entry: `expert1 162k` and, when waiting past budget, why. */
export function footerEntry(seat: string, status: ContextStatus | undefined, note: string | undefined): string {
  const k = status?.tokens == null ? "?" : `${Math.round(status.tokens / 1000)}k`;
  return `${freshMember(seat)} ${k}${note ? ` (${note})` : ""}`;
}

/** undefined when `devrig fresh` succeeded; else why, with the last lines it printed. */
export function freshFailure(r: CommandResult): string | undefined {
  if (r.code === 0 && !r.timedOut) return undefined;
  const tail = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(-3).join("\n");
  return `${r.timedOut ? "timed out" : `exit ${r.code}`}: ${tail || "no output"}`;
}

/**
 * Which wrap-up steer a running seat is due after a turn that ran tools: 1 past warnTokens, 2 past
 * steerAgainTokens, each once (sent is the highest already sent), 0 for none. Pure.
 */
export function steerDue(tokens: number | null | undefined, sent: number, p: { readonly warnTokens: number; readonly steerAgainTokens: number }): 0 | 1 | 2 {
  if (tokens == null) return 0;
  const level = tokens > p.steerAgainTokens ? 2 : tokens > p.warnTokens ? 1 : 0;
  return level > sent ? level : 0;
}

/** The steer the rig adds to a running seat's context. */
export function steerText(level: 1 | 2, tokens: number, p: { readonly warnTokens: number; readonly hardCompactTokens: number }): string {
  const k = (n: number): string => `${Math.round(n / 1000)}k`;
  if (level === 1) {
    return (
      `[rig] Your context is at ${k(tokens)}, past the ${k(p.warnTokens)} budget. Finish the step you are on, write where you are ` +
      `in your queue item (team queue_update note: done, next, any check still owed), then end your turn. ` +
      `Start no new reads or checks. The rig restarts this seat on a fresh conversation once it is idle, and your open rows carry over.`
    );
  }
  return (
    `[rig] Your context is at ${k(tokens)}; Pi compacts it at ${k(p.hardCompactTokens)} and loses detail. Stop now: write your ` +
    `queue_update note and end this turn.`
  );
}

/** The `[task] ` prefix team queue_create stamps on a row's summary (src/team.ts taskSummary). */
const TASK_PREFIX = /^\[([a-z][a-z0-9-]{0,40}(?:\.[0-9]{1,5}){0,5})\] /;

/** The work unit a row's summary names, if any. */
export function rowTask(summary: string | undefined): string | undefined {
  return summary === undefined ? undefined : TASK_PREFIX.exec(summary)?.[1];
}

/** The seat's rows with closed history, newest first, for its last task and open rows. */
export function assignRowsCall(seat: string): TeamCall {
  return { args: ["queue", "list", `--destination=${seat}`, "--all", "--limit=100", "--json"], maxOutputBytes: QUEUE_OUTPUT_BYTES };
}

export interface AssignGateDeps {
  readonly seat: string;
  /** The new row's task: an mx task or slice id, or `ask`. */
  readonly task: string;
  readonly blankTokens: number;
  readonly idleMs: number;
  /** /autofresh off pauses this gate too. */
  readonly paused: boolean;
  readonly restarting: () => boolean;
  readonly now: () => Date;
  /** Read again after the queue call, so a turn that started meanwhile wins. */
  readonly status: () => ContextStatus | undefined;
  readonly rows: () => Promise<readonly QueueRow[]>;
  /** `devrig fresh <member> --blank`: undefined on success, else why it failed. */
  readonly blank: () => Promise<string | undefined>;
}

const kTokens = (n: number): string => `${Math.floor(n / 1000)}k`;

/** Why the cheap, file-only checks keep the seat's context; undefined when they pass. */
function assignWait(status: ContextStatus | undefined, now: Date, blankTokens: number, idleMs: number): string | undefined {
  if (status === undefined || status.tokens === null) return "no context figure";
  if (status.tokens < blankTokens) return `${kTokens(status.tokens)} < ${kTokens(blankTokens)}`;
  if (status.running) return "running";
  const idle = now.getTime() - Date.parse(status.at);
  if (idle < idleMs) return `idle ${Math.max(0, Math.round(idle / 1000))}s`;
  return undefined;
}

/**
 * Before the lead's queue_create to an auto-managed expert: restart it blank when it sits idle at blankTokens or
 * more, holds no in-progress or blocked rows, and the new task differs from the task of its
 * newest keyed row. `ask` always counts as different work. Returns the one line the lead sees; never throws, so the
 * row is created either way. The model never decides.
 */
export async function assignGate(d: AssignGateDeps): Promise<string> {
  const keep = (why: string): string => `kept context: ${why}`;
  if (d.paused) return keep("autofresh off");
  if (d.restarting()) return keep("already restarting");
  const early = assignWait(d.status(), d.now(), d.blankTokens, d.idleMs);
  if (early !== undefined) return keep(early);
  let rows: readonly QueueRow[];
  try {
    rows = (await d.rows()).filter((r) => r.destinationSession === d.seat);
  } catch (error) {
    return keep(`queue check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const last = [...rows]
    .filter((r) => rowTask(r.summary) !== undefined)
    .sort((a, b) => Date.parse(b.tsCreated) - Date.parse(a.tsCreated))[0];
  const lastTask = rowTask(last?.summary);
  if (d.task !== "ask" && lastTask === d.task) return keep(`same task ${d.task}`);
  const open = rows.filter((r) => OPEN_ROWS.has(r.state));
  if (open.length > 0) return keep(`open rows ${open.map((r) => r.qitemId).join(", ")}`);
  if (d.restarting()) return keep("already restarting");
  const status = d.status();
  const again = assignWait(status, d.now(), d.blankTokens, d.idleMs);
  if (again !== undefined) return keep(again);
  let failure: string | undefined;
  try {
    failure = await d.blank();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure !== undefined) return `blank reset failed, context may be kept: ${failure}`;
  return `blanked first: ${kTokens(status?.tokens ?? 0)} tokens, last task ${lastTask ?? "none"}`;
}

// The team tool: a fixed slice of the rig CLI for seat-to-seat work. Seats never get the CLI itself,
// because the daemon API can launch new seats outside the sandbox. This module builds the exact argv for
// a few send and queue verbs, only towards other seats of this rig, and runs the repo-local CLI.
import { join } from "node:path";
import type { Policy, Role, TeamOp } from "./policy.ts";
import type { CommandRunner } from "./runner.ts";

export class TeamError extends Error {
  override name = "TeamError";
}

// "unchanged" and "none" lead their enums: models that fill every field pick the first value, which must be a no-op.
export type QueueState = "unchanged" | "in-progress" | "done" | "failed";
export type ClosureReason = "none" | "no-follow-on" | "canceled" | "denied";

export interface TeamParams {
  readonly op: TeamOp;
  readonly to?: string;
  readonly text?: string;
  readonly urgent?: boolean;
  readonly id?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly mission?: string;
  /** queue_create: the work unit, an mx task or slice id or `ask`, stamped as a `[task] ` summary prefix. */
  readonly task?: string;
  readonly note?: string;
  readonly state?: QueueState;
  readonly closureReason?: ClosureReason;
  readonly resolution?: string;
  readonly all?: boolean;
  readonly mine?: boolean;
  readonly full?: boolean;
}

export interface TeamSeat {
  /** This seat's OpenRig session name; the CLI stamps it on every request as the sender. */
  readonly name: string;
  readonly role: Role;
  readonly url: string;
}

export interface TeamCall {
  readonly args: string[];
  readonly stdin?: string;
  readonly cwd?: string;
  /** Output cap for a rig-side call that parses the JSON; seat calls keep policy.limits.outputBytes. */
  readonly maxOutputBytes?: number;
}

const QITEM_ID = /^qitem-[A-Za-z0-9-]{1,80}$/;
const MISSION_ID = /^[a-z][a-z0-9-]{0,40}(\.[0-9]{1,5}){0,5}$/;
/** A row's work unit: an mx task or OpenRig slice id, or `ask` for a quick operator ask. */
export const TASK_ID = MISSION_ID;
const DAEMON_URL = /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/;
export const TEAM_LIMITS = { text: 32 * 1024, summary: 300 } as const;
const MAX_TEXT = TEAM_LIMITS.text;
const MAX_SUMMARY = TEAM_LIMITS.summary;
const TIMEOUT_MS = 60_000;
// Text lands in another seat's terminal. Escape and other control bytes could act as keystrokes there.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/;
const STATES: readonly QueueState[] = ["in-progress", "done", "failed"];
const REASONS: readonly ClosureReason[] = ["no-follow-on", "canceled", "denied"];

/** The daemon URL from the seat env. Only the loopback daemon; the default port when unset. */
export function teamUrl(env: NodeJS.ProcessEnv): string {
  const url = env.OPENRIG_URL ?? "http://127.0.0.1:7433";
  if (!DAEMON_URL.test(url)) throw new TeamError(`OPENRIG_URL ${url} is not the loopback rig daemon`);
  return url;
}

export function teammates(policy: Policy, self: string): string[] {
  return Object.keys(policy.rig.seats).filter((s) => s !== self);
}

/** The seats this seat may send to or queue for: its teammates, narrowed by the role's teamTo. */
export function reachable(policy: Policy, seat: Pick<TeamSeat, "name" | "role">): string[] {
  const to = seat.role.teamTo;
  return teammates(policy, seat.name).filter((s) => to === undefined || to.includes(s));
}

function need<T>(value: T | undefined, what: string, op: string): T {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) throw new TeamError(`${op} needs ${what}`);
  return value;
}

function text(value: string, what: string, max = MAX_TEXT): string {
  if (CONTROL.test(value)) throw new TeamError(`${what} contains control characters`);
  if (Buffer.byteLength(value) > max) throw new TeamError(`${what} is longer than ${max} bytes`);
  return value;
}

function line(value: string, what: string): string {
  if (/[\n\r]/.test(value)) throw new TeamError(`${what} must be one line`);
  return text(value, what, MAX_SUMMARY);
}

/** A handoff summary from the note's first non-blank line, cut to the summary limit. Seats often write the result only in note. */
export function summaryFromNote(note: string | undefined): string | undefined {
  const first = note?.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  if (first === undefined) return undefined;
  let out = "";
  for (const ch of first) {
    if (Buffer.byteLength(out + ch) > MAX_SUMMARY) break;
    out += ch;
  }
  return out;
}

function qitem(value: string | undefined, op: string): string {
  const id = need(value, "id", op);
  if (!QITEM_ID.test(id)) throw new TeamError(`${id} is not a qitem id`);
  return id;
}


/**
 * The queue_create summary with its `[task] ` prefix. A row to a seat the role auto-refreshes needs a task: the
 * rig compares it with the seat's last row before it restarts the seat blank (src/autofresh.ts assignGate).
 */
function taskSummary(seat: TeamSeat, to: string, p: TeamParams): string {
  const summary = need(p.summary, "summary", p.op);
  if (p.task === undefined || p.task.trim() === "") {
    if (seat.role.autoFresh?.seats.includes(to)) throw new TeamError(`queue_create to ${to} needs task: the mx task or slice id this row belongs to, or ask for a quick operator ask`);
    return summary;
  }
  if (!TASK_ID.test(p.task)) throw new TeamError(`${p.task} is not a task id: use an mx task or slice id, or ask`);
  const prefix = `[${p.task}] `;
  return summary.startsWith(prefix) ? summary : `${prefix}${summary}`;
}

/**
 * The exact CLI call for one team op. Pure; every value goes in as `--flag=value` or after `--`.
 * Fields the op does not use are ignored: models fill every field of a multi-op schema.
 */
export function teamCall(policy: Policy, seat: TeamSeat, raw: TeamParams): TeamCall {
  const p: TeamParams = { ...raw, state: raw.state === "unchanged" ? undefined : raw.state, closureReason: raw.closureReason === "none" ? undefined : raw.closureReason };
  if (!seat.role.teamOps.includes(p.op)) throw new TeamError(`role ${seat.role.name} may not use team ${p.op}`);
  const dest = (): string => {
    const to = need(p.to, "to", p.op);
    if (!reachable(policy, seat).includes(to)) {
      const why = teammates(policy, seat.name).includes(to) ? `role ${seat.role.name} may not reach ${to}` : `${to} is not another seat of this rig`;
      throw new TeamError(`${why}; use one of ${reachable(policy, seat).join(", ")}`);
    }
    return to;
  };
  switch (p.op) {
    case "send": {
      const to = dest();
      const body = text(need(p.text, "text", p.op), "text");
      return { args: ["send", "--json", ...(p.urgent ? ["--urgent"] : []), "--", to, body] };
    }
    case "queue_create": {
      const to = dest();
      const args = ["queue", "create", `--destination=${to}`, `--summary=${line(taskSummary(seat, to, p), "summary")}`, "--body-file=-", "--json"];
      if (p.mission !== undefined) {
        if (!MISSION_ID.test(p.mission)) throw new TeamError(`${p.mission} is not an mx id`);
        args.push(`--mission=${p.mission}`);
      }
      return { args, stdin: text(need(p.body, "body", p.op), "body"), maxOutputBytes: QUEUE_LIST_BYTES };
    }
    case "queue_claim":
      return { args: ["queue", "claim", qitem(p.id, p.op), "--json"], maxOutputBytes: QUEUE_LIST_BYTES };
    case "queue_update": {
      const args = ["queue", "update", qitem(p.id, p.op)];
      if (p.note !== undefined) args.push(`--note=${text(p.note, "note")}`);
      if (p.state !== undefined) {
        if (!STATES.includes(p.state)) throw new TeamError(`state ${p.state} is not allowed`);
        args.push(`--state=${p.state}`);
      }
      if ((p.state === "done") !== (p.closureReason !== undefined)) throw new TeamError("state done needs closureReason, and closureReason needs state done");
      if (p.closureReason !== undefined) {
        if (!REASONS.includes(p.closureReason)) throw new TeamError(`closureReason ${p.closureReason} is not allowed`);
        args.push(`--closure-reason=${p.closureReason}`);
      }
      if (p.resolution !== undefined) {
        if (p.state !== "done" && p.state !== "failed") throw new TeamError("resolution needs state done or failed");
        args.push(`--resolution=${text(p.resolution, "resolution")}`);
      }
      if (args.length === 3) throw new TeamError("queue_update needs a note or a state");
      return { args: [...args, "--json"], maxOutputBytes: QUEUE_LIST_BYTES };
    }
    case "queue_handoff_complete": {
      const args = ["queue", "handoff-and-complete", qitem(p.id, p.op), `--to=${dest()}`, `--summary=${line(need(p.summary ?? summaryFromNote(p.note), "summary or note", p.op), "summary")}`];
      if (p.note !== undefined) args.push(`--note=${text(p.note, "note")}`);
      if (p.body === undefined) return { args: [...args, "--json"], maxOutputBytes: QUEUE_LIST_BYTES };
      return { args: [...args, "--body-file=-", "--json"], stdin: text(p.body, "body"), maxOutputBytes: QUEUE_LIST_BYTES };
    }
    case "queue_list":
      // runTeam turns the JSON into one line per item, so the cap here is for parsing, not for the model.
      return {
        args: ["queue", "list", "--json", ...(p.all ? ["--all", `--limit=${QUEUE_LIST_ALL}`] : []), ...(p.mine ? ["--mine"] : [])],
        maxOutputBytes: QUEUE_LIST_BYTES,
      };
    case "queue_show":
      return { args: ["queue", "show", qitem(p.id, p.op), ...(p.full ? ["--full"] : []), "--json"], maxOutputBytes: QUEUE_LIST_BYTES };
    case "whoami":
      return { args: ["queue", "whoami", "--json"] };
  }
}

/** Runs one team op through the repo-local rig CLI with the rig's private env and this seat's identity. */
export async function runTeam(policy: Policy, runner: CommandRunner, seat: TeamSeat, p: TeamParams, signal?: AbortSignal): Promise<string> {
  const call = teamCall(policy, seat, p);
  const out = await runRigCli(policy, runner, seat, call, signal);
  if (p.op === "queue_list") return compactQueueList(out, p.all === true);
  const reply = compactQueueReply(p.op, out);
  // The cap was raised so the JSON parses whole; what the model sees still keeps the seat limit.
  return call.maxOutputBytes === undefined || Buffer.byteLength(reply) <= policy.limits.outputBytes ? reply : `${reply.slice(0, policy.limits.outputBytes)}\n[output truncated]`;
}

/** Row fields that only steer the daemon's nudges and backstdev. */
const ROW_NOISE = new Set(["lastNudgeAttempt", "lastNudgeResult", "lastNudgeWireResult", "lastHeartbeat", "readView", "ownerNotificationLevel", "destinationClass"]);
/** Ops whose reply echoes a body the seat already has: it just wrote it, or it was handed over before. */
const ECHOED_BODY = new Set<TeamOp>(["queue_create", "queue_update", "queue_handoff_complete"]);

/**
 * One queue row without the daemon's nudge metadata, empty fields and, when the seat already has it, the body.
 * pickup and waiting collapse to their state. Pure.
 */
export function compactRow(row: Record<string, unknown>, keepBody: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (ROW_NOISE.has(k) || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (k === "body" && !keepBody) {
      if (typeof v === "string") out.bodyBytes = Buffer.byteLength(v);
      continue;
    }
    if ((k === "pickup" || k === "waiting") && typeof v === "object" && !Array.isArray(v)) {
      const w = v as Record<string, unknown>;
      if (typeof w.state === "string") out[k] = w.state;
      if (k === "waiting" && w.blocker !== null && w.blocker !== undefined) out.blocker = w.blocker;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * claim, show, create, update and handoff replies as compact JSON: about 1 KB of metadata per row went out with
 * every call, and create, update and handoff repeated the whole body (team was 17-26% of an expert's tool output on
 * 2026-11-11). Output that is not the expected JSON is returned unchanged. Pure.
 */
export function compactQueueReply(op: TeamOp, stdout: string): string {
  if (!["queue_claim", "queue_show", ...ECHOED_BODY].includes(op)) return stdout;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!rec(raw)) return stdout;
  const keep = !ECHOED_BODY.has(op);
  if (op === "queue_handoff_complete") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = rec(v) ? compactRow(v, false) : v;
    return JSON.stringify(out);
  }
  return typeof raw.qitemId === "string" ? JSON.stringify(compactRow(raw, keep)) : stdout;
}

/** queue_list with all shows this many of the newest items. */
export const QUEUE_LIST_ALL = 30;
const QUEUE_LIST_BYTES = 1024 * 1024;

/**
 * One line per queue item from `rig queue list --json`: id, state, from -> to, last update, summary, and blockedOn,
 * handedOffTo or closureReason when set. The raw rows carry about 1 KB of nudge and pickup metadata each. Output that
 * is not a JSON list (a truncated or changed CLI reply) is returned unchanged. Pure.
 */
export function compactQueueList(stdout: string, all: boolean): string {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const list = Array.isArray(raw) ? raw : rec(raw) && Array.isArray(raw.items) ? raw.items : undefined;
  if (list === undefined) return stdout;
  const s = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const lines = list.filter(rec).map((r) => {
    const updated = s(r.tsUpdated);
    const parts = [
      s(r.qitemId) ?? "?",
      s(r.state) ?? "?",
      `${s(r.sourceSession) ?? "?"} -> ${s(r.destinationSession) ?? "?"}`,
      updated ? `${updated.slice(5, 10)} ${updated.slice(11, 16)}Z` : "?",
      s(r.summary) ?? "",
    ];
    if (s(r.blockedOn)) parts.push(`blocked on: ${s(r.blockedOn)}`);
    if (s(r.handedOffTo)) parts.push(`handed to: ${s(r.handedOffTo)}`);
    if (s(r.closureReason)) parts.push(`closure: ${s(r.closureReason)}`);
    return parts.join(" | ");
  });
  if (lines.length === 0) return all ? "no queue items" : "no open queue items";
  const head = `${lines.length} item(s)${all ? `, newest ${QUEUE_LIST_ALL} at most` : ""}. id | state | from -> to | updated | summary. queue_show id for the body.`;
  return [head, ...lines].join("\n");
}

/** Runs one prepared call through the repo-local rig CLI with the rig's private env and this seat's identity. */
export async function runRigCli(policy: Policy, runner: CommandRunner, seat: TeamSeat, call: TeamCall, signal?: AbortSignal): Promise<string> {
  const state = join(policy.home, ".devrig");
  const result = await runner({
    command: join(policy.rigRoot, ".runtime", "node", "node_modules", "node", "bin", "node"),
    args: [join(policy.rigRoot, ".runtime", "openrig", "node_modules", "@openrig", "cli", "dist", "bin-wrapper.js"), ...call.args],
    env: {
      HOME: join(state, "daemon-home"),
      OPENRIG_HOME: join(state, "openrig-home"),
      OPENRIG_URL: seat.url,
      OPENRIG_SESSION_NAME: seat.name,
      OPENRIG_NO_KERNEL: "1",
      TMUX_TMPDIR: join(state, "tmux"),
      PATH: policy.childPath,
      LANG: "en_US.UTF-8",
      NO_COLOR: "1",
    },
    stdin: call.stdin,
    cwd: call.cwd,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: call.maxOutputBytes ?? policy.limits.outputBytes,
    signal,
  });
  const out = result.stdout.trim();
  if (result.timedOut) throw new TeamError(`rig ${call.args.slice(0, 2).join(" ")} timed out`);
  if (result.code !== 0 && call.args[0] === "send" && /target_needs_input/.test(`${out}\n${result.stderr}`)) {
    throw new TeamError(
      "not delivered: the target seat is waiting on the operator (a prompt is open). If you already handed off a queue item, the lead sees it in its queue; do not resend. Otherwise retry later or use a queue item.",
    );
  }
  if (result.code !== 0) throw new TeamError(`rig ${call.args.slice(0, 2).join(" ")} failed (exit ${result.code}): ${(result.stderr.trim() || out).slice(-2000)}`);
  return `${out}${result.truncated ? "\n[output truncated]" : ""}` || "ok";
}

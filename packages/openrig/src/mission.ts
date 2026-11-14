// The mission tool: a fixed slice of the mx CLI so seats can read mission state and the lead can record it.
// mx runs outside the bash sandbox against the operator's store (policy.mission.db). Reads are for every
// role; writes are whatever the role's missionOps allow (the lead only, by default).
import type { MissionOp, Policy, Role } from "./policy.ts";
import type { CommandRunner } from "./runner.ts";
import { childEnv } from "./runner.ts";

export class MissionError extends Error {
  override name = "MissionError";
}

export type IssueType = "task" | "decision" | "bug" | "feature";
export const ISSUE_TYPES: readonly IssueType[] = ["task", "decision", "bug", "feature"];

export interface MissionParams {
  readonly op: MissionOp;
  readonly id?: string;
  readonly comments?: boolean;
  readonly text?: string;
  readonly title?: string;
  readonly type?: IssueType;
  readonly priority?: number;
}

export interface MissionCall {
  readonly args: string[];
  readonly stdin?: string;
}

const ID = /^[a-z][a-z0-9-]{0,40}(\.[0-9]{1,5}){0,5}$/;
const MAX_TEXT = 32 * 1024;
export const MISSION_TITLE_MAX = 200;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const SNAPSHOT = "## Context Snapshot";
const TIMEOUT_MS = 30_000;

function need(value: string | undefined, what: string, op: string): string {
  if (value === undefined || value.trim() === "") throw new MissionError(`${op} needs ${what}`);
  return value;
}

function id(value: string | undefined, op: string): string {
  const v = need(value, "id", op);
  if (!ID.test(v)) throw new MissionError(`${v} is not an mx id`);
  return v;
}

function text(value: string | undefined, what: string, op: string): string {
  const v = need(value, what, op);
  if (CONTROL.test(v)) throw new MissionError(`${what} contains control characters`);
  if (Buffer.byteLength(v) > MAX_TEXT) throw new MissionError(`${what} is longer than ${MAX_TEXT} bytes`);
  return v;
}


/** The mx calls for one op (brief takes three). Pure; values go in as `--flag=value` or on stdin. Unused fields are ignored. */
export function missionCalls(role: Role, p: MissionParams): MissionCall[] {
  if (!role.missionOps.includes(p.op)) throw new MissionError(`role ${role.name} may not use mission ${p.op}`);
  switch (p.op) {
    case "brief": {
      const m = id(p.id, p.op);
      return [{ args: ["show", "--json", m] }, { args: ["children", "--json", m] }, { args: ["ready", "--json", `--parent=${m}`] }];
    }
    case "show":
      return [{ args: ["show", ...(p.comments ? ["--include-comments"] : []), id(p.id, p.op)] }];
    case "children":
      return [{ args: ["children", id(p.id, p.op)] }];
    case "ready":
      return [{ args: ["ready", "--limit=50", ...(p.id !== undefined ? [`--parent=${id(p.id, p.op)}`] : [])] }];
    case "note":
    case "comment":
      return [{ args: [p.op, id(p.id, p.op), "--stdin"], stdin: text(p.text, "text", p.op) }];
    case "create": {
      const title = text(p.title, "title", p.op);
      if (/[\n\r]/.test(title) || title.length > MISSION_TITLE_MAX) throw new MissionError(`title must be one line of at most ${MISSION_TITLE_MAX} characters`);
      const type = p.type ?? "task";
      if (!ISSUE_TYPES.includes(type)) throw new MissionError(`type ${type} is not allowed`);
      const priority = p.priority ?? 2;
      if (!Number.isInteger(priority) || priority < 0 || priority > 4) throw new MissionError("priority must be 0-4");
      return [
        {
          args: ["create", `--parent=${id(p.id, p.op)}`, `--title=${title}`, `--type=${type}`, `--priority=${priority}`, "--stdin", "--silent"],
          stdin: text(p.text, "text (the description)", p.op),
        },
      ];
    }
    case "close":
      return [{ args: ["close", id(p.id, p.op), "--reason-file=-"], stdin: text(p.text, "text (the reason with its evidence)", p.op) }];
  }
}

type Json = Record<string, unknown>;

function rows(raw: string): Json[] {
  const v: unknown = JSON.parse(raw);
  const list = Array.isArray(v) ? v : [v];
  return list.filter((r): r is Json => typeof r === "object" && r !== null && !Array.isArray(r));
}

const s = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const row = (r: Json): string => `- ${s(r.id)} [${s(r.status)}] ${s(r.title)}`;

/** The latest Context Snapshot section of the notes, or undefined. */
export function latestSnapshot(notes: string): string | undefined {
  const at = notes.lastIndexOf(SNAPSHOT);
  return at < 0 ? undefined : notes.slice(at).trim();
}

/** Header, latest snapshot, open children and ready work from the three brief calls' JSON. */
export function renderBrief(show: string, children: string, ready: string, maxBytes: number): string {
  const m = rows(show)[0];
  if (!m) throw new MissionError("mx show returned nothing");
  const description = s(m.description).trim();
  const snapshot = latestSnapshot(s(m.notes));
  const open = rows(children).filter((r) => r.status !== "closed");
  const readyRows = rows(ready);
  const parts = [
    `${s(m.id)} [${s(m.status)}] ${s(m.title)} (${s(m.issue_type)}, P${s(m.priority)})`,
    description ? `\nDescription:\n${description.slice(0, 2000)}${description.length > 2000 ? "\n[cut]" : ""}` : "",
    `\nOpen children (${open.length}):\n${open.map(row).join("\n") || "(none)"}`,
    `\nReady under ${s(m.id)} (${readyRows.length}):\n${readyRows.map(row).join("\n") || "(none)"}`,
    `\nLatest context snapshot:\n${snapshot ?? "(none)"}`,
  ];
  const out = parts.filter(Boolean).join("\n");
  return Buffer.byteLength(out) > maxBytes ? `${Buffer.from(out).subarray(0, maxBytes).toString("utf8")}\n[cut at ${maxBytes} bytes]` : out;
}

export async function runMission(policy: Policy, runner: CommandRunner, role: Role, p: MissionParams, signal?: AbortSignal): Promise<string> {
  const calls = missionCalls(role, p);
  const outputs: string[] = [];
  for (const call of calls) {
    const result = await runner({
      command: policy.binaries.mx,
      args: call.args,
      env: childEnv({ home: policy.home, path: policy.childPath, extra: { MX_DB: policy.mission.db, NO_COLOR: "1" } }),
      stdin: call.stdin,
      timeoutMs: TIMEOUT_MS,
      // Brief parses JSON, which a cut would break; renderBrief applies the output limit instead.
      maxOutputBytes: p.op === "brief" ? undefined : policy.limits.outputBytes,
      signal,
    });
    if (result.timedOut) throw new MissionError(`mx ${call.args[0]} timed out`);
    if (result.code !== 0) throw new MissionError(`mx ${call.args[0]} failed (exit ${result.code}): ${(result.stderr.trim() || result.stdout.trim()).slice(-2000)}`);
    outputs.push(result.stdout);
  }
  if (p.op === "brief") return renderBrief(outputs[0] ?? "", outputs[1] ?? "", outputs[2] ?? "", policy.limits.outputBytes);
  return outputs[0]?.trim() || "ok";
}

// The scope tool: OpenRig's project tree (missions, slices, progress rails, plan-lock) through a fixed slice
// of `rig scope`, always pinned to the rig's project root. Delivery approval is not an op: the operator signs
// it off from their own shell. A scope stamp records workflow state, not permission to merge or deploy.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Policy, ScopeOp } from "./policy.ts";
import type { CommandRunner } from "./runner.ts";
import { runRigCli, type TeamCall, type TeamSeat } from "./team.ts";

export class ScopeError extends Error {
  override name = "ScopeError";
}

export type RailStatus = "active" | "done" | "blocked";
export type SliceState = "active" | "closed" | "shipped" | "all";
// `rig scope slice close` is for slices that will not be delivered, and OpenRig requires one of these reasons.
// A delivered slice stays open: its rail rows go done and the operator stamps `slice approve --scope delivery`.
export type CloseReason = "wontfix" | "deferred" | "superseded" | "stale";

export interface ScopeParams {
  readonly op: ScopeOp;
  readonly mission?: string;
  readonly slice?: string;
  readonly name?: string;
  readonly title?: string;
  readonly intent?: string;
  readonly add?: string;
  readonly set?: string;
  readonly status?: RailStatus;
  readonly section?: string;
  readonly state?: SliceState;
  readonly reason?: CloseReason;
  readonly note?: string;
  readonly lockedArtifacts?: readonly string[];
  /** *_approve_spec: supersede an existing SPEC stamp (`--re-approve`); needs reApproveReason. */
  readonly reApprove?: boolean;
  readonly reApproveReason?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
// A slice is NN-slug, or mission/NN-slug style paths the CLI prints. Never absolute, never upwards.
const SLICE = /^[a-z0-9][a-z0-9._-]{0,80}(\/[a-z0-9][a-z0-9._-]{0,80}){0,4}$/;
const ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}){0,4}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** One-line field limits; the tool schema shows the same numbers. */
export const SCOPE_LIMITS = { line: 500, name: 61, section: 80, title: 120, note: 2000 } as const;
const STATUSES: readonly RailStatus[] = ["active", "done", "blocked"];
const STATES: readonly SliceState[] = ["active", "closed", "shipped", "all"];
export const CLOSE_REASONS: readonly CloseReason[] = ["wontfix", "deferred", "superseded", "stale"];

function need(value: string | undefined, what: string, op: string): string {
  if (value === undefined || value.trim() === "") throw new ScopeError(`${op} needs ${what}`);
  return value;
}

function name(value: string | undefined, what: string, op: string): string {
  const v = need(value, what, op);
  if (!NAME.test(v)) throw new ScopeError(`${what} ${v} must be kebab-case`);
  return v;
}

function slice(value: string | undefined, op: string): string {
  const v = need(value, "slice", op);
  if (!SLICE.test(v) || v.split("/").includes("..")) throw new ScopeError(`slice ${v} is not a slice path`);
  return v;
}

function line(value: string, what: string, max: number = SCOPE_LIMITS.line): string {
  if (CONTROL.test(value)) throw new ScopeError(`${what} must be one line without control characters`);
  if (value.length > max) throw new ScopeError(`${what} is longer than ${max} characters`);
  return value;
}


function rail(p: ScopeParams): string[] {
  if ((p.add === undefined) === (p.set === undefined)) throw new ScopeError(`${p.op} needs exactly one of add and set`);
  const args = p.add !== undefined ? [`--add=${line(p.add, "add")}`] : [`--set=${line(p.set as string, "set")}`];
  if (p.status !== undefined) {
    if (!STATUSES.includes(p.status)) throw new ScopeError(`status ${p.status} is not allowed`);
    args.push(`--status=${p.status}`);
  }
  // section only places a new row; with set it is ignored, since models fill every field.
  if (p.section !== undefined && p.add !== undefined) {
    args.push(`--section=${line(p.section, "section", SCOPE_LIMITS.section)}`);
  }
  return args;
}

const hint = (p: ScopeParams, op: string): string[] => (p.mission !== undefined ? [`--mission=${name(p.mission, "mission", op)}`] : []);
/**
 * `--re-approve --reason` for a SPEC stamp that already exists. OpenRig keeps the prior stamp in the append-only
 * audit log and records the reason on the new row. A reason without reApprove is refused, as the CLI does.
 */
function reApproval(p: ScopeParams): string[] {
  const reason = p.reApproveReason;
  if (p.reApprove !== true) {
    if (reason !== undefined && reason.trim() !== "") throw new ScopeError(`${p.op}: reApproveReason needs reApprove true; drop it for a first approval`);
    return [];
  }
  if (reason === undefined || reason.trim() === "") throw new ScopeError(`${p.op}: reApprove needs reApproveReason, why the stamp is amended`);
  return ["--re-approve", `--reason=${line(reason.trim(), "reApproveReason")}`];
}

const titled = (p: ScopeParams): string[] => [
  ...(p.title !== undefined ? [`--title=${line(p.title, "title", SCOPE_LIMITS.title)}`] : []),
  `--intent=${line(need(p.intent, "intent", p.op), "intent")}`,
];

/** The exact `rig scope` argv for one op, pinned to the project root. Pure. Fields the op does not use are ignored. */
export function scopeCall(policy: Policy, seat: TeamSeat, p: ScopeParams): TeamCall {
  if (!seat.role.scopeOps.includes(p.op)) throw new ScopeError(`role ${seat.role.name} may not use scope ${p.op}`);
  const op = p.op;
  const args = ((): string[] => {
    switch (op) {
      case "audit":
        return ["audit", ...hint(p, op)];
      case "mission_ls":
        return ["mission", "ls"];
      case "mission_show":
        return ["mission", "show", name(p.mission, "mission", op)];
      case "mission_create":
        return ["mission", "create", name(p.name, "name", op), ...titled(p)];
      case "mission_progress":
        return ["mission", "progress", name(p.mission, "mission", op), ...rail(p)];
      case "mission_approve_spec":
        return ["mission", "approve", name(p.mission, "mission", op), "--scope=spec", ...reApproval(p)];
      case "slice_ls": {
        if (p.state !== undefined && !STATES.includes(p.state)) throw new ScopeError(`state ${p.state} is not allowed`);
        return ["slice", "ls", ...hint(p, op), ...(p.state !== undefined ? [`--state=${p.state}`] : [])];
      }
      case "slice_show":
        return ["slice", "show", slice(p.slice, op), ...hint(p, op)];
      case "slice_create":
        return ["slice", "create", name(p.mission, "mission", op), name(p.name, "name", op), ...titled(p)];
      case "slice_progress":
        return ["slice", "progress", slice(p.slice, op), ...hint(p, op), ...rail(p)];
      case "slice_close": {
        if (p.reason === undefined) {
          throw new ScopeError("slice_close needs reason (wontfix, deferred, superseded or stale). A delivered slice is not closed: set its rail rows done and leave delivery sign-off to the operator");
        }
        if (!CLOSE_REASONS.includes(p.reason)) throw new ScopeError(`reason ${p.reason} is not allowed; use one of ${CLOSE_REASONS.join(", ")}`);
        return [
          "slice",
          "close",
          slice(p.slice, op),
          ...hint(p, op),
          `--reason=${p.reason}`,
          ...(p.note !== undefined ? [`--note=${line(p.note, "note", SCOPE_LIMITS.note)}`] : []),
        ];
      }
      case "slice_approve_spec": {
        const locked = p.lockedArtifacts ?? [];
        for (const a of locked) if (!ARTIFACT.test(a) || a.split("/").includes("..")) throw new ScopeError(`locked artifact ${a} is not a slice-relative path`);
        return ["slice", "approve", slice(p.slice, op), ...hint(p, op), "--scope=spec", ...(locked.length > 0 ? [`--locked-artifacts=${locked.join(",")}`] : []), ...reApproval(p)];
      }
    }
  })();
  // Relative slice paths resolve against the cwd, so the call runs in the project root.
  return { args: ["scope", `--workspace=${policy.scope.root}`, ...args, "--json"], cwd: policy.scope.root };
}

// Ops that name one slice. Without --mission the CLI looks the slice up outside any mission and misses it.
const SLICE_OPS: readonly ScopeOp[] = ["slice_show", "slice_progress", "slice_close", "slice_approve_spec"];

/** The project's only mission, for slice ops called without one. Throws when there are none or several. */
export function soleMission(policy: Policy): string {
  const dir = join(policy.scope.root, "missions");
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME.test(d.name)).map((d) => d.name);
  } catch {
    names = [];
  }
  if (names.length !== 1) throw new ScopeError(`pass mission: the project has ${names.length === 0 ? "no missions" : `several missions (${names.sort().join(", ")})`}`);
  return names[0] as string;
}

export async function runScope(policy: Policy, runner: CommandRunner, seat: TeamSeat, p: ScopeParams, signal?: AbortSignal): Promise<string> {
  const call = scopeCall(policy, seat, p);
  const fill = p.mission === undefined && SLICE_OPS.includes(p.op) && !p.slice?.includes("/");
  return runRigCli(policy, runner, seat, fill ? scopeCall(policy, seat, { ...p, mission: soleMission(policy) }) : call, signal);
}

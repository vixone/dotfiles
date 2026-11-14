import type { ContextStatus } from "./autofresh.ts";
import type { QueueRow } from "./pace.ts";

/** Tools that wait on the operator. While one is open the lead cannot act on a reminder. */
export const OPERATOR_PROMPT_TOOLS: ReadonlySet<string> = new Set(["ask_user_question"]);

const CLOSED = new Set(["done", "failed", "handed-off", "canceled", "denied", "expired"]);
/** A blocked row waits on the operator (a merge, an approval) or a teammate; it gives an idle seat nothing to do. */
const WAITING = new Set(["blocked"]);

/**
 * A reminder's own lead turn must not count as work, or an empty rig would wake itself forever. Rows that only
 * wait do not count either, or the lead is told every two minutes to fill seats while the operator reviews a PR.
 */
export function hasActiveWork(input: {
  readonly leadWorking: boolean;
  readonly seats: readonly string[];
  readonly rows: readonly Pick<QueueRow, "sourceSession" | "destinationSession" | "state">[];
}): boolean {
  return input.leadWorking || input.rows.some((r) =>
    !CLOSED.has(r.state) && !WAITING.has(r.state) && (input.seats.includes(r.sourceSession) || input.seats.includes(r.destinationSession)),
  );
}

/**
 * Fingerprint of this rig's open work: the nonterminal rows on its seats, id and state. A reminder repeats within one
 * idle period only after this changes, so the lead is not told every two minutes about a seat it already chose to
 * leave idle (2026-11-11: 29 "stays idle on purpose" lead turns in one morning). Pure.
 */
export function workState(seats: readonly string[], rows: readonly Pick<QueueRow, "qitemId" | "sourceSession" | "destinationSession" | "state">[]): string {
  return rows
    .filter((r) => !CLOSED.has(r.state) && (seats.includes(r.sourceSession) || seats.includes(r.destinationSession)))
    .map((r) => `${r.qitemId}:${r.state}:${r.destinationSession}`)
    .sort()
    .join(",");
}

/** A seat reminded in this idle period, with nothing changed since, is reminded again after this long at most. */
export const QUIET_REPEAT_MS = 30 * 60_000;

export interface Reminded {
  readonly at: number;
  /** workState when it was sent. */
  readonly state: string;
}

export interface IdleInput {
  readonly now: number;
  readonly idleMs: number;
  readonly repeatMs: number;
  readonly active: boolean;
  readonly experts: readonly {
    readonly seat: string;
    readonly status: ContextStatus | undefined;
    readonly restarting: boolean;
  }[];
  /** Exhausted auto-managed seats wait for refresh or operator recovery, never idle-fill work. */
  readonly refresh?: { readonly seats: readonly string[]; readonly warnTokens: number };
  readonly lastSent: ReadonlyMap<string, Reminded>;
  /** workState now; undefined before the queue was read, which keeps every candidate the timing allows. */
  readonly state?: string;
}

/**
 * Seats idle at least idleMs and not reminded in the last repeatMs. The first reminder in an idle period always goes
 * out; a later one in the same period needs a changed workState, or QUIET_REPEAT_MS of silence.
 */
export function idleExperts(input: IdleInput): string[] {
  if (!input.active) return [];
  return input.experts.filter(({ seat, status, restarting }) => {
    if (restarting || status === undefined || status.running) return false;
    if (input.refresh?.seats.includes(seat) && status.tokens !== null && status.tokens > input.refresh.warnTokens) return false;
    const since = Date.parse(status.at);
    const idle = input.now - since;
    if (!Number.isFinite(idle) || idle < input.idleMs) return false;
    const last = input.lastSent.get(seat);
    if (last === undefined || last.at < since) return true;
    const gap = input.now - last.at;
    if (gap < input.repeatMs) return false;
    return input.state === undefined || input.state !== last.state || gap >= QUIET_REPEAT_MS;
  }).map((e) => e.seat);
}

export function idleReminder(seats: readonly string[], idleSeconds: number): string {
  return `[rig] Use ${seats.join(", ")}: idle for at least ${idleSeconds} seconds during active work. Assign the next useful step, or unblock existing work. Approval waits do not prevent preparation elsewhere; scope and approval gates still apply. Do not invent work just to fill a seat.`;
}

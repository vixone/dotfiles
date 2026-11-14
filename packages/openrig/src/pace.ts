// Shared queue readers for rig control timers.
import { join } from "node:path";
import type { Policy } from "./policy.ts";

export interface QueueRow {
  readonly qitemId: string;
  readonly tsCreated: string;
  readonly tsUpdated: string;
  readonly sourceSession: string;
  readonly destinationSession: string;
  readonly state: string;
  readonly summary?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rows from `rig queue list --json`. Malformed entries are dropped, not fatal. */
export function parseQueueList(stdout: string): QueueRow[] {
  const raw: unknown = JSON.parse(stdout);
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  const out: QueueRow[] = [];
  for (const r of list) {
    if (!isRecord(r)) continue;
    const { qitemId, tsCreated, tsUpdated, sourceSession, destinationSession, state, summary } = r;
    if ([qitemId, tsCreated, tsUpdated, sourceSession, destinationSession, state].some((v) => typeof v !== "string")) continue;
    out.push({
      qitemId: qitemId as string,
      tsCreated: tsCreated as string,
      tsUpdated: tsUpdated as string,
      sourceSession: sourceSession as string,
      destinationSession: destinationSession as string,
      state: state as string,
      ...(typeof summary === "string" ? { summary } : {}),
    });
  }
  return out;
}

/** Where OpenRig keeps a pi-tui seat's Pi sessions. */
export function seatSessionsDir(policy: Policy, sessionName: string): string {
  return join(policy.home, ".devrig", "openrig-home", "state", "pi-tui", sessionName, "sessions");
}

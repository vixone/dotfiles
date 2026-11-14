// What `devrig stop` must not cut short: a seat mid-turn. Prints one line per
// item and exits 1 when there is any, 0 when the rig can stop.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contextStatusPath, readContextStatus, type ContextStatus } from "./autofresh.ts";
import { seatSessionsDir } from "./pace.ts";
import { loadPolicy, type Policy } from "./policy.ts";

/** A seat whose context.json says running but has not written for this long died mid-turn; ignore it. */
export const STALE_RUNNING_MS = 2 * 60 * 60_000;

export interface BusyInput {
  readonly now: Date;
  /** OpenRig session name to its context.json, undefined when missing or malformed. */
  readonly seats: Readonly<Record<string, ContextStatus | undefined>>;
}

/** Pure. */
export function busyItems(p: BusyInput): string[] {
  const out: string[] = [];
  for (const [seat, s] of Object.entries(p.seats)) {
    if (s?.running !== true) continue;
    const age = p.now.getTime() - Date.parse(s.at);
    if (age <= STALE_RUNNING_MS) out.push(`${seat} is mid-turn (since ${s.at.slice(11, 16)}Z)`);
  }
  return out;
}

export function rigBusy(policy: Policy, now: Date): string[] {
  const seats: Record<string, ContextStatus | undefined> = {};
  // policy.rig.seats keys are already OpenRig session names (<pod>-<member>@<rig>).
  for (const session of Object.keys(policy.rig.seats)) seats[session] = readContextStatus(contextStatusPath(seatSessionsDir(policy, session)));
  return busyItems({ now, seats });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rigRoot = process.argv[2];
  if (rigRoot === undefined) {
    console.error("usage: DEVRIG_RIG=<rig> rig-busy.ts <rig root>");
    process.exit(2);
  }
  const rig = process.env.DEVRIG_RIG;
  const items = rigBusy(loadPolicy({ rigRoot, ...(rig ? { rig } : {}) }), new Date());
  for (const line of items) console.log(line);
  process.exit(items.length === 0 ? 0 : 1);
}

// Arranges a rig's Herdr view after `rig terminal open`: OpenRig tiles three seats as a 2x2 grid with an inert
// `sh` filler and orders tiles its own way. This closes the filler and puts the experts on top, the lead below.
//   herdr-arrange.ts <devrig> <workspace id>
// Every Herdr call goes through `<devrig> herdr`, so it reaches the rig's own Herdr server.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Tile {
  readonly paneId: string;
  readonly label: string;
}

/** Wanted reading order: experts by label, then the lead (label ending ".lead") last, i.e. bottom. Pure. */
export function wantedOrder(tiles: readonly Tile[]): string[] {
  const isLead = (t: Tile): boolean => t.label.endsWith(".lead");
  const rest = tiles.filter((t) => !isLead(t)).sort((a, b) => a.label.localeCompare(b.label));
  return [...rest, ...tiles.filter(isLead)].map((t) => t.paneId);
}

/**
 * Swaps that turn `current` (pane ids in reading order) into `wanted`, as [source, target] pane id pairs.
 * A Herdr swap exchanges the two panes' places. Pure.
 */
export function swapPlan(current: readonly string[], wanted: readonly string[]): [string, string][] {
  const at = [...current];
  const swaps: [string, string][] = [];
  for (let i = 0; i < wanted.length && i < at.length; i++) {
    const want = wanted[i]!;
    const j = at.indexOf(want);
    if (j === i || j < 0) continue;
    swaps.push([want, at[i]!]);
    [at[i], at[j]] = [at[j]!, at[i]!];
  }
  return swaps;
}

type Json = Record<string, any>;

function main(devRig: string, ws: string): void {
  const herdr = (...args: string[]): Json => JSON.parse(execFileSync(devRig, ["herdr", ...args], { encoding: "utf8" })) as Json;
  const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const tab = (herdr("tab", "list").result.tabs as Json[]).filter((t) => t.workspace_id === ws && String(t.label).startsWith("openrig:")).at(-1);
  if (!tab) return;
  const panes = (): Json[] => (herdr("pane", "list").result.panes as Json[]).filter((p) => p.tab_id === tab.tab_id);
  // layout.apply returns before every pane is listed; wait until two reads half a second apart agree.
  let seen = panes();
  for (let i = 0; i < 10; i++) {
    sleep(500);
    const next = panes();
    if (next.map((p) => p.pane_id).join() === seen.map((p) => p.pane_id).join()) break;
    seen = next;
  }
  for (const p of seen) if (!p.label) herdr("pane", "close", p.pane_id);
  const tiles: Tile[] = seen.filter((p) => p.label).map((p) => ({ paneId: p.pane_id, label: String(p.label) }));
  if (tiles.length === 0) return;
  const rects = herdr("pane", "layout", "--pane", tiles[0]!.paneId).result.layout.panes as Json[];
  const current = rects
    .slice()
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .map((r) => String(r.pane_id));
  for (const [source, target] of swapPlan(current, wantedOrder(tiles))) herdr("pane", "swap", "--source-pane", source, "--target-pane", target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [devRig, ws] = process.argv.slice(2);
  if (!devRig || !ws) {
    process.stderr.write("usage: herdr-arrange.ts <devrig> <workspace id>\n");
    process.exitCode = 2;
  } else {
    try {
      main(devRig, ws);
    } catch (error) {
      // The view still works unarranged; say so and carry on.
      process.stderr.write(`herdr-arrange: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

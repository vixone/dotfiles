// Caps what a locked seat's model sees of one tool result. A result above policy.results.capBytes keeps its head
// and tail on whole lines; the full text goes to <workspace>/.spill/<member>/ for fs_read paging, so a 50 KB cat
// costs about 3k tokens instead of 13k. Tools explicitly listed in policy.results.uncapped and
// non-text parts pass through.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "./policy.ts";
import { truncateTail, truncateText } from "./text.ts";

export const SPILL_DIR = ".spill";
const SPILL_KEEP_MS = 24 * 3600 * 1000;
/** Room for the marker line between head and tail. */
const MARKER_BYTES = 400;

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface Cut {
  readonly head: string;
  readonly tail: string;
  /** 1-based line numbers of the full text that the excerpt leaves out. */
  readonly firstCut: number;
  readonly lastCut: number;
  readonly totalLines: number;
}

/**
 * Splits text over capBytes into a head (about two thirds) and a tail (about a quarter), each on whole lines when
 * that keeps at least half its share; a single long line is cut by bytes. Undefined when the text fits. Pure.
 */
export function cutText(text: string, capBytes: number): Cut | undefined {
  if (Buffer.byteLength(text, "utf8") <= capBytes) return undefined;
  const budget = capBytes - MARKER_BYTES;
  const headShare = Math.floor((budget * 2) / 3);
  const tailShare = Math.floor(budget / 4);
  const lines = text.split("\n");
  let head = truncateText(text, headShare).text;
  const headNl = head.lastIndexOf("\n");
  if (Buffer.byteLength(head.slice(0, headNl + 1), "utf8") >= headShare / 2) head = head.slice(0, headNl + 1);
  let tail = truncateTail(text, tailShare).text;
  const tailNl = tail.indexOf("\n");
  const tailWhole = tailNl >= 0 && Buffer.byteLength(tail.slice(tailNl + 1), "utf8") >= tailShare / 2;
  if (tailWhole) tail = tail.slice(tailNl + 1);
  const headWhole = head.endsWith("\n");
  const headLines = head.split("\n").length - (headWhole ? 1 : 0);
  const tailLines = tail.split("\n").length;
  // A line the byte cut splits counts as cut.
  const firstCut = headWhole ? headLines + 1 : headLines;
  const lastCut = Math.max(firstCut, lines.length - tailLines + (tailWhole ? 0 : 1));
  return { head, tail, firstCut, lastCut, totalLines: lines.length };
}

/** The spill file for one result: <workspace>/.spill/<member>/<utc stamp>-<tool>-<call id tail>.txt. */
export function spillPath(policy: Policy, member: string, toolName: string, toolCallId: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const id = toolCallId.replace(/[^A-Za-z0-9]/g, "").slice(-12) || "call";
  return join(policy.workspace, SPILL_DIR, member, `${stamp}-${toolName}-${id}.txt`);
}

/**
 * Who pages the spill file: a locked seat through fs_read with a workspace-relative path, the operator-posture lead
 * through Pi's own read with an absolute one (the lead has no fs_read).
 */
export type SpillReader = "fs_read" | "read";

export interface CapOptions {
  readonly capBytes: number;
  readonly reader: SpillReader;
}

/** The model's text for a cut result. shownPath is the spill file as the reader takes it. Pure. */
export function excerpt(cut: Cut, bytes: number, shownPath: string, reader: SpillReader = "fs_read"): string {
  const kb = (n: number): string => `${Math.round(n / 1024)} KB`;
  const how = reader === "fs_read" ? `fs_read offset=${cut.firstCut} limit=150, or fs_search it,` : `read offset=${cut.firstCut} limit=150, or rg it,`;
  const marker =
    `[rig: lines ${cut.firstCut}-${cut.lastCut} of ${cut.totalLines} cut (${kb(bytes)} result). Full text: ${shownPath}. ` +
    `Read on with ${how} only if you need it.]`;
  return `${cut.head}${cut.head.endsWith("\n") ? "" : "\n"}${marker}\n${cut.tail}`;
}

/**
 * Applies the cap to one result's content. Returns the replacement content, or undefined to leave it. The spill
 * write happens before the excerpt is returned; when it fails the excerpt says so instead of naming a file.
 */
export function capResult<T extends { readonly type: string }>(
  policy: Policy,
  member: string,
  toolName: string,
  toolCallId: string,
  content: readonly T[],
  now: Date,
  options: CapOptions = { capBytes: policy.results.capBytes, reader: "fs_read" },
): (T | TextPart)[] | undefined {
  if (policy.results.uncapped.includes(toolName)) return undefined;
  const texts = content.filter((c): c is T & TextPart => c.type === "text" && typeof (c as { text?: unknown }).text === "string");
  if (texts.length === 0) return undefined;
  const full = texts.map((t) => t.text).join("\n");
  const cut = cutText(full, options.capBytes);
  if (cut === undefined) return undefined;
  const path = spillPath(policy, member, toolName, toolCallId, now);
  let rel = options.reader === "fs_read" ? path.slice(policy.workspace.length + 1) : path;
  try {
    mkdirSync(join(policy.workspace, SPILL_DIR, member), { recursive: true, mode: 0o700 });
    writeFileSync(path, full, { mode: 0o600 });
  } catch (error) {
    rel = `not saved (${error instanceof Error ? error.message : String(error)}); rerun narrower`;
  }
  const others = content.filter((c) => c.type !== "text");
  const part: TextPart = { type: "text", text: excerpt(cut, Buffer.byteLength(full, "utf8"), rel, options.reader) };
  return [part, ...others];
}

/** Drops this seat's spill files older than a day. Errors are ignored: a stale file only costs disk. */
export function pruneSpill(policy: Policy, member: string, now: Date): void {
  const dir = join(policy.workspace, SPILL_DIR, member);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (now.getTime() - statSync(file).mtimeMs > SPILL_KEEP_MS) rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

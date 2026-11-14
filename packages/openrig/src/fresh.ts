// A fresh conversation for a locked seat. Locked seats have no /continue and never pick the conversation they
// resume (src/seat.ts tuiTarget), so the new conversation comes from OpenRig: the operator runs `devrig fresh
// <member>`, which types /fresh into the seat. The rig extension's /fresh has the seat write its handover and saves
// it here; bin/devrig files it as the seat's OpenRig RECAP (`rig context recap-write`), starts a fresh occupant in
// the same seat (`rig seat launch --fresh --stop`). The priming that tells the new conversation what to do goes
// into its first input (takePrime, primeText), ahead of OpenRig's startup turn, so the seat reads its RECAP before
// it looks at the queue. `devrig fresh <member> --blank` skips the handover for a seat moving to new work.
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export class FreshError extends Error {
  override name = "FreshError";
}

/** Directory name next to the seat's sessions dir; bin/devrig reads the same path. */
export const FRESH_DIR = "fresh";
export const RECAP_FILE = "recap.md";
export const ERROR_FILE = "error.txt";
export const RECAP_MAX_BYTES = 64 * 1024;
/** bin/devrig writes `recap` or `blank` here just before the fresh launch; prepare-tui consumes it. */
export const PRIME_FILE = "prime";
/** An older marker is left over from a failed run and primes nothing. */
export const PRIME_MAX_AGE_MS = 10 * 60 * 1000;

export type PrimeMode = "recap" | "blank";

/** <seat root>/fresh, where <seat root> holds the seat's agent and sessions dirs. */
export function freshDir(sessionsDir: string): string {
  return join(dirname(resolve(sessionsDir)), FRESH_DIR);
}

/** The member name `devrig fresh` takes: the session name before '@', without the pod prefix. */
export function freshMember(sessionName: string): string {
  return (sessionName.split("@")[0] ?? sessionName).replace(/^dev-/, "");
}

/** The handover turn's prompt: the policy's handover instructions, with what the turn is for. */
export function recapPrompt(instructions: string): string {
  return [
    "The rig is replacing this conversation with a fresh one. The new conversation starts from your handover and the rig's records, nothing else.",
    "Do not call tools and do not start new work. Reply with only the handover, in markdown, following these instructions.",
    "",
    instructions.trim(),
  ].join("\n");
}

export interface AssistantText {
  readonly text: string;
  readonly stopReason: string | undefined;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is Json => isObject(c) && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function message(e: unknown): Json | undefined {
  return isObject(e) && e.type === "message" && isObject(e.message) ? e.message : undefined;
}

function assistantText(m: Json): AssistantText {
  return { text: messageText(m.content), stopReason: typeof m.stopReason === "string" ? m.stopReason : undefined };
}

/** Text of the last assistant message on a session branch, or undefined when there is none. */
export function lastAssistantText(entries: readonly unknown[]): AssistantText | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = message(entries[i]);
    if (m?.role === "assistant") return assistantText(m);
  }
  return undefined;
}

/**
 * The reply to the handover prompt: the last assistant message after the latest user message with exactly that
 * text, before the next user message. A teammate's wake queued during the turn is a later user message, so its
 * reply is never taken for the handover.
 */
export function recapReply(entries: readonly unknown[], prompt: string): AssistantText | undefined {
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = message(entries[i]);
    if (m?.role === "user" && messageText(m.content) === prompt) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  let reply: AssistantText | undefined;
  for (let i = start + 1; i < entries.length; i++) {
    const m = message(entries[i]);
    if (m?.role === "user") break;
    if (m?.role === "assistant") reply = assistantText(m);
  }
  return reply;
}

/** True once the branch has an assistant message, so there is something to hand over. */
export function hasWork(entries: readonly unknown[]): boolean {
  return lastAssistantText(entries) !== undefined;
}

/** The recap to file, or why the turn's output is not one: empty, failed, headerless or oversized. */
export function checkRecap(last: AssistantText | undefined): string {
  if (last === undefined) throw new FreshError("the handover turn produced no reply");
  if (last.stopReason === "error" || last.stopReason === "aborted") throw new FreshError(`the handover turn ended with ${last.stopReason}`);
  const text = last.text.trim();
  if (text.length === 0) throw new FreshError("the handover reply is empty");
  if (!/^## \S/m.test(text)) throw new FreshError("the handover reply has no '## ' section; it is not a handover");
  if (Buffer.byteLength(text, "utf8") > RECAP_MAX_BYTES) throw new FreshError(`the handover reply is over ${RECAP_MAX_BYTES} bytes`);
  return `${text}\n`;
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Clears the previous result, so `devrig fresh` never files an old recap. */
export function clearFresh(dir: string): void {
  rmSync(join(dir, RECAP_FILE), { force: true });
  rmSync(join(dir, ERROR_FILE), { force: true });
}

/** Saves the recap or the reason there is none. Exactly one of the two files exists afterwards. */
export function writeFresh(dir: string, result: { readonly recap: string } | { readonly error: string }): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  clearFresh(dir);
  if ("recap" in result) {
    const file = join(dir, RECAP_FILE);
    writeAtomic(file, result.recap);
    return file;
  }
  const file = join(dir, ERROR_FILE);
  writeAtomic(file, `${result.error.replace(/\s+/g, " ").trim()}\n`);
  return file;
}

/**
 * Reads and deletes the priming marker. Returns the mode only for a regular file younger than PRIME_MAX_AGE_MS that
 * holds exactly `recap` or `blank`; anything else is deleted and primes nothing. The marker carries a mode, not
 * text: the priming itself comes from primeText.
 */
export function takePrime(dir: string, now: number = Date.now()): PrimeMode | undefined {
  const file = join(dir, PRIME_FILE);
  let mode: PrimeMode | undefined;
  try {
    const st = lstatSync(file);
    if (st.isFile() && now - st.mtimeMs <= PRIME_MAX_AGE_MS) {
      const word = readFileSync(file, "utf8").trim();
      if (word === "recap" || word === "blank") mode = word;
    }
  } catch {
    return undefined;
  }
  rmSync(file, { force: true });
  return mode;
}

/** The OpenRig RECAP path for a seat session (`dev-expert1@devrig`) under the rig's OPENRIG_HOME. */
export function recapPath(openrigHome: string, sessionName: string): string {
  const [seat, rig] = sessionName.split("@");
  if (!seat || !rig) throw new FreshError(`'${sessionName}' is not a seat session name`);
  return join(openrigHome, "topology", "rigs", rig, "seats", seat, "RECAP.md");
}

/** The line that opens a fresh conversation's first input, ahead of OpenRig's startup turn. */
export function primeText(mode: PrimeMode, sessionName: string, recap: string): string {
  if (mode === "recap") {
    return `# Fresh conversation for ${sessionName}: the rig restarted this seat from your previous handover. Read ${recap} with fs_read before anything else, including the startup checks below, then carry on from its Next.`;
  }
  return `# Fresh conversation for ${sessionName}: the rig restarted this seat for new work. Your previous conversation and its handover are closed; do not read old RECAPs. Do the startup checks below, then take work only from your queue.`;
}

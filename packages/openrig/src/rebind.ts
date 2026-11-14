// Keeps an operator seat on the Pi conversation the operator is in. OpenRig resumes a pi-tui seat by the conversation
// it named at launch and stores no resume token for community harnesses (`rig seat set-resume-token` refuses
// pi-tui). /continue, /new, /resume and /fork move Pi to another session, so the rig extension records the move in
// a pointer file next to the seat's sessions dir and src/seat.ts prepare-tui follows it on the next resume.
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export class RebindError extends Error {
  override name = "RebindError";
}

const PI_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;

export type SwitchReason = "new" | "resume" | "fork";

export interface Conversation {
  readonly id: string;
  readonly file: string | undefined;
}

/** `ref` is the conversation OpenRig resumes the seat by; `session` is the Pi session to open instead. */
export interface ResumePointer {
  readonly ref: string;
  readonly session: string;
}

export const POINTER_FILE = "resume-pointer.json";

export function pointerPath(sessionsDir: string): string {
  return join(dirname(resolve(sessionsDir)), POINTER_FILE);
}

/**
 * The conversation to bind, or why not. Refuses one outside the seat's sessions dir (a /resume into another
 * project), since the resume looks only there, and waits while Pi has not written the file yet.
 */
export function rebindTarget(c: Conversation, sessionsDir: string): { readonly id: string } | { readonly wait: true } | { readonly refuse: string } {
  if (!PI_SESSION_ID.test(c.id)) return { refuse: `'${c.id}' is not a Pi session id` };
  if (c.file === undefined) return { wait: true };
  if (dirname(resolve(c.file)) !== resolve(sessionsDir)) return { refuse: `${c.file} is outside the seat sessions dir ${sessionsDir}` };
  if (!existsSync(c.file)) return { wait: true };
  return { id: c.id };
}

/** The conversation OpenRig launched this seat with: the resume ref, or the name it gave a new conversation. */
export function openrigRef(env: NodeJS.ProcessEnv): string | undefined {
  const ref = env.OPENRIG_RESUME_REF || env.OPENRIG_CONVERSATION;
  return ref !== undefined && PI_SESSION_ID.test(ref) ? ref : undefined;
}

/** Points the seat at `session`. Going back to OpenRig's own conversation removes the pointer. */
export function writePointer(sessionsDir: string, p: ResumePointer): void {
  if (!PI_SESSION_ID.test(p.ref) || !PI_SESSION_ID.test(p.session)) throw new RebindError("pointer ids must be Pi session ids");
  const file = pointerPath(sessionsDir);
  if (p.session === p.ref) {
    rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ref: p.ref, session: p.session })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function removePointer(sessionsDir: string): void {
  rmSync(pointerPath(sessionsDir), { force: true });
}

/** The recorded pointer, if any. A pointer that is not a plain file of two Pi session ids is an error, not ignored. */
export function readPointer(sessionsDir: string): ResumePointer | undefined {
  const file = pointerPath(sessionsDir);
  if (!existsSync(file)) return undefined;
  if (!lstatSync(file).isFile()) throw new RebindError(`${file} is not a regular file`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new RebindError(`${file} is not JSON; delete it to resume OpenRig's conversation`);
  }
  if (typeof raw !== "object" || raw === null) throw new RebindError(`${file} is malformed`);
  const { ref, session } = raw as Record<string, unknown>;
  if (typeof ref !== "string" || typeof session !== "string" || !PI_SESSION_ID.test(ref) || !PI_SESSION_ID.test(session)) {
    throw new RebindError(`${file} is malformed; delete it to resume OpenRig's conversation`);
  }
  return { ref, session };
}

/** The Pi session a resume of `ref` opens: the pointer's session when it was recorded for this ref. */
export function resumeSession(sessionsDir: string, ref: string): string {
  const p = readPointer(sessionsDir);
  return p !== undefined && p.ref === ref ? p.session : ref;
}

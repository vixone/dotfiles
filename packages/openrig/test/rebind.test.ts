import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { existsSync, statSync, symlinkSync } from "node:fs";
import { openrigRef, pointerPath, readPointer, rebindTarget, RebindError, removePointer, resumeSession, writePointer } from "../src/rebind.ts";
import { SeatError, tuiTarget, type TuiPlan } from "../src/seat.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "devrig-rebind-")));
after(() => rmSync(dir, { recursive: true, force: true }));
const sessions = join(dir, "sessions");
mkdirSync(sessions);
const written = join(sessions, "2026-11-04_abc.jsonl");
writeFileSync(written, "{}\n");

describe("rebindTarget", () => {
  it("binds a written session in the seat dir", () => {
    assert.deepEqual(rebindTarget({ id: "0198-abc", file: written }, sessions), { id: "0198-abc" });
  });

  it("waits until Pi has written the session file", () => {
    assert.deepEqual(rebindTarget({ id: "0198-abc", file: undefined }, sessions), { wait: true });
    assert.deepEqual(rebindTarget({ id: "0198-abc", file: join(sessions, "later.jsonl") }, sessions), { wait: true });
  });

  it("refuses a session outside the seat dir and bad ids", () => {
    assert.ok("refuse" in rebindTarget({ id: "0198-abc", file: join(dir, "other", "x.jsonl") }, sessions));
    assert.ok("refuse" in rebindTarget({ id: "../x", file: written }, sessions));
  });
});

const REF = "openrig-dev-lead-devrig-5f30d1ce";

function session(id: string): string {
  const f = join(sessions, `2026-11-04T13-55-26-569Z_${id}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "session", id })}\n`);
  return f;
}

function plan(kind: "new" | "resume", id: string): TuiPlan {
  return { name: "dev-lead@devrig", agentDir: join(dir, "agent"), sessionsDir: sessions, conversation: { kind, id } };
}

describe("openrigRef", () => {
  it("takes the resume ref, else the new conversation name, and drops bad ones", () => {
    assert.equal(openrigRef({ OPENRIG_RESUME_REF: REF, OPENRIG_CONVERSATION: "other" }), REF);
    assert.equal(openrigRef({ OPENRIG_RESUME_REF: "", OPENRIG_CONVERSATION: REF }), REF);
    assert.equal(openrigRef({ OPENRIG_RESUME_REF: "../x" }), undefined);
    assert.equal(openrigRef({}), undefined);
  });
});

describe("resume pointer", () => {
  it("writes an operator-only file next to the sessions dir and reads it back", () => {
    writePointer(sessions, { ref: REF, session: "01a1-new" });
    assert.equal(pointerPath(sessions), join(dir, "resume-pointer.json"));
    assert.equal(statSync(pointerPath(sessions)).mode & 0o777, 0o600);
    assert.deepEqual(readPointer(sessions), { ref: REF, session: "01a1-new" });
    assert.equal(resumeSession(sessions, REF), "01a1-new");
    assert.equal(resumeSession(sessions, "openrig-other-1234"), "openrig-other-1234");
  });

  it("removes the pointer when the seat goes back to OpenRig's conversation", () => {
    writePointer(sessions, { ref: REF, session: "01a1-new" });
    writePointer(sessions, { ref: REF, session: REF });
    assert.equal(existsSync(pointerPath(sessions)), false);
    assert.equal(resumeSession(sessions, REF), REF);
  });

  it("refuses bad ids and malformed or linked pointer files", () => {
    assert.throws(() => writePointer(sessions, { ref: REF, session: "../x" }), RebindError);
    writeFileSync(pointerPath(sessions), "not json");
    assert.throws(() => readPointer(sessions), RebindError);
    writeFileSync(pointerPath(sessions), JSON.stringify({ ref: REF, session: "-x" }));
    assert.throws(() => readPointer(sessions), RebindError);
    removePointer(sessions);
    writeFileSync(join(dir, "elsewhere.json"), JSON.stringify({ ref: REF, session: "01a1-new" }));
    symlinkSync(join(dir, "elsewhere.json"), pointerPath(sessions));
    assert.throws(() => readPointer(sessions), RebindError);
    removePointer(sessions);
  });
});

describe("tuiTarget", () => {
  it("an operator seat resumes the session the pointer names", () => {
    session(REF);
    const moved = session("01a1-moved");
    writePointer(sessions, { ref: REF, session: "01a1-moved" });
    assert.equal(tuiTarget(plan("resume", REF), "operator"), moved);
    removePointer(sessions);
  });

  it("a locked seat ignores the pointer", () => {
    const original = session(REF);
    writePointer(sessions, { ref: REF, session: "01a1-moved" });
    assert.equal(tuiTarget(plan("resume", REF), "locked"), original);
    removePointer(sessions);
  });

  it("refuses when the pointed-at session is gone, instead of reopening the old one", () => {
    session(REF);
    writePointer(sessions, { ref: REF, session: "01a1-gone" });
    assert.throws(() => tuiTarget(plan("resume", REF), "operator"), SeatError);
    removePointer(sessions);
  });

  it("a new operator conversation drops the old pointer", () => {
    writePointer(sessions, { ref: REF, session: "01a1-moved" });
    assert.equal(tuiTarget(plan("new", "openrig-dev-lead-devrig-0000aaaa"), "operator"), "openrig-dev-lead-devrig-0000aaaa");
    assert.equal(existsSync(pointerPath(sessions)), false);
  });
});

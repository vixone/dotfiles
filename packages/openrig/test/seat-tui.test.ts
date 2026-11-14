import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { adaptFirstInput, checkFirstInput, findSessionFile, planLines, planTuiSeat, SeatError } from "../src/seat.ts";

const HOME = "/Users/op";
const OPENRIG_HOME = join(HOME, ".devrig", "openrig-home");
const NAME = "dev-expert1@devrig";
const SEAT = join(OPENRIG_HOME, "state", "pi-tui", NAME);
const ID = "openrig-dev-devdev-devrig-1a2b3c4d";
const base = { OPENRIG_HOME, OPENRIG_SESSION_NAME: NAME, OPENRIG_CONVERSATION: ID };

const isSeatError = (msg: RegExp) => (e: unknown) => e instanceof SeatError && msg.test(e.message);

describe("planTuiSeat", () => {
  it("maps a new conversation onto the seat layout", () => {
    assert.deepEqual(planTuiSeat(base, HOME), {
      name: NAME,
      agentDir: join(SEAT, "agent"),
      sessionsDir: join(SEAT, "sessions"),
      conversation: { kind: "new", id: ID },
      model: undefined,
      firstInput: undefined,
    });
  });

  it("takes a resume, a model with a thinking suffix and a first input", () => {
    const input = join(OPENRIG_HOME, "state", "first-input", encodeURIComponent(NAME), "x.txt");
    const p = planTuiSeat(
      { OPENRIG_HOME, OPENRIG_SESSION_NAME: NAME, OPENRIG_RESUME_REF: ID, OPENRIG_MODEL: "personal-provider/coding-model:high", OPENRIG_FIRST_INPUT: input },
      HOME,
    );
    assert.deepEqual(p.conversation, { kind: "resume", id: ID });
    assert.equal(p.model, "personal-provider/coding-model:high");
    assert.equal(p.firstInput, input);
  });

  it("treats empty optional variables as unset", () => {
    const p = planTuiSeat({ ...base, OPENRIG_RESUME_REF: "", OPENRIG_MODEL: "", OPENRIG_FIRST_INPUT: "" }, HOME);
    assert.equal(p.conversation.kind, "new");
    assert.equal(p.model, undefined);
  });

  const bad: [string, Record<string, string | undefined>, RegExp][] = [
    ["another OPENRIG_HOME", { ...base, OPENRIG_HOME: join(HOME, ".openrig") }, /OPENRIG_HOME must be/],
    ["no session name", { ...base, OPENRIG_SESSION_NAME: undefined }, /OPENRIG_SESSION_NAME/],
    ["session name with a slash", { ...base, OPENRIG_SESSION_NAME: "../x" }, /OPENRIG_SESSION_NAME/],
    ["neither conversation variable", { ...base, OPENRIG_CONVERSATION: undefined }, /exactly one/],
    ["both conversation variables", { ...base, OPENRIG_RESUME_REF: ID }, /exactly one/],
    ["conversation id with a slash", { ...base, OPENRIG_CONVERSATION: "a/b" }, /not a Pi session id/],
    ["conversation id ending in a dot", { ...base, OPENRIG_CONVERSATION: "abc." }, /not a Pi session id/],
    ["unqualified model", { ...base, OPENRIG_MODEL: "model-without-provider" }, /OPENRIG_MODEL/],
    ["relative first input", { ...base, OPENRIG_FIRST_INPUT: "x.txt" }, /OPENRIG_FIRST_INPUT/],
    ["first input outside OpenRig's folder", { ...base, OPENRIG_FIRST_INPUT: "/etc/passwd" }, /OPENRIG_FIRST_INPUT/],
    ["first input escaping by ..", { ...base, OPENRIG_FIRST_INPUT: join(OPENRIG_HOME, "state", "first-input", "..", "x") }, /OPENRIG_FIRST_INPUT/],
  ];
  for (const [label, env, msg] of bad) {
    it(`refuses ${label}`, () => assert.throws(() => planTuiSeat(env, HOME), isSeatError(msg)));
  }
});

describe("findSessionFile and checkFirstInput", () => {
  const dir = mkdtempSync(join(tmpdir(), "devrig-seat-tui-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const header = (id: string) => `${JSON.stringify({ type: "session", version: 3, id, cwd: "/w" })}\n{"type":"message"}\n`;

  it("finds the one file whose header names the id", () => {
    const sessions = join(dir, "one");
    mkdirSync(sessions);
    writeFileSync(join(sessions, `2026-11-04T08-00-00-000Z_${ID}.jsonl`), header(ID));
    writeFileSync(join(sessions, `2026-11-04T09-00-00-000Z_${ID}x.jsonl`), header(`${ID}x`));
    assert.equal(findSessionFile(sessions, ID), join(sessions, `2026-11-04T08-00-00-000Z_${ID}.jsonl`));
  });

  it("refuses a missing, empty, mislabelled, duplicated or symlinked session", () => {
    const sessions = join(dir, "bad");
    mkdirSync(sessions);
    assert.throws(() => findSessionFile(sessions, ID), isSeatError(/found 0/));
    assert.throws(() => findSessionFile(join(dir, "absent"), ID), isSeatError(/found 0/));
    writeFileSync(join(sessions, `a_${ID}.jsonl`), "");
    writeFileSync(join(sessions, `b_${ID}.jsonl`), header("other"));
    writeFileSync(join(sessions, `c_${ID}.jsonl`), "not json\n");
    writeFileSync(join(dir, "elsewhere.jsonl"), header(ID));
    symlinkSync(join(dir, "elsewhere.jsonl"), join(sessions, `d_${ID}.jsonl`));
    assert.throws(() => findSessionFile(sessions, ID), isSeatError(/found 0/));
    writeFileSync(join(sessions, `e_${ID}.jsonl`), header(ID));
    writeFileSync(join(sessions, `f_${ID}.jsonl`), header(ID));
    assert.throws(() => findSessionFile(sessions, ID), isSeatError(/found 2/));
    assert.throws(() => findSessionFile(sessions, "../x"), isSeatError(/not a Pi session id/));
  });

  it("refuses a first input Pi would read as a file or a command", () => {
    const ok = join(dir, "ok.txt");
    writeFileSync(ok, "You are dev-expert1@devrig.\n");
    checkFirstInput(ok);
    for (const [name, text] of [["at.txt", "@/etc/passwd"], ["slash.txt", "/login"]] as const) {
      writeFileSync(join(dir, name), text);
      assert.throws(() => checkFirstInput(join(dir, name)), isSeatError(/must not start/));
    }
    symlinkSync(ok, join(dir, "link.txt"));
    assert.throws(() => checkFirstInput(join(dir, "link.txt")), isSeatError(/regular file/));
  });
});

describe("planLines", () => {
  it("writes one value per line, ends with end and refuses line breaks", () => {
    assert.equal(planLines(["a", "", "b", ""]), "a\n\nb\n\nend\n");
    assert.throws(() => planLines(["a\nb"]), isSeatError(/line break/));
  });
});

describe("adaptFirstInput", () => {
  it("points OpenRig's rig commands at the team tool", () => {
    const text =
      "End of generated identity context.\n\nFor this identity-only startup, run rig whoami --json and reply.\n\n" +
      "derive your identity with rig whoami --json and read durable obligations with rig queue list --destination dev-lead@devrig --state pending,in-progress,blocked --limit 10000 --full --json. Report truncation.\n" +
      "If its peersNote says some peers are not shown, rig whoami --json --all-peers lists them all.";
    const out = adaptFirstInput(text);
    assert.doesNotMatch(out, /\brig (whoami|queue)/);
    assert.match(out, /run the team tool \(op whoami\) and reply/);
    assert.match(out, /read durable obligations with the team tool \(op queue_list, mine\)\. Report truncation/);
    assert.match(out, /^End of generated identity context\./);
  });
});

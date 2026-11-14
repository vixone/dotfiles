import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkRecap, clearFresh, ERROR_FILE, FreshError, freshDir, freshMember, hasWork, lastAssistantText, PRIME_FILE, PRIME_MAX_AGE_MS, primeText, RECAP_FILE, recapPath, recapReply, RECAP_MAX_BYTES, recapPrompt, takePrime, writeFresh } from "../src/fresh.ts";
import { writeFirstInput } from "../src/seat.ts";
import { makeEnv, RIG_ROOT } from "./helpers.ts";

const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (content: unknown, stopReason = "stop") => ({ type: "message", message: { role: "assistant", content, stopReason } });

describe("fresh paths", () => {
  it("puts the result next to the seat's sessions dir", () => {
    assert.equal(freshDir("/s/state/pi-tui/dev-expert2@devrig/sessions"), "/s/state/pi-tui/dev-expert2@devrig/fresh");
    assert.equal(freshDir("/s/state/pi-tui/dev-expert2@devrig/sessions/"), "/s/state/pi-tui/dev-expert2@devrig/fresh");
  });

  it("agrees with the path bin/devrig waits on", () => {
    const script = readFileSync(join(RIG_ROOT, "bin", "devrig"), "utf8");
    assert.match(script, /fresh_dir="\$state\/openrig-home\/state\/pi-tui\/\$seat_session\/fresh"/);
    assert.match(script, new RegExp(`\\$fresh_dir/${RECAP_FILE.replace(".", "\\.")}`));
    assert.match(script, new RegExp(`\\$fresh_dir/${ERROR_FILE.replace(".", "\\.")}`));
    assert.match(script, new RegExp(`\\$fresh_dir/${PRIME_FILE}"`));
  });

  it("names the member devrig fresh takes", () => {
    assert.equal(freshMember("dev-expert2@devrig"), "expert2");
    assert.equal(freshMember("expert1"), "expert1");
  });
});

describe("fresh recap", () => {
  it("wraps the handover instructions", () => {
    const p = recapPrompt("Write this summary as a handover.\n\n## Goal\n");
    assert.match(p, /Do not call tools/);
    assert.match(p, /Write this summary as a handover\.\n\n## Goal$/);
  });

  it("reads the last assistant text from a branch", () => {
    assert.equal(lastAssistantText([user("hi")]), undefined);
    assert.equal(hasWork([user("hi")]), false);
    const branch = [user("a"), assistant([{ type: "text", text: "old" }]), user("b"), assistant([{ type: "thinking", thinking: "x" }, { type: "text", text: "## Goal\nnew" }, { type: "toolCall", id: "1" }]), { type: "custom", data: {} }];
    assert.deepEqual(lastAssistantText(branch), { text: "## Goal\nnew", stopReason: "stop" });
    assert.equal(hasWork(branch), true);
    assert.deepEqual(lastAssistantText([assistant("## Goal\nplain", "length")]), { text: "## Goal\nplain", stopReason: "length" });
  });

  it("takes the reply to the handover prompt, not a later wake's", () => {
    const prompt = recapPrompt("Write this summary as a handover.");
    const branch = [
      user("work"),
      assistant([{ type: "text", text: "done" }]),
      user(prompt),
      assistant([{ type: "text", text: "" }, { type: "toolCall", id: "1" }], "toolUse"),
      { type: "message", message: { role: "toolResult", content: [] } },
      assistant([{ type: "text", text: "## Goal\nrecap" }]),
      user("From: dev-lead wake"),
      assistant([{ type: "text", text: "ack" }]),
    ];
    assert.deepEqual(recapReply(branch, prompt), { text: "## Goal\nrecap", stopReason: "stop" });
    assert.equal(recapReply(branch.slice(0, 2), prompt), undefined);
    assert.equal(recapReply(branch.slice(0, 3), prompt), undefined);
  });

  it("accepts a handover and refuses anything else", () => {
    assert.equal(checkRecap({ text: "\n## Goal\nShip it.\n\n", stopReason: "stop" }), "## Goal\nShip it.\n");
    assert.throws(() => checkRecap(undefined), FreshError);
    assert.throws(() => checkRecap({ text: "## Goal\nx", stopReason: "error" }), /error/);
    assert.throws(() => checkRecap({ text: "## Goal\nx", stopReason: "aborted" }), /aborted/);
    assert.throws(() => checkRecap({ text: "  ", stopReason: "stop" }), /empty/);
    assert.throws(() => checkRecap({ text: "Sure, I will do that.", stopReason: "stop" }), /no '## ' section/);
    assert.throws(() => checkRecap({ text: `## Goal\n${"x".repeat(RECAP_MAX_BYTES)}`, stopReason: "stop" }), /over/);
  });
});

describe("fresh result files", () => {
  let dir: string;
  before(() => {
    dir = join(realpathSync(mkdtempSync(join(tmpdir(), "devrig-fresh-"))), "seat", "fresh");
  });
  after(() => rmSync(join(dir, "..", ".."), { recursive: true, force: true }));

  it("leaves exactly one of recap and error, private to the operator", () => {
    const recap = writeFresh(dir, { recap: "## Goal\nx\n" });
    assert.equal(recap, join(dir, RECAP_FILE));
    assert.equal(readFileSync(recap, "utf8"), "## Goal\nx\n");
    assert.equal(statSync(recap).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const error = writeFresh(dir, { error: "nothing to\nhand over" });
    assert.equal(readFileSync(error, "utf8"), "nothing to hand over\n");
    assert.equal(existsSync(recap), false);
    writeFresh(dir, { recap: "## Goal\ny\n" });
    assert.equal(existsSync(error), false);
    clearFresh(dir);
    assert.equal(existsSync(join(dir, RECAP_FILE)), false);
    assert.equal(existsSync(join(dir, ERROR_FILE)), false);
  });
});

describe("fresh priming", () => {
  let root: string;
  let dir: string;
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "devrig-prime-")));
    dir = join(root, "seat", "fresh");
    mkdirSync(dir, { recursive: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  const mark = (text: string, ageMs = 0): string => {
    const file = join(dir, PRIME_FILE);
    writeFileSync(file, text);
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(file, t, t);
    return file;
  };

  it("takes a recap or blank marker once", () => {
    const file = mark("recap\n");
    assert.equal(takePrime(dir), "recap");
    assert.equal(existsSync(file), false);
    assert.equal(takePrime(dir), undefined);
    mark("blank");
    assert.equal(takePrime(dir), "blank");
  });

  it("deletes a stale, unknown or non-file marker and primes nothing", () => {
    for (const file of [mark("recap", PRIME_MAX_AGE_MS + 60_000), mark("read /etc/passwd")]) {
      assert.equal(takePrime(dir), undefined);
      assert.equal(existsSync(file), false);
    }
    const target = join(root, "elsewhere");
    writeFileSync(target, "recap");
    symlinkSync(target, join(dir, PRIME_FILE));
    assert.equal(takePrime(dir), undefined);
    assert.equal(existsSync(target), true);
  });

  it("points the recap priming at the seat's OpenRig RECAP", () => {
    const recap = recapPath("/h/openrig-home", "dev-expert1@devrig");
    assert.equal(recap, "/h/openrig-home/topology/rigs/devrig/seats/dev-expert1/RECAP.md");
    assert.throws(() => recapPath("/h", "dev-expert1"), FreshError);
    assert.match(primeText("recap", "dev-expert1@devrig", recap), /Read \/h\/openrig-home\/.*RECAP\.md with fs_read before anything else/);
    const blank = primeText("blank", "dev-expert1@devrig", recap);
    assert.doesNotMatch(blank, /RECAP\.md/);
    assert.match(blank, /do not read old RECAPs/);
  });

  it("puts the priming ahead of OpenRig's startup turn", () => {
    const agentDir = join(root, "seat", "agent");
    const source = join(root, "openrig-input.txt");
    writeFileSync(source, "This is a fresh conversation. Run rig whoami --json.");
    const out = writeFirstInput(source, agentDir, "# Fresh conversation");
    assert.equal(readFileSync(out as string, "utf8"), "# Fresh conversation\n\nThis is a fresh conversation. Run the team tool (op whoami).");
    assert.equal(statSync(out as string).mode & 0o777, 0o600);
    assert.equal(readFileSync(writeFirstInput(undefined, agentDir, "# Only") as string, "utf8"), "# Only");
    assert.equal(readFileSync(writeFirstInput(source, agentDir) as string, "utf8"), "This is a fresh conversation. Run the team tool (op whoami).");
    assert.equal(writeFirstInput(undefined, agentDir), undefined);
  });
});

describe("context budget policy", () => {
  it("warns before Pi compacts and keeps the order", () => {
    const env = makeEnv();
    try {
      assert.equal(env.policy.context.warnTokens, 150_000);
      assert.equal(env.policy.context.hardCompactTokens, 250_000);
      assert.equal(env.policy.context.steerAgainTokens, 200_000);
      assert.ok(env.policy.context.instructionsFile.endsWith(join("policy", "handover.md")));
    } finally {
      env.cleanup();
    }
    const context = { warnTokens: 200_000, hardCompactTokens: 200_000, steerAgainTokens: 200_000, keepRecentTokens: 20_000, instructionsFile: "policy/handover.md" };
    assert.throws(() => makeEnv({ context }), /keepRecentTokens < warnTokens < hardCompactTokens/);
    assert.throws(() => makeEnv({ context: { ...context, warnTokens: undefined, softCompactTokens: 150_000 } }), /warnTokens/);
    const ok = { ...context, warnTokens: 150_000, hardCompactTokens: 250_000 };
    assert.throws(() => makeEnv({ context: { ...ok, steerAgainTokens: undefined } }), /steerAgainTokens must be a positive integer/);
    for (const steerAgainTokens of [150_000, 250_000]) {
      assert.throws(() => makeEnv({ context: { ...ok, steerAgainTokens } }), /warnTokens < steerAgainTokens < hardCompactTokens/);
    }
  });
});

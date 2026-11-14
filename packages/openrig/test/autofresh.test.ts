import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { contextStatusPath, footerEntry, freshDue, freshFailure, freshMode, freshPlan, freshRequest, openRowsCall, readContextStatus, writeContextStatus, type PlanInput } from "../src/autofresh.ts";
import * as autofresh from "../src/autofresh.ts";
import type { QueueRow } from "../src/pace.ts";
import { seatRole } from "../src/policy.ts";
import { makeEnv, ok, RIG_ROOT } from "./helpers.ts";

const env = makeEnv();
after(() => env.cleanup());
const { policy } = env;
const LEAD = "dev-lead@devrig";
const E1 = "dev-expert1@devrig";
const E2 = "dev-expert2@devrig";
const NOW = new Date("2026-11-09T10:00:00.000Z");
const ago = (s: number): string => new Date(NOW.getTime() - s * 1000).toISOString();

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  seat: E1,
  status: { tokens: 170_000, running: false, at: ago(120) },
  now: NOW,
  warnTokens: 150_000,
  idleMs: 60_000,
  ...over,
});

const row = (state: string, dest = E1): QueueRow => ({ qitemId: "qitem-1", tsCreated: ago(600), tsUpdated: ago(60), sourceSession: LEAD, destinationSession: dest, state });

describe("autofresh policy", () => {
  it("gives the lead autoFresh over both experts", () => {
    assert.deepEqual(seatRole(policy, LEAD).autoFresh, { seats: [E1, E2], idleSeconds: 60, pollSeconds: 30, assignBlankTokens: 100_000, steeredIdleSeconds: 10 });
    assert.equal(seatRole(policy, E1).autoFresh, undefined);
  });

  const raw = (): Record<string, Record<string, Record<string, unknown>>> => JSON.parse(readFileSync(join(RIG_ROOT, "policy", "safety.json"), "utf8"));
  const withAuto = (role: string, autoFresh: unknown): Record<string, unknown> => {
    const roles = raw().roles as Record<string, Record<string, unknown>>;
    (roles[role] as Record<string, unknown>).autoFresh = autoFresh;
    return { roles };
  };
  it("refuses autoFresh on a locked role, over the lead, or with bad timings", () => {
    assert.throws(() => makeEnv(withAuto("expert", { seats: ["dev-expert2"], idleSeconds: 60, pollSeconds: 30 })), /autoFresh is for operator seats/);
    assert.throws(() => makeEnv(withAuto("architect", { seats: ["dev-lead"], idleSeconds: 60, pollSeconds: 30 })), /not a locked seat/);
    assert.throws(() => makeEnv(withAuto("architect", { seats: ["dev-nobody"], idleSeconds: 60, pollSeconds: 30 })), /not a seat/);
    assert.throws(() => makeEnv(withAuto("architect", { seats: ["dev-expert1", "dev-expert1"], idleSeconds: 60, pollSeconds: 30 })), /distinct/);
    assert.throws(() => makeEnv(withAuto("architect", { seats: [], idleSeconds: 60, pollSeconds: 30 })), /distinct|non-empty/);
    assert.throws(() => makeEnv(withAuto("architect", { seats: ["dev-expert1"], idleSeconds: 1, pollSeconds: 30 })), /idleSeconds/);
    assert.throws(() => makeEnv(withAuto("architect", { seats: ["dev-expert1"], idleSeconds: 60, pollSeconds: 0 })), /pollSeconds/);
    const base = { seats: ["dev-expert1"], idleSeconds: 60, pollSeconds: 30 };
    assert.throws(() => makeEnv(withAuto("architect", { ...base, assignBlankTokens: 5_000 })), /assignBlankTokens/);
    assert.throws(() => makeEnv(withAuto("architect", { ...base, steeredIdleSeconds: 2 })), /steeredIdleSeconds/);
    assert.throws(() => makeEnv(withAuto("architect", { ...base, steeredIdleSeconds: 90 })), /steeredIdleSeconds.*idleSeconds/);
    assert.throws(() => makeEnv(withAuto("architect", { ...base, assignBlankTokens: 160_000 })), /assignBlankTokens.*warnTokens/);
    const off = makeEnv(withAuto("architect", base));
    try {
      assert.equal(off.policy.roles.architect?.autoFresh?.assignBlankTokens, undefined);
    } finally {
      off.cleanup();
    }
  });
});

describe("context status file", () => {
  const sessions = join(env.dir, "seat", "sessions");
  const file = contextStatusPath(sessions);
  it("sits in the seat root next to sessions", () => {
    assert.equal(file, join(env.dir, "seat", "context.json"));
  });
  it("round-trips and rejects junk", () => {
    writeContextStatus(file, { tokens: 123, running: true, at: NOW.toISOString() });
    assert.deepEqual(readContextStatus(file), { tokens: 123, running: true, at: NOW.toISOString() });
    writeContextStatus(file, { tokens: null, running: false, at: NOW.toISOString() });
    assert.equal(readContextStatus(file)?.tokens, null);
    mkdirSync(join(env.dir, "seat"), { recursive: true });
    for (const bad of ["{", "[]", '{"tokens":-1,"running":false,"at":"2026-11-09T10:00:00Z"}', '{"tokens":5,"running":"no","at":"2026-11-09T10:00:00Z"}', '{"tokens":5,"running":false,"at":"soon"}']) {
      writeFileSync(file, bad);
      assert.equal(readContextStatus(file), undefined, bad);
    }
    assert.equal(readContextStatus(join(env.dir, "missing.json")), undefined);
  });
  it("round-trips the wrap-up steer flag and rejects a non-boolean", () => {
    const status = { tokens: 170_000, running: false, at: ago(5), sessionId: "c", steered: true };
    writeContextStatus(file, status);
    assert.deepEqual(readContextStatus(file), status);
    writeFileSync(file, JSON.stringify({ ...status, steered: "yes" }));
    assert.equal(readContextStatus(file), undefined);
  });
  it("round-trips conversation identity while accepting legacy status files", () => {
    const status = { tokens: 170_000, running: false, at: ago(120), sessionId: "conversation-a" };
    writeContextStatus(file, status);
    assert.deepEqual(readContextStatus(file), status);
    for (const sessionId of ["", "  ", 42, null, {}]) {
      writeFileSync(file, JSON.stringify({ ...status, sessionId }));
      assert.equal(readContextStatus(file), undefined);
    }
  });
});

describe("freshDue", () => {
  it("restarts an idle seat past the budget", () => {
    assert.equal(freshDue(input()), undefined);
  });
  it("waits under budget, without a figure, while running, and until idle long enough", () => {
    assert.deepEqual(freshDue(input({ status: { tokens: 150_000, running: false, at: ago(600) } })), { wait: "under budget" });
    assert.deepEqual(freshDue(input({ status: { tokens: null, running: false, at: ago(600) } })), { wait: "under budget" });
    assert.deepEqual(freshDue(input({ status: undefined })), { wait: "no context figure" });
    assert.deepEqual(freshDue(input({ status: { tokens: 199_000, running: true, at: ago(600) } })), { wait: "running" });
    assert.deepEqual(freshDue(input({ status: { tokens: 199_000, running: false, at: ago(20) } })), { wait: "idle 20s" });
  });
  it("waits the shorter steered idle once the rig told the seat to wrap up", () => {
    const steered = (at: number, flag = true): PlanInput => input({ status: { tokens: 170_000, running: false, at: ago(at), steered: flag }, steeredIdleMs: 10_000 });
    assert.equal(freshDue(steered(10)), undefined);
    assert.deepEqual(freshDue(steered(4)), { wait: "idle 4s" });
    assert.deepEqual(freshDue(steered(30, false)), { wait: "idle 30s" });
    assert.deepEqual(freshDue(input({ status: { tokens: 170_000, running: false, at: ago(30), steered: true } })), { wait: "idle 30s" }, "no steered setting keeps idleSeconds");
  });
  it("says when the idle wait ends, so the lead can check right then", () => {
    const s = (at: number, steered?: boolean): autofresh.ContextStatus => ({ tokens: 170_000, running: false, at: ago(at), ...(steered === undefined ? {} : { steered }) });
    assert.equal(autofresh.idleRemainingMs(s(4, true), NOW, 60_000, 10_000), 6_000);
    assert.equal(autofresh.idleRemainingMs(s(4), NOW, 60_000, 10_000), 56_000);
    assert.equal(autofresh.idleRemainingMs(s(70), NOW, 60_000, 10_000), 0);
    assert.equal(autofresh.idleRemainingMs({ ...s(4), running: true }, NOW, 60_000, 10_000), undefined);
    assert.equal(autofresh.idleRemainingMs(undefined, NOW, 60_000, 10_000), undefined);
  });
});

describe("freshMode and plan", () => {
  it("keeps a handover for in-progress or blocked rows, blank otherwise", () => {
    assert.equal(freshMode(E1, []), "blank");
    assert.equal(freshMode(E1, [row("pending"), row("done")]), "blank");
    assert.equal(freshMode(E1, [row("in-progress", E2)]), "blank");
    assert.equal(freshMode(E1, [row("in-progress")]), "handover");
    assert.equal(freshMode(E1, [row("blocked")]), "handover");
    assert.deepEqual(freshPlan(input(), [row("blocked")]), { mode: "handover" });
    assert.deepEqual(freshPlan(input({ status: undefined }), []), { wait: "no context figure" });
  });
  it("lists the seat's open rows the way devrig fresh --blank checks them", () => {
    assert.deepEqual(openRowsCall(E1).args, ["queue", "list", `--destination=${E1}`, "--state=in-progress,blocked", "--json"]);
  });
});

describe("freshRequest", () => {
  it("runs the repo's devrig with the member name and a bare env", () => {
    const r = freshRequest(policy, E1, "blank", { USER: "me", AWS_PROFILE: "x", HOME: "/elsewhere", TERM: "xterm" });
    assert.equal(r.command, join(policy.rigRoot, "bin", "devrig"));
    assert.deepEqual(r.args, ["--rig", policy.rig.name, "fresh", "expert1", "--blank"]);
    assert.deepEqual(r.env, { HOME: policy.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", USER: "me", TERM: "xterm" });
    assert.ok(r.timeoutMs > 960_000);
    assert.deepEqual(freshRequest(policy, E2, "handover", {}).args, ["--rig", policy.rig.name, "fresh", "expert2"]);
  });
  it("reports failures with the last lines of output", () => {
    assert.equal(freshFailure(ok("restarted")), undefined);
    assert.equal(freshFailure(ok("a\nb\n", 1, "devrig: dev-expert1 has 1 in-progress or blocked rows\n")), "exit 1: a\nb\ndevrig: dev-expert1 has 1 in-progress or blocked rows");
    assert.equal(freshFailure({ ...ok(), timedOut: true }), "timed out: no output");
  });
});

describe("conversation-scoped refresh retries", () => {
  const old = { tokens: 170_000, running: false, at: ago(120), sessionId: "old" };
  const until = NOW.getTime() + 30 * 60_000;

  it("retains backoff for the same conversation despite new activity or a lower token count", () => {
    const retries = new autofresh.FreshRetries();
    retries.hold(E1, old, until);
    assert.equal(retries.until(E1, { ...old, tokens: 20_000, running: true, at: ago(1) }), until);
  });
  it("clears failed-launch backoff after verified manual replacement, even if the new conversation is exhausted", () => {
    const retries = new autofresh.FreshRetries();
    retries.hold(E1, old, until);
    assert.equal(retries.until(E1, { ...old, sessionId: "replacement" }), 0);
    assert.equal(retries.until(E1, old), 0);
  });
  it("does not infer replacement from missing status or legacy files", () => {
    const retries = new autofresh.FreshRetries();
    retries.hold(E1, old, until);
    assert.equal(retries.until(E1, undefined), until);
    assert.equal(retries.until(E1, input().status), until);
    retries.hold(E1, input().status, until);
    assert.equal(retries.until(E1, old), until);
  });
  it("keeps the successful-restart cooldown on the replacement conversation", () => {
    const retries = new autofresh.FreshRetries();
    const replacement = { ...old, sessionId: "replacement" };
    retries.hold(E1, replacement, until);
    assert.equal(retries.until(E1, replacement), until);
  });
  it("resets only the selected seat and keeps running and idle safeguards", () => {
    const retries = new autofresh.FreshRetries();
    retries.hold(E1, old, until);
    retries.hold(E2, old, until);
    retries.reset([E1]);
    assert.equal(retries.until(E1, old), 0);
    assert.equal(retries.until(E2, old), until);
    assert.deepEqual(freshDue(input({ status: { ...old, running: true } })), { wait: "running" });
    assert.deepEqual(freshDue(input({ status: { ...old, at: ago(10) } })), { wait: "idle 10s" });
    assert.deepEqual(freshPlan(input({ status: old }), [row("in-progress")]), { mode: "handover" });
    retries.reset([E1, E2]);
    assert.equal(retries.until(E2, old), 0);
  });
});

describe("autofresh command", () => {
  it("resolves only managed seats, including member aliases and full names", () => {
    const seats = [E1, E2];
    for (const target of ["expert1", "dev-expert1", E1]) {
      assert.deepEqual(autofresh.parseAutoFreshCommand(`retry ${target}`, seats), { kind: "retry", seats: [E1] });
    }
    assert.deepEqual(autofresh.parseAutoFreshCommand("retry", seats), { kind: "retry", seats });
    assert.deepEqual(autofresh.parseAutoFreshCommand("", seats), { kind: "show" });
    assert.deepEqual(autofresh.parseAutoFreshCommand("on", seats), { kind: "pause", paused: false });
    assert.deepEqual(autofresh.parseAutoFreshCommand("off", seats), { kind: "pause", paused: true });
    for (const args of ["retry lead", "retry dev-expert1@another-rig", "retry expert1 expert2", "on expert1", "reset"]) {
      assert.throws(() => autofresh.parseAutoFreshCommand(args, seats), /usage|managed/);
    }
  });
});

describe("blank before assignment", () => {
  const keyed = (task: string, created: number, state = "done", dest = E1): QueueRow => ({ ...row(state, dest), qitemId: `qitem-${task}-${created}`, tsCreated: ago(created), summary: `[${task}] work` });
  type Over = Partial<Omit<autofresh.AssignGateDeps, "status" | "rows">> & { status?: autofresh.ContextStatus | undefined | (() => autofresh.ContextStatus | undefined); rows?: readonly QueueRow[] };
  const run = async (over: Over = {}): Promise<{ line: string; blanks: number; rowReads: number }> => {
    let blanks = 0;
    let rowReads = 0;
    const { status: st, rows, ...rest } = over;
    const status = typeof st === "function" ? st : () => ("status" in over ? (st as autofresh.ContextStatus | undefined) : { tokens: 112_000, running: false, at: ago(120) });
    const line = await autofresh.assignGate({
      seat: E1,
      task: "mission-xmu4.3",
      blankTokens: 100_000,
      idleMs: 60_000,
      paused: false,
      restarting: () => false,
      now: () => NOW,
      status,
      rows: async () => {
        rowReads++;
        return rows ?? [keyed("mission-xmu4.1", 900)];
      },
      blank: async () => {
        blanks++;
        return undefined;
      },
      ...rest,
    });
    return { line, blanks, rowReads };
  };

  it("blanks an idle expert at 100k or more moving to a different task", async () => {
    assert.deepEqual(await run(), { line: "blanked first: 112k tokens, last task mission-xmu4.1", blanks: 1, rowReads: 1 });
    assert.equal((await run({ status: { tokens: 100_000, running: false, at: ago(120) } })).blanks, 1, "100k exactly counts");
    assert.equal((await run({ rows: [] })).line, "blanked first: 112k tokens, last task none");
  });

  it("treats an ask as different work, even after another ask", async () => {
    assert.equal((await run({ task: "ask", rows: [keyed("ask", 300)] })).blanks, 1);
  });

  it("keeps context for the same task, judged by the newest keyed row to this expert", async () => {
    const same = await run({ rows: [keyed("mission-xmu4.1", 900), keyed("mission-xmu4.3", 300)] });
    assert.deepEqual(same, { line: "kept context: same task mission-xmu4.3", blanks: 0, rowReads: 1 });
    const unkeyedNewer = { ...row("done"), qitemId: "qitem-peer", tsCreated: ago(60), summary: "review from expert2" };
    assert.equal((await run({ rows: [unkeyedNewer, keyed("mission-xmu4.3", 300)] })).blanks, 0);
    assert.equal((await run({ rows: [keyed("mission-xmu4.3", 300, "done", E2), keyed("mission-xmu4.1", 900)] })).blanks, 1, "another seat's rows do not count");
  });

  it("keeps context under the threshold, without a figure, while running or recently active", async () => {
    for (const [status, reason] of [
      [{ tokens: 99_999, running: false, at: ago(600) }, "99k < 100k"],
      [{ tokens: null, running: false, at: ago(600) }, "no context figure"],
      [undefined, "no context figure"],
      [{ tokens: 180_000, running: true, at: ago(600) }, "running"],
      [{ tokens: 180_000, running: false, at: ago(20) }, "idle 20s"],
    ] as const) {
      const r = await run({ status });
      assert.equal(r.blanks, 0, reason);
      assert.equal(r.rowReads, 0, `cheap checks first: ${reason}`);
      assert.match(r.line, /^kept context: /);
    }
    assert.equal((await run({ status: { tokens: 99_999, running: false, at: ago(600) } })).line, "kept context: 99k < 100k");
  });

  it("keeps context with open rows", async () => {
    const open = await run({ rows: [keyed("mission-xmu4.1", 900, "in-progress"), keyed("ask", 600, "blocked")] });
    assert.equal(open.line, "kept context: open rows qitem-mission-xmu4.1-900, qitem-ask-600");
    assert.equal(open.blanks, 0);
    assert.equal((await run({ rows: [keyed("mission-xmu4.1", 900, "pending")] })).blanks, 1, "a pending row is not in progress");
  });

  it("rechecks the context status after the queue read", async () => {
    let reads = 0;
    const status = (): autofresh.ContextStatus => (reads++ === 0 ? { tokens: 112_000, running: false, at: ago(120) } : { tokens: 112_000, running: true, at: NOW.toISOString() });
    const r = await run({ status });
    assert.equal(r.line, "kept context: running");
    assert.equal(r.blanks, 0);
  });

  it("stays out while autofresh is paused or already restarting the seat", async () => {
    assert.deepEqual(await run({ paused: true }), { line: "kept context: autofresh off", blanks: 0, rowReads: 0 });
    assert.deepEqual(await run({ restarting: () => true }), { line: "kept context: already restarting", blanks: 0, rowReads: 0 });
  });

  it("reports a failed reset or queue read without throwing", async () => {
    assert.equal((await run({ blank: async () => "exit 1: launch failed" })).line, "blank reset failed, context may be kept: exit 1: launch failed");
    const r = await autofresh.assignGate({
      seat: E1, task: "ask", blankTokens: 100_000, idleMs: 60_000, paused: false, restarting: () => false, now: () => NOW,
      status: () => ({ tokens: 112_000, running: false, at: ago(120) }),
      rows: async () => { throw new Error("daemon down"); },
      blank: async () => assert.fail("must not blank without the queue"),
    });
    assert.equal(r, "kept context: queue check failed: daemon down");
  });

  it("parses the task prefix and lists the expert's rows with history", () => {
    assert.equal(autofresh.rowTask("[mission-xmu4.3] Audit"), "mission-xmu4.3");
    assert.equal(autofresh.rowTask("[ask] check"), "ask");
    for (const s of [undefined, "Audit", "[Not A Task] x", "[mission-1]x"]) assert.equal(autofresh.rowTask(s), undefined, String(s));
    assert.deepEqual(autofresh.assignRowsCall(E1).args, ["queue", "list", `--destination=${E1}`, "--all", "--limit=100", "--json"]);
  });

  it("reads the threshold from the lead's autoFresh policy", () => {
    assert.equal(seatRole(policy, LEAD).autoFresh?.assignBlankTokens, 100_000);
  });
});

describe("footerEntry", () => {
  it("shows member, context and the reason it waits", () => {
    assert.equal(footerEntry(E1, { tokens: 162_400, running: false, at: NOW.toISOString() }, "running"), "expert1 162k (running)");
    assert.equal(footerEntry(E2, undefined, undefined), "expert2 ?");
  });
});

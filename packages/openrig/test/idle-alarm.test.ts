import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { idleExperts, hasActiveWork, idleReminder, workState, QUIET_REPEAT_MS, type Reminded } from "../src/idle-alarm.ts";
import type { ContextStatus } from "../src/autofresh.ts";

const now = Date.parse("2026-11-10T18:00:00Z");
const status = (age: number, running = false): ContextStatus => ({ tokens: 100, running, at: new Date(now - age).toISOString() });
const input = (age: number) => ({ now, idleMs: 120_000, repeatMs: 120_000, active: true, experts: [{ seat: "dev-expert1@devrig", status: status(age), restarting: false }], lastSent: new Map<string, Reminded>() });

describe("idle expert alarm", () => {
  it("fires at two minutes, not before", () => {
    assert.deepEqual(idleExperts(input(119_999)), []);
    assert.deepEqual(idleExperts(input(120_000)), ["dev-expert1@devrig"]);
  });
  it("repeats no sooner than two minutes after the previous reminder", () => {
    const sent = (ago: number, state = "a") => new Map([["dev-expert1@devrig", { at: now - ago, state }]]);
    assert.deepEqual(idleExperts({ ...input(600_000), lastSent: sent(119_999), state: "b" }), []);
    assert.equal(idleExperts({ ...input(600_000), lastSent: sent(120_000), state: "b" }).length, 1);
  });
  it("repeats in the same idle period only when the work changed, or after the quiet interval", () => {
    const sent = (ago: number) => new Map([["dev-expert1@devrig", { at: now - ago, state: "q1:pending:e1" }]]);
    assert.deepEqual(idleExperts({ ...input(3_600_000), lastSent: sent(300_000), state: "q1:pending:e1" }), []);
    assert.equal(idleExperts({ ...input(3_600_000), lastSent: sent(300_000), state: "q1:done:e1" }).length, 1);
    assert.equal(idleExperts({ ...input(3_600_000), lastSent: sent(QUIET_REPEAT_MS), state: "q1:pending:e1" }).length, 1);
    // Before the queue read the state is unknown, so the timing alone decides.
    assert.equal(idleExperts({ ...input(3_600_000), lastSent: sent(300_000) }).length, 1);
  });
  it("starts over when the seat worked since the last reminder", () => {
    // Reminded 10 minutes ago, idle for 3: a new idle period, so the first reminder goes out whatever the state.
    const lastSent = new Map([["dev-expert1@devrig", { at: now - 600_000, state: "s" }]]);
    assert.equal(idleExperts({ ...input(180_000), lastSent, state: "s" }).length, 1);
  });
  it("fingerprints only this rig's open rows, in a stable order", () => {
    const seats = ["lead", "e1", "e2"];
    const row = (qitemId: string, state: string, destinationSession = "e1", sourceSession = "lead") => ({ qitemId, state, sourceSession, destinationSession });
    assert.equal(workState(seats, [row("b", "pending"), row("a", "in-progress", "e2")]), "a:in-progress:e2,b:pending:e1");
    assert.equal(workState(seats, [row("a", "in-progress", "e2"), row("b", "pending")]), "a:in-progress:e2,b:pending:e1");
    assert.equal(workState(seats, [row("c", "done"), row("d", "pending", "x", "y")]), "");
    assert.equal(workState(seats, [row("e", "blocked")]), "e:blocked:e1");
  });
  it("leaves working, restarting and unknown seats alone", () => {
    for (const expert of [
      { seat: "e", status: status(600_000, true), restarting: false },
      { seat: "e", status: status(600_000), restarting: true },
      { seat: "e", status: undefined, restarting: false },
      { seat: "e", status: status(-1000), restarting: false },
    ]) assert.deepEqual(idleExperts({ ...input(600_000), experts: [expert] }), []);
  });
  it("reserves exhausted auto-managed seats for refresh, including failed-launch backoff", () => {
    const seat = "dev-expert1@devrig";
    const exhausted = { seat, status: { ...status(600_000), tokens: 170_000 }, restarting: false };
    assert.deepEqual(idleExperts({ ...input(600_000), experts: [exhausted], refresh: { seats: [seat], warnTokens: 150_000 } }), []);
  });
  it("still reminds for usable or non-auto-managed experts", () => {
    const seat = "dev-expert1@devrig";
    const refresh = { seats: [seat], warnTokens: 150_000 };
    for (const tokens of [null, 100, 150_000]) {
      assert.deepEqual(idleExperts({ ...input(600_000), experts: [{ seat, status: { ...status(600_000), tokens }, restarting: false }], refresh }), [seat]);
    }
    const exhausted = { seat, status: { ...status(600_000), tokens: 170_000 }, restarting: false };
    assert.deepEqual(idleExperts({ ...input(600_000), experts: [exhausted] }), [seat]);
    assert.deepEqual(idleExperts({ ...input(600_000), experts: [exhausted], refresh: { ...refresh, seats: ["another-seat"] } }), [seat]);
  });
  it("does not let one exhausted expert hide an ordinary idle reminder for the other", () => {
    const seat = "dev-expert1@devrig";
    const other = "dev-expert2@devrig";
    const experts = [
      { seat, status: { ...status(600_000), tokens: 170_000 }, restarting: false },
      { seat: other, status: status(600_000), restarting: false },
    ];
    assert.deepEqual(idleExperts({ ...input(600_000), experts, refresh: { seats: [seat, other], warnTokens: 150_000 } }), [other]);
  });
  it("does not wake a rig with no active work", () => {
    assert.deepEqual(idleExperts({ ...input(600_000), active: false }), []);
  });
  it("requires a running lead or a nonterminal queue row in this rig", () => {
    const seats = ["lead", "e1", "e2"];
    assert.equal(hasActiveWork({ leadWorking: false, seats, rows: [] }), false);
    assert.equal(hasActiveWork({ leadWorking: true, seats, rows: [] }), true);
    for (const state of ["pending", "in-progress"]) assert.equal(hasActiveWork({ leadWorking: false, seats, rows: [{ sourceSession: "lead", destinationSession: "e1", state }] }), true);
    for (const state of ["done", "failed", "handed-off", "canceled", "denied", "expired"]) assert.equal(hasActiveWork({ leadWorking: false, seats, rows: [{ sourceSession: "lead", destinationSession: "e1", state }] }), false);
    assert.equal(hasActiveWork({ leadWorking: false, seats, rows: [{ sourceSession: "foreign", destinationSession: "other", state: "pending" }] }), false);
  });
  it("does not count a row blocked on the operator (a merge, an approval) as active work", () => {
    const seats = ["lead", "e1", "e2"];
    const blocked = { sourceSession: "lead", destinationSession: "e1", state: "blocked" };
    assert.equal(hasActiveWork({ leadWorking: false, seats, rows: [blocked] }), false);
    assert.equal(hasActiveWork({ leadWorking: false, seats, rows: [blocked, { sourceSession: "lead", destinationSession: "e2", state: "in-progress" }] }), true);
  });
  it("groups both experts in a short reminder without granting approval", () => {
    const text = idleReminder(["dev-expert1@devrig", "dev-expert2@devrig"], 120);
    assert.match(text, /Use dev-expert1@devrig, dev-expert2@devrig/);
    assert.match(text, /approval gates still apply/);
  });
});

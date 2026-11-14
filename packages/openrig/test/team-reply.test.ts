import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactQueueReply, compactRow } from "../src/team.ts";

// Shape of a `rig queue claim --json` reply (OpenRig 2026-11), trimmed to the fields that matter here.
const row = (body = "Outcome: do the thing.\nSteps: 1. 2. 3.") => ({
  pickup: { state: "working" },
  waiting: { obligation: "qitem-1", owner: "e1", state: "in-progress", blocker: null, liveness: { activity: "working" }, nextBackstop: { owner: "lead", dueAt: "x" } },
  qitemId: "qitem-20261111084300-a0571dee3d5199a3",
  tsCreated: "2026-11-11T08:43:00.889Z",
  tsUpdated: "2026-11-11T08:47:06.312Z",
  sourceSession: "dev-lead@devrig",
  destinationSession: "dev-expert2@devrig",
  state: "in-progress",
  priority: "routine",
  tier: null,
  tags: ["mission:sample-refactor"],
  blockedOn: null,
  handedOffTo: null,
  chainOfRecord: null,
  body,
  summary: "Test: update the parser",
  humanQuestions: null,
  closureReason: null,
  claimedAt: "2026-11-11T08:47:06.312Z",
  lastNudgeAttempt: "2026-11-11T08:43:01.930Z",
  lastNudgeResult: "claimed",
  lastNudgeWireResult: "delivered-ack-pending",
  lastHeartbeat: null,
  resolution: null,
});

describe("team replies", () => {
  it("drops nudge metadata and empty fields, and collapses pickup and waiting", () => {
    const c = compactRow(row(), true);
    assert.deepEqual(Object.keys(c).sort(), ["body", "claimedAt", "destinationSession", "pickup", "priority", "qitemId", "sourceSession", "state", "summary", "tags", "tsCreated", "tsUpdated", "waiting"]);
    assert.equal(c.pickup, "working");
    assert.equal(c.waiting, "in-progress");
  });
  it("keeps a waiting blocker", () => {
    const r = { ...row(), waiting: { state: "blocked", blocker: { kind: "operator" } } };
    assert.deepEqual(compactRow(r, true).blocker, { kind: "operator" });
  });
  it("keeps the body for claim and show, and drops it where the seat already has it", () => {
    const body = "x".repeat(5000);
    for (const op of ["queue_claim", "queue_show"] as const) assert.equal(JSON.parse(compactQueueReply(op, JSON.stringify(row(body)))).body, body);
    for (const op of ["queue_create", "queue_update"] as const) {
      const out = JSON.parse(compactQueueReply(op, JSON.stringify(row(body))));
      assert.equal(out.body, undefined);
      assert.equal(out.bodyBytes, 5000);
      assert.equal(out.state, "in-progress");
    }
  });
  it("compacts both rows of a handoff", () => {
    const reply = JSON.stringify({ closed: { ...row("b".repeat(3000)), state: "done" }, created: { ...row("b".repeat(3000)), qitemId: "qitem-2", state: "pending" } });
    const out = JSON.parse(compactQueueReply("queue_handoff_complete", reply));
    assert.equal(out.closed.state, "done");
    assert.equal(out.created.qitemId, "qitem-2");
    assert.equal(out.closed.body, undefined);
    assert.ok(compactQueueReply("queue_handoff_complete", reply).length < reply.length / 2);
  });
  it("returns anything else unchanged", () => {
    assert.equal(compactQueueReply("queue_claim", "{\"closed\":{\"pickup\""), "{\"closed\":{\"pickup\"");
    assert.equal(compactQueueReply("queue_claim", "[1,2]"), "[1,2]");
    assert.equal(compactQueueReply("send", JSON.stringify(row())), JSON.stringify(row()));
    assert.equal(compactQueueReply("queue_show", "{\"ok\":true}"), "{\"ok\":true}");
  });
});

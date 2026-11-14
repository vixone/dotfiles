import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { busyItems } from "../src/rig-busy.ts";

const now = new Date("2026-11-09T22:00:00Z");
describe("busyItems", () => {
  it("is empty for idle or absent seats", () => {
    assert.deepEqual(busyItems({ now, seats: { "dev-expert1@devrig": { tokens: 1, running: false, at: "2026-11-09T21:59:00Z" }, "dev-lead@devrig": undefined } }), []);
  });
  it("names a seat mid-turn", () => {
    assert.deepEqual(busyItems({ now, seats: { "dev-expert2@devrig": { tokens: 1, running: true, at: "2026-11-09T21:55:00Z" } } }), ["dev-expert2@devrig is mid-turn (since 21:55Z)"]);
  });
  it("ignores a running flag older than two hours", () => {
    assert.deepEqual(busyItems({ now, seats: { "dev-expert1@devrig": { tokens: 1, running: true, at: "2026-11-09T19:30:00Z" } } }), []);
  });
});

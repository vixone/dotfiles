import assert from "node:assert/strict";
import { isRangedRead, budgetAction, capOutput, readStub } from "./budget.ts";
import contextBudget from "./index.ts";

assert.equal(budgetAction(null, false), "none");
assert.equal(budgetAction(150000, false), "none");
assert.equal(budgetAction(150001, false), "nudge");
assert.equal(budgetAction(150001, true), "none");
assert.equal(budgetAction(200001, true), "compact");
assert.equal(budgetAction(200001, false), "compact");
assert.equal(budgetAction(101, false, 100, 300), "nudge");
assert.equal(budgetAction(301, false, 100, 300), "compact");
assert.equal(budgetAction(300, true, 100, 300), "none");
assert.equal(capOutput("x".repeat(100), 16384).spilled, false);
const big = capOutput("a".repeat(20000), 16384, "/tmp/f.txt");
assert.ok(big.spilled && big.text.length < 13000 && big.text.includes("omitted"));
const c = new Map<string, { mtimeMs: number; size: number; turn: number }>();
assert.equal(readStub(c, "/a", { mtimeMs: 1, size: 2 }, 3, false), undefined);
assert.ok(readStub(c, "/a", { mtimeMs: 1, size: 2 }, 5, false)?.includes("unchanged since turn 3"));
assert.equal(readStub(c, "/a", { mtimeMs: 9, size: 2 }, 6, false), undefined);
const r = new Map<string, { mtimeMs: number; size: number; turn: number }>();
assert.equal(readStub(r, "/b", { mtimeMs: 1, size: 2 }, 1, true), undefined);
assert.equal(readStub(r, "/b", { mtimeMs: 1, size: 2 }, 2, true), undefined);
assert.equal(readStub(r, "/b", { mtimeMs: 1, size: 2 }, 3, false), undefined);
assert.equal(isRangedRead({}), false);
assert.equal(isRangedRead({ offset: 1, limit: 2000 }), false);
assert.equal(isRangedRead({ offset: 1 }), false);
assert.equal(isRangedRead({ offset: 40 }), true);
assert.equal(isRangedRead({ limit: 50 }), true);
assert.equal(isRangedRead({ offset: "1", limit: "2000" }), false);
{
	// While /continue runs (mission-stack:continue active) agent_end must not compact: compact() aborts the handover.
	const hooks = new Map<string, (e: unknown, ctx: unknown) => unknown>();
	const bus = new Map<string, (d: unknown) => void>();
	const pi = {
		on: (n: string, h: (e: unknown, ctx: unknown) => unknown) => hooks.set(n, h),
		events: { on: (t: string, h: (d: unknown) => void) => bus.set(t, h), emit: () => {} },
	};
	contextBudget(pi as never);
	let compacts = 0;
	const ctx = { hasUI: false, getContextUsage: () => ({ tokens: 250_000 }), compact: (o: { onComplete: () => void }) => { compacts++; o.onComplete(); } };
	bus.get("mission-stack:continue")!({ active: true });
	await hooks.get("agent_end")!({}, ctx);
	assert.equal(compacts, 0);
	bus.get("mission-stack:continue")!({ active: false });
	await hooks.get("agent_end")!({}, ctx);
	assert.equal(compacts, 1);
}
console.log("context-budget: ok");

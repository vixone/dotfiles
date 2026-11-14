import test from "node:test";
import assert from "node:assert/strict";

import { createCoordinator, type CoordinatorDeps } from "../modules/missions/extensions/mission-stack/context-coordinator.ts";
import { type ResolveResult, type EnvRecord } from "../modules/missions/extensions/mission-stack/environment-source.ts";
import { type ParseResult } from "../modules/missions/extensions/mission-stack/memory-contract.ts";

function envRecord(id: string): EnvRecord {
	return { id, title: id, aliases: [], scopes: [], sources: ["x"], verifiedAt: "2026-09-10", relations: [], body: "b", path: `${id}.md` };
}

function semanticEnvelope(hits: Array<{ key: string; score: number; type?: "lesson" | "mission_child" }>): ParseResult {
	return {
		ok: true,
		envelope: {
			contract_version: "memory-v1", command: "search", model: "m", embed_dims: 768, schema_version: "2",
			hits: hits.map((h) => ({
				type: h.type ?? "lesson", key: h.key, score: h.score, excerpt: `excerpt for ${h.key}`, provenance: "bd:lesson",
			})),
			error: null,
		},
	};
}

// Deps builder with controllable env + semantic behavior and a fake clock.
function makeDeps(over: Partial<CoordinatorDeps> = {}): CoordinatorDeps & { clock: { t: number } } {
	const clock = { t: 1_000 };
	return {
		clock,
		now: () => clock.t,
		envResolve: (_q: string): ResolveResult => ({ matchType: "none" }),
		renderEnv: (rec, scope) => `ENV ${rec.id}${scope ? "#" + scope.id : ""}`,
		semanticSearch: async () => semanticEnvelope([{ key: "lesson-a", score: 0.95 }]),
		...over,
	};
}

test("exact environment match precedes semantic (env-exact reason)", async () => {
	let semanticCalled = false;
	const deps = makeDeps({
		envResolve: (q) => (q === "aws-access" ? { matchType: "id", record: envRecord("aws-access"), stale: false } : { matchType: "none" }),
		semanticSearch: async () => {
			semanticCalled = true;
			return semanticEnvelope([{ key: "x", score: 0.99 }]);
		},
	});
	const c = createCoordinator(deps);
	const sel = await c.select("prompt", "aws-access");
	assert.equal(sel.inject, true);
	assert.equal(sel.reason, "env-exact");
	assert.equal(sel.items[0].kind, "environment");
	assert.equal(semanticCalled, false, "semantic must be skipped when env matches");
});

test("semantic fallback when no env match, gated by minSemanticScore", async () => {
	const c = createCoordinator(makeDeps({ semanticSearch: async () => semanticEnvelope([{ key: "lo", score: 0.60 }]) }));
	const sel = await c.select("prompt", "some topic");
	assert.equal(sel.inject, false);
	assert.equal(sel.reason, "no-match", "below-threshold hit is not applicable -> zero context");
});

test("unrelated query returns zero context", async () => {
	const c = createCoordinator(makeDeps({ semanticSearch: async () => semanticEnvelope([]) }));
	const sel = await c.select("prompt", "airspeed of an unladen swallow");
	assert.equal(sel.inject, false);
	assert.equal(sel.reason, "no-match");
	assert.equal(sel.items.length, 0);
});

test("repeated hits across hooks are deduped within a session", async () => {
	const c = createCoordinator(makeDeps());
	const first = await c.select("prompt", "topic one");
	assert.equal(first.inject, true);
	// A different hook, same top hit -> deduped.
	const second = await c.select("tool", "topic one");
	assert.equal(second.inject, false);
	assert.equal(second.reason, "deduped");
});

test("topic change retrieves fresh context", async () => {
	let q = "";
	const c = createCoordinator(makeDeps({
		semanticSearch: async (query) => {
			q = query;
			return semanticEnvelope([{ key: `hit-for-${query}`, score: 0.95 }]);
		},
	}));
	const a = await c.select("prompt", "topic A");
	const b = await c.select("prompt", "topic B");
	assert.equal(a.inject, true);
	assert.equal(b.inject, true);
	assert.equal(b.items[0].key, "hit-for-topic b");
	assert.equal(q, "topic b");
});

test("retrieval timeout degrades gracefully and is not cached (retry allowed)", async () => {
	let calls = 0;
	const c = createCoordinator(makeDeps({
		semanticSearch: async () => {
			calls++;
			if (calls === 1) throw new Error("timeout");
			return semanticEnvelope([{ key: "recovered", score: 0.95 }]);
		},
	}));
	const first = await c.select("error", "flaky query");
	assert.equal(first.inject, false);
	assert.equal(first.reason, "retrieval-timeout");
	// A failure must not suppress the retry.
	const second = await c.select("error", "flaky query");
	assert.equal(second.inject, true);
	assert.equal(second.items[0].key, "recovered");
});

test("server error envelope degrades without injecting", async () => {
	const c = createCoordinator(makeDeps({
		semanticSearch: async (): Promise<ParseResult> => ({ ok: false, error: "memory-server error [embed]: boom" }),
	}));
	const sel = await c.select("tool", "q");
	assert.equal(sel.inject, false);
	assert.equal(sel.reason, "retrieval-timeout");
});

test("token budget caps total injected context per session", async () => {
	let n = 0;
	const c = createCoordinator(makeDeps({
		config: { tokenBudget: 5, maxItemsPerSelection: 1 }, // ~ one small item (excerpt ~4 tokens)
		semanticSearch: async () => semanticEnvelope([{ key: `k${n++}`, score: 0.95 }]),
	}));
	const first = await c.select("prompt", `q${n}`);
	assert.equal(first.inject, true);
	// Budget spent -> next distinct query cannot inject.
	const second = await c.select("prompt", `q${n}`);
	assert.equal(second.inject, false);
	assert.equal(second.reason, "budget-exhausted");
});

test("resetSession rehydrates after resume/fork/compaction", async () => {
	const c = createCoordinator(makeDeps());
	await c.select("prompt", "topic one");
	assert.equal((await c.select("prompt", "topic one")).reason, "deduped");
	c.resetSession("compaction");
	const after = await c.select("prompt", "topic one");
	assert.equal(after.inject, true, "context should rehydrate after a session reset");
});

test("focused-mission change clears dedup", async () => {
	const c = createCoordinator(makeDeps());
	await c.select("prompt", "topic one");
	c.onFocusChange("mission-xyz");
	const after = await c.select("focus", "topic one");
	assert.equal(after.inject, true);
});

test("disabled coordinator injects nothing", async () => {
	const c = createCoordinator(makeDeps({ config: { enabled: false } }));
	const sel = await c.select("prompt", "aws-access");
	assert.equal(sel.inject, false);
	assert.equal(sel.reason, "disabled");
});

test("selection reasons are inspectable", async () => {
	const c = createCoordinator(makeDeps());
	await c.select("prompt", "topic one");
	await c.select("prompt", "");
	const reasons = c.recentDecisions().map((d) => d.reason);
	assert.ok(reasons.includes("semantic"));
	assert.ok(reasons.includes("empty-query"));
});

test("shared cache avoids a second semantic query within TTL", async () => {
	let calls = 0;
	const c = createCoordinator(makeDeps({
		semanticSearch: async () => {
			calls++;
			return semanticEnvelope([{ key: "cached-hit", score: 0.95 }]);
		},
	}));
	await c.select("prompt", "same topic");
	// Different hook, same query, within TTL -> served from cache (deduped),
	// no second semantic call.
	await c.select("file", "same topic");
	assert.equal(calls, 1, "semantic search should be cached across hooks in one turn");
});

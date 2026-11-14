import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseEnvelope, verdictBlocks, topHit } from "../modules/missions/extensions/mission-stack/memory-contract.ts";
import { loadEnvironmentRecords, resolve as resolveEnv, isStale } from "../modules/missions/extensions/mission-stack/environment-source.ts";
import { createCoordinator } from "../modules/missions/extensions/mission-stack/context-coordinator.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const fx = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");
const records: ReturnType<typeof loadEnvironmentRecords>["records"] = new Map();

// --- Producer -> client -> hook chain (mock producer = fixture envelopes). --

function coordinatorWith(semantic: (q: string) => string) {
	return createCoordinator({
		envResolve: (q) => resolveEnv(records, q),
		renderEnv: (rec, scope) => (scope ? `${rec.title} - ${scope.summary}` : rec.title),
		semanticSearch: async (q) => parseEnvelope(semantic(q), "search"),
		config: { minSemanticScore: 0.85, tokenBudget: 100000 },
	});
}

test("producer->client->hook: closed mission / body-only evidence flows through", async () => {
	const c = coordinatorWith(() => fx("search-envelope.json"));
	// A topic with no env match falls to semantic; the fixture's top hit is the
	// closed-mission child mission-l4w.27 carrying body evidence.
	const sel = await c.select("tool", "index coverage of closed epics");
	assert.equal(sel.inject, true);
	assert.equal(sel.reason, "semantic");
	assert.equal(sel.items[0].key, "mission-l4w.27");
	assert.match(sel.items[0].text, /index missing 83 of 104 epics/);
});

test("client parses the mission-v1 search envelope with a mission_child top hit", () => {
	const r = parseEnvelope(fx("search-envelope.json"), "search");
	assert.ok(r.ok);
	if (r.ok) assert.equal(topHit(r.envelope)?.key, "mission-l4w.27");
});

test("duplicate agreement: check-dup verdict is what the gate blocks", () => {
	const r = parseEnvelope(fx("checkdup-envelope.json"), "check-dup");
	assert.ok(r.ok);
	if (r.ok) {
		assert.equal(r.envelope.duplicate!.verdict, "merge");
		assert.equal(verdictBlocks(r.envelope.duplicate!.verdict), true);
	}
});

test("no-hit query returns zero context", async () => {
	const c = coordinatorWith(() =>
		JSON.stringify({ contract_version: "memory-v1", command: "search", model: "m", embed_dims: 768, schema_version: "2", hits: [], error: null }),
	);
	const sel = await c.select("prompt", "airspeed of an unladen swallow");
	assert.equal(sel.inject, false);
	assert.equal(sel.reason, "no-match");
});

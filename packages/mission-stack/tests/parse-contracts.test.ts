import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
	parseEnvelope,
	topHit,
	verdictBlocks,
	CONTRACT_VERSION,
} from "../modules/missions/extensions/mission-stack/memory-contract.ts";
import { topHitFromEnvelope } from "../modules/missions/extensions/mission-stack/memory-policy.ts";
import { filterStructuredHits } from "../modules/missions/extensions/mission-stack/first-contact.ts";
import { isEmptyMemoryResult } from "../modules/missions/extensions/mission-stack/memory-client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const searchJson = readFileSync(join(here, "fixtures", "search-envelope.json"), "utf8");

// --- Contract parsing (mission-927.8): JSON envelope replaces Markdown regex. ---

test("parseEnvelope accepts a valid memory-v1 search envelope", () => {
	const r = parseEnvelope(searchJson, "search");
	assert.ok(r.ok, `expected ok, got ${!r.ok && r.error}`);
	if (r.ok) {
		assert.equal(r.envelope.contract_version, CONTRACT_VERSION);
		assert.equal(r.envelope.model, "bge-base-en-v1.5");
		assert.equal(r.envelope.schema_version, "2");
		assert.equal(r.envelope.hits?.length, 3);
	}
});

test("parseEnvelope returns a diagnostic error on malformed JSON", () => {
	const r = parseEnvelope("{not json", "search");
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /malformed JSON/);
});

test("parseEnvelope rejects a version mismatch with a visible error", () => {
	const r = parseEnvelope(JSON.stringify({ contract_version: "memory-v0", command: "search", error: null }), "search");
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /contract version mismatch/);
});

test("parseEnvelope surfaces a server-side error field (no false success)", () => {
	const errEnv = JSON.stringify({ contract_version: "memory-v1", command: "search", error: { code: "open_db", message: "db locked" } });
	const r = parseEnvelope(errEnv, "search");
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /open_db.*db locked/);
});

test("parseEnvelope treats empty output as a diagnostic error", () => {
	const r = parseEnvelope("   ", "search");
	assert.equal(r.ok, false);
});

// --- Top hit spans lessons AND mission work (fixes the old L3 parse gap). ---

test("topHit returns the highest-scoring hit incl. mission work", () => {
	const r = parseEnvelope(searchJson, "search");
	assert.ok(r.ok);
	if (r.ok) {
		const top = topHit(r.envelope);
		assert.equal(top?.type, "mission_child");
		assert.equal(top?.key, "mission-l4w.27");
		assert.ok(Math.abs((top?.score ?? 0) - 0.9611) < 1e-6);
	}
});

test("memory-policy topHitFromEnvelope maps mission work to the L3 SearchHit", () => {
	const r = parseEnvelope(searchJson, "search");
	assert.ok(r.ok);
	if (r.ok) {
		const hit = topHitFromEnvelope(r.envelope);
		assert.equal(hit?.type, "mission");
		assert.equal(hit?.key, "mission-l4w.27");
		assert.equal(hit?.domain, "finding"); // child kind maps to domain slot
	}
});

test("first-contact filterStructuredHits keeps top hits, drops the memory domain", () => {
	const r = parseEnvelope(searchJson, "search");
	assert.ok(r.ok);
	if (r.ok) {
		const hits = filterStructuredHits(r.envelope.hits ?? []);
		const keys = hits.map((h) => h.key);
		assert.ok(keys.includes("mission-l4w.27"));
		assert.ok(keys.includes("eks-nodegroup-taint-rollout"));
		assert.ok(!keys.includes("memory-sync-coverage-closed-epics"), "memory-domain lesson must be dropped");
		assert.equal(hits[0].key, "mission-l4w.27"); // score-sorted
	}
});

// --- Verdict helper. ---

test("verdictBlocks blocks merge/likely, allows related/none", () => {
	assert.equal(verdictBlocks("merge"), true);
	assert.equal(verdictBlocks("likely"), true);
	assert.equal(verdictBlocks("related"), false);
	assert.equal(verdictBlocks("none"), false);
});

// --- Still-valid Markdown sentinel helper (used by human-output consumers). ---

test("isEmptyMemoryResult recognizes the no-result sentinels", () => {
	assert.equal(isEmptyMemoryResult(""), true);
	assert.equal(isEmptyMemoryResult("No relevant prior art found."), true);
	assert.equal(isEmptyMemoryResult("_No graph footprint for this query._"), true);
	assert.equal(isEmptyMemoryResult("## Related Lessons\n- something"), false);
});

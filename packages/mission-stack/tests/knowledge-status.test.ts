import test from "node:test";
import assert from "node:assert/strict";

import { buildStatus, renderStatus, explainSelection, type StatusInput } from "../modules/missions/extensions/mission-stack/knowledge-status.ts";
import { loadStackConfig, resolveConfigSources, isL3Enabled } from "../modules/missions/extensions/mission-stack/stack-config.ts";
import { type MemoryStatus } from "../modules/missions/extensions/mission-stack/memory-contract.ts";

function status(over: Partial<MemoryStatus> = {}): MemoryStatus {
	return {
		indexed: true, lessons: 340, children: 120, missions: 20, similar_edges: 90, related_edges: 200,
		last_sync_ts: "2026-09-10T00:00:00Z", sync_status: "complete", embed_model: "bge-base-en-v1.5",
		embed_dims: "768", index_schema_version: "2", ...over,
	};
}

function input(over: Partial<StatusInput> = {}): StatusInput {
	return {
		config: loadStackConfig({}),
		l3Enabled: false,
		modules: [{ name: "first-contact", enabled: true }, { name: "context-coordinator", enabled: true }],
		environment: { records: ["aws-access", "networking"], errors: [] },
		server: { ok: true, status: status() },
		...over,
	};
}

test("healthy status has no failures and reports coverage + identity", () => {
	const r = buildStatus(input());
	assert.deepEqual(r.failures, []);
	assert.ok(!("error" in r.coverage) && r.coverage.lessons === 340);
	assert.ok(!("error" in r.identity) && r.identity.model === "bge-base-en-v1.5");
});

test("disabled L3 is obvious in the report", () => {
	const r = buildStatus(input({ l3Enabled: false }));
	assert.equal(r.l3Enabled, false);
	assert.match(renderStatus(r), /L3 auto-inject: OFF/);
});

test("missing index coverage is an actionable failure (no write/embed)", () => {
	const r = buildStatus(input({ server: { ok: true, status: status({ indexed: false }) } }));
	assert.ok("error" in r.coverage);
	assert.ok(r.failures.some((f) => /index not built/.test(f)));
});

test("partial reconciliation is surfaced", () => {
	const r = buildStatus(input({ server: { ok: true, status: status({ sync_status: "partial" }) } }));
	assert.ok(r.failures.some((f) => /partial/.test(f)));
});

test("schema mismatch between index and binary is flagged", () => {
	const r = buildStatus(input({ server: { ok: true, status: status({ index_schema_version: "1" }) }, binarySchemaVersion: "2" }));
	assert.ok(!("error" in r.identity) && r.identity.schemaMatch === false);
	assert.ok(r.failures.some((f) => /schema v1 != binary schema v2/.test(f)));
});

test("server unavailable degrades to an actionable failure", () => {
	const r = buildStatus(input({ server: { ok: false, error: "db locked" } }));
	assert.ok("error" in r.coverage);
	assert.ok(r.failures.some((f) => /status unavailable/.test(f)));
});

test("zero environment records is flagged (semantic-only)", () => {
	const r = buildStatus(input({ environment: { records: [], errors: [] } }));
	assert.ok(r.failures.some((f) => /no environment records/.test(f)));
});

test("environment load errors are surfaced", () => {
	const r = buildStatus(input({ environment: { records: ["aws-access"], errors: ["networking.md: dangling relation"] } }));
	assert.ok(r.failures.some((f) => /dangling relation/.test(f)));
});

test("explain identifies selection/skip reasons", () => {
	assert.match(explainSelection("env-exact"), /environment fact/);
	assert.match(explainSelection("no-match"), /zero context/);
	assert.match(explainSelection("budget-exhausted"), /budget/);
	assert.match(explainSelection("retrieval-timeout"), /retryable/);
});

// --- config precedence ---

test("config precedence marks env overrides vs defaults", () => {
	const def = resolveConfigSources({});
	assert.equal(def.tokenBudget.source, "default");
	const overridden = resolveConfigSources({ MS_CONTEXT_TOKEN_BUDGET: "500" });
	assert.equal(overridden.tokenBudget.source, "env");
	assert.equal(overridden.tokenBudget.value, 500);
});

test("L3 is off by default and on only with the explicit env flag", () => {
	assert.equal(isL3Enabled({}), false);
	assert.equal(isL3Enabled({ MS_AUTO_INJECT_ENABLED: "1" }), true);
});

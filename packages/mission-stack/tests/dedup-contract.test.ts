import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseEnvelope, verdictBlocks, DUP_TIERS } from "../modules/missions/extensions/mission-stack/memory-contract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const contracts = JSON.parse(readFileSync(join(fixtures, "contracts.json"), "utf8"));
const checkdupJson = readFileSync(join(fixtures, "checkdup-envelope.json"), "utf8");

// --- Unified duplicate contract (mission-927.8). ---

test("DUP_TIERS matches the canonical (Go) tier set", () => {
	const c = contracts.duplicate_tiers.canonical;
	assert.equal(DUP_TIERS.merge, c.merge);
	assert.equal(DUP_TIERS.likely, c.likely);
	assert.equal(DUP_TIERS.related, c.related);
});

test("advertised tool tiers equal the canonical tiers (no more drift)", () => {
	const adv = contracts.duplicate_tiers.advertised_in_tool_description;
	const c = contracts.duplicate_tiers.canonical;
	assert.equal(adv.merge, c.merge);
	assert.equal(adv.likely, c.likely);
	assert.equal(adv.related, c.related);
});

test("check-dup envelope carries the shared verdict + tiers", () => {
	const r = parseEnvelope(checkdupJson, "check-dup");
	assert.ok(r.ok);
	if (r.ok) {
		const dup = r.envelope.duplicate!;
		assert.equal(dup.verdict, "merge");
		assert.equal(dup.tiers.merge, DUP_TIERS.merge);
		assert.equal(dup.tiers.likely, DUP_TIERS.likely);
		// The write gate blocks exactly the verdict the preview reports.
		assert.equal(verdictBlocks(dup.verdict), true);
	}
});

test("write gate blocks on the same verdict tiers the preview advertises", () => {
	// Preview -> gate agreement: merge & likely block; related & none pass.
	assert.equal(contracts.duplicate_tiers.write_gate.blocks_on.includes("merge"), true);
	assert.equal(contracts.duplicate_tiers.write_gate.blocks_on.includes("likely"), true);
	assert.equal(contracts.duplicate_tiers.write_gate.blocks_on.includes("related"), false);
});

// --- Filters forwarded end-to-end. ---

test("search filters are advertised and forwarded identically", () => {
	assert.deepEqual(
		contracts.search_filters.advertised_params,
		contracts.search_filters.forwarded_to_binary,
	);
});

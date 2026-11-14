import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

// The required passing runner smoke test (per mission-927.6). Proves the
// tsx --test harness executes and the fixtures directory is wired up.
test("fixture runner", () => {
	assert.equal(1 + 1, 2);
});

test("fixtures are present and parseable", () => {
	const search = readFileSync(join(fixtures, "go-search-output.txt"), "utf8");
	assert.ok(search.includes("Related Lessons"));

	const contracts = JSON.parse(readFileSync(join(fixtures, "contracts.json"), "utf8"));
	assert.ok(contracts.duplicate_tiers);
});

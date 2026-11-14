import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
	loadEnvironmentRecords,
	resolve,
	isStale,
	parseFrontmatter,
	validateRecord,
} from "../modules/missions/extensions/mission-stack/environment-source.ts";

const here = dirname(fileURLToPath(import.meta.url));

function tmpEnv(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "env-src-"));
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

test("rejects duplicate record ids", () => {
	const dir = tmpEnv({
		"a.md": "---\nid: dup\ntitle: First record\nsources: [x]\nverified_at: 2026-01-01\n---\nbody",
		"b.md": "---\nid: dup\ntitle: Second record\nsources: [y]\nverified_at: 2026-01-01\n---\nbody",
	});
	try {
		const { errors } = loadEnvironmentRecords(dir);
		assert.ok(errors.some((e) => /duplicate record id/.test(e)), errors.join("; "));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rejects dangling relation targets", () => {
	const dir = tmpEnv({
		"a.md": "---\nid: alpha\ntitle: Alpha record\nsources: [x]\nverified_at: 2026-01-01\nrelations:\n  - type: relates-to\n    target: ghost\n---\nbody",
	});
	try {
		const { errors } = loadEnvironmentRecords(dir);
		assert.ok(errors.some((e) => /dangling relation target "ghost"/.test(e)), errors.join("; "));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rejects malformed scope and missing sources", () => {
	const fm = parseFrontmatter(
		"id: bad\ntitle: Bad record\nverified_at: 2026-01-01\nscopes:\n  - id: OK_BAD\n    summary: x",
	);
	const { record, errors } = validateRecord(fm, "bad.md");
	assert.equal(record, undefined);
	assert.ok(errors.some((e) => /at least one source is required/.test(e)));
	assert.ok(errors.some((e) => /invalid scope id/.test(e)));
	assert.ok(errors.some((e) => /missing summary/.test(e)) || errors.some((e) => /scope/.test(e)));
});

test("rejects executable command syntax in metadata", () => {
	const fm = parseFrontmatter(
		'id: cmd\ntitle: "Bad $(rm -rf) title"\nsources: [x]\nverified_at: 2026-01-01',
	);
	const { errors } = validateRecord(fm, "cmd.md");
	assert.ok(errors.some((e) => /executable command syntax/.test(e)), errors.join("; "));
});

// --- Frontmatter parser subset. ---

test("parseFrontmatter handles scalars, inline arrays and block maps", () => {
	const fm = parseFrontmatter(
		"id: x\naliases: [a, b, c]\nscopes:\n  - id: s1\n    aliases: [p]\n    summary: hello\nsources:\n  - one\n  - two",
	);
	assert.equal(fm.id, "x");
	assert.deepEqual(fm.aliases, ["a", "b", "c"]);
	assert.deepEqual(fm.sources, ["one", "two"]);
	assert.equal((fm.scopes as any[])[0].id, "s1");
	assert.deepEqual((fm.scopes as any[])[0].aliases, ["p"]);
});

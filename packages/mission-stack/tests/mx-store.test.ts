import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MxStoreMissing, defaultMxDb, openStore } from "../modules/missions/lib/mx-store.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = readFileSync(join(repo, "modules/missions/mx/src/schema.sql"), "utf8");

/** A temp mx.db built from the real schema, the way mx itself creates it. */
function seed(): string {
	const path = join(mkdtempSync(join(tmpdir(), "mx-store-")), "mx.db");
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);
	db.exec("insert into meta values ('schema_version','1')");
	const issue = db.prepare(
		`insert into issues(id, title, description, notes, status, priority, issue_type, parent_id, created_at, updated_at, close_reason)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	issue.run("mission-aaaa", "Alpha sidebar epic", "alpha desc", "n1\nn2", "in_progress", 1, "epic", null, "2026-10-01T00:00:00Z", "2026-10-30T10:00:00Z", null);
	issue.run("mission-bbbb", "Beta epic", "", "", "open", 2, "epic", null, "2026-10-02T00:00:00Z", "2026-10-29T10:00:00Z", null);
	issue.run("mission-cccc", "Gamma done", "", "", "closed", 2, "epic", null, "2026-10-03T00:00:00Z", "2026-10-28T10:00:00Z", "Done");
	issue.run("mission-aaaa.1", "child one", "", "", "open", 2, "task", "mission-aaaa", "2026-10-01T01:00:00Z", "2026-10-01T01:00:00Z", null);
	issue.run("mission-aaaa.2", "child two", "", "", "closed", 2, "task", "mission-aaaa", "2026-10-01T02:00:00Z", "2026-10-01T02:00:00Z", "ok");
	issue.run("mission-aaaa.10", "child ten", "", "", "open", 2, "task", "mission-aaaa", "2026-10-01T03:00:00Z", "2026-10-01T03:00:00Z", null);
	issue.run("mission-aaaa.1.1", "grandchild", "", "", "blocked", 2, "task", "mission-aaaa.1", "2026-10-01T04:00:00Z", "2026-10-01T04:00:00Z", null);
	const label = db.prepare("insert into labels values (?, ?)");
	label.run("mission-aaaa", "sidebar");
	label.run("mission-aaaa", "alpha");
	db.prepare("insert into comments(issue_id, author, text, created_at) values (?, ?, ?, ?)").run(
		"mission-aaaa", "tester", "first comment", "2026-10-30T09:00:00Z",
	);
	db.close();
	return path;
}

test("defaultMxDb honors MX_DB, else ~/.missions/mx.db", () => {
	assert.equal(defaultMxDb({ MX_DB: "/x/y.db" }), "/x/y.db");
	assert.match(defaultMxDb({ HOME: "/home/u" }), /\/\.missions\/mx\.db$/);
});

test("openStore without a path uses MX_DB and opens read-only", () => {
	const path = seed();
	const prev = process.env.MX_DB;
	process.env.MX_DB = path;
	try {
		const store = openStore();
		assert.equal(store.path, path);
		assert.throws(() => store.db.exec("insert into meta values ('k','v')"), /readonly|read-only/i);
	} finally {
		if (prev === undefined) delete process.env.MX_DB;
		else process.env.MX_DB = prev;
	}
});

test("listEpics returns open epics, or all with includeClosed", () => {
	const store = openStore(seed());
	const open = store.listEpics();
	assert.deepEqual(open.map((e) => e.id), ["mission-aaaa", "mission-bbbb"]);
	assert.deepEqual(Object.keys(open[0]).sort(), ["id", "status", "title", "updated_at"]);
	assert.equal(open[0].status, "in_progress");
	assert.deepEqual(store.listEpics({ includeClosed: true }).map((e) => e.id).sort(), ["mission-aaaa", "mission-bbbb", "mission-cccc"]);
});

test("listUnclosed returns id, parent and status of every non-closed issue", () => {
	const store = openStore(seed());
	const rows = store.listUnclosed();
	assert.equal(rows.length, 5);
	assert.deepEqual(rows.find((r) => r.id === "mission-aaaa.1.1"), { id: "mission-aaaa.1.1", parent: "mission-aaaa.1", status: "blocked" });
	assert.equal(rows.find((r) => r.id === "mission-aaaa")?.parent, null);
});

test("showIssue returns the issue with labels, notes and comments, or null", () => {
	const store = openStore(seed());
	const issue = store.showIssue("mission-aaaa");
	assert.ok(issue);
	assert.equal(issue.title, "Alpha sidebar epic");
	assert.equal(issue.issue_type, "epic");
	assert.equal(issue.notes, "n1\nn2");
	assert.deepEqual(issue.labels, ["alpha", "sidebar"]);
	assert.deepEqual(issue.comments.map((c) => [c.author, c.text]), [["tester", "first comment"]]);
	assert.equal(store.showIssue("mission-aaaa.1")?.parent, "mission-aaaa");
	assert.equal(store.showIssue("mission-zzzz"), null);
});

test("children are direct children in numeric id order", () => {
	const store = openStore(seed());
	assert.deepEqual(store.children("mission-aaaa").map((c) => c.id), ["mission-aaaa.1", "mission-aaaa.2", "mission-aaaa.10"]);
	assert.deepEqual(store.children("mission-zzzz"), []);
});

test("searchEpics matches title or id, case-insensitive", () => {
	const store = openStore(seed());
	assert.deepEqual(store.searchEpics("SIDEBAR").map((e) => e.id), ["mission-aaaa"]);
	assert.deepEqual(store.searchEpics("bbbb").map((e) => e.id), ["mission-bbbb"]);
	assert.deepEqual(store.searchEpics("gamma").map((e) => e.id), []);
	assert.deepEqual(store.searchEpics("gamma", { includeClosed: true }).map((e) => e.id), ["mission-cccc"]);
	assert.deepEqual(store.searchEpics("50%_").map((e) => e.id), [], "LIKE wildcards are literal");
});

test("a missing db throws MxStoreMissing with the path", () => {
	const path = join(mkdtempSync(join(tmpdir(), "mx-none-")), "mx.db");
	assert.throws(() => openStore(path), (err: unknown) => err instanceof MxStoreMissing && err.path === path && err.message.includes(path));
});

test("openStore caches per path and sees later commits", () => {
	const path = seed();
	const a = openStore(path);
	assert.equal(openStore(path), a);
	const w = new DatabaseSync(path);
	w.prepare("update issues set title='Renamed' where id='mission-bbbb'").run();
	w.close();
	assert.equal(a.listEpics().find((e) => e.id === "mission-bbbb")?.title, "Renamed");
});

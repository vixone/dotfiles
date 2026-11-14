import test from "node:test";
import assert from "node:assert/strict";

import {
	buildMissionTree,
	buildRecentList,
	flattenTree,
	formatStamp,
	openDescendants,
	targetOf,
	type Epic,
	type SessionRow,
} from "../modules/sessions/extensions/sidebar/tree.ts";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function row(path: string, linked: string[], minutesAgo: number): SessionRow {
	return { path, cwd: "/w", title: `t-${path}`, model: "m", linked, updated: at(minutesAgo) };
}

const epics: Epic[] = [
	{ id: "mission-a1", title: "Alpha", status: "open" },
	{ id: "mission-b22", title: "Beta", status: "in_progress" },
	{ id: "mission-c3", title: "Gamma", status: "closed" },
];

test("groups sessions by linked mission, newest mission first", () => {
	const tree = buildMissionTree(
		[row("a-old", ["mission-a1"], 300), row("b", ["mission-b22"], 60), row("a-new", ["mission-a1"], 30)],
		epics,
		{ now: NOW },
	);
	assert.deepEqual(tree.map((m) => m.id), ["mission-a1", "mission-b22"]);
	assert.deepEqual(tree[0].sessions.map((s) => s.path), ["a-new", "a-old"]);
	assert.equal(tree[0].title, "Alpha");
});

test("hides closed missions unless asked and drops unknown ids", () => {
	const sessions = [row("c", ["mission-c3"], 10), row("x", ["mission-zzz"], 5)];
	assert.deepEqual(buildMissionTree(sessions, epics, { now: NOW }), []);
	const withClosed = buildMissionTree(sessions, epics, { now: NOW, includeClosed: true });
	assert.deepEqual(withClosed.map((m) => m.id), ["mission-c3"]);
});

test("caps missions and sessions but keeps the total", () => {
	const many = Array.from({ length: 8 }, (_, i) => row(`a${i}`, ["mission-a1"], i + 10));
	const tree = buildMissionTree([...many, row("b", ["mission-b22"], 500)], epics, {
		now: NOW,
		maxMissions: 1,
		maxSessions: 3,
	});
	assert.equal(tree.length, 1);
	assert.equal(tree[0].sessions.length, 3);
	assert.equal(tree[0].total, 8);
});

test("flags the current session and recent foreign sessions as live", () => {
	const tree = buildMissionTree(
		[row("mine", ["mission-a1"], 0), row("other", ["mission-a1"], 1), row("idle", ["mission-a1"], 30)],
		epics,
		{ now: NOW, currentPath: "mine" },
	);
	const byPath = Object.fromEntries(tree[0].sessions.map((s) => [s.path, s]));
	assert.equal(byPath.mine.current, true);
	assert.equal(byPath.mine.live, false);
	assert.equal(byPath.other.live, true);
	assert.equal(byPath.idle.live, false);
});

test("a session linked to two missions shows under both", () => {
	const tree = buildMissionTree([row("both", ["mission-a1", "mission-b22"], 5)], epics, { now: NOW });
	assert.deepEqual(tree.map((m) => m.id).sort(), ["mission-a1", "mission-b22"]);
});

test("flatten expands only chosen missions; mission row targets newest session", () => {
	const tree = buildMissionTree(
		[row("a2", ["mission-a1"], 20), row("a1", ["mission-a1"], 40), row("b", ["mission-b22"], 60)],
		epics,
		{ now: NOW },
	);
	const collapsed = flattenTree(tree, new Set());
	assert.deepEqual(collapsed.map((r) => r.kind), ["mission", "mission"]);
	assert.equal(targetOf(collapsed[0]).path, "a2");

	const open = flattenTree(tree, new Set(["mission-a1"]));
	assert.deepEqual(open.map((r) => (r.kind === "session" ? r.session.path : r.mission.id)), [
		"mission-a1",
		"a2",
		"a1",
		"mission-b22",
	]);
	assert.equal(targetOf(open[2]).path, "a1");
});

test("formats today as HH:MM and older days as dd.MM", () => {
	const today = new Date(NOW);
	today.setHours(9, 5, 0, 0);
	assert.equal(formatStamp(today.getTime(), NOW), "09:05");
	const older = new Date(NOW);
	older.setDate(older.getDate() - 3);
	assert.match(formatStamp(older.getTime(), NOW), /^\d{2}\.\d{2}$/);
	assert.equal(formatStamp(0, NOW), "--.--");
});

test("recent lists unlinked sessions newest first plus the current one", () => {
	const list = buildRecentList(
		[row("linked", ["mission-a1"], 1), row("old", [], 300), row("mine", ["mission-a1"], 2), row("new", [], 5)],
		{ now: NOW, currentPath: "mine" },
	);
	assert.deepEqual(list.map((s) => s.path), ["mine", "new", "old"]);
	assert.equal(list[0].current, true);
});

test("recent caps after filtering and flags live sessions", () => {
	const many = Array.from({ length: 40 }, (_, i) => row(`u${i}`, [], i));
	const list = buildRecentList(many, { now: NOW });
	assert.equal(list.length, 30);
	assert.equal(list[0].live, true);
	assert.equal(list[5].live, false);
	assert.equal(buildRecentList(many, { now: NOW, limit: 4 }).length, 4);
});

test("recent query ANDs case-insensitive keywords over the search text", () => {
	const sessions = [
		{ ...row("argo", [], 10), searchText: "Fix ArgoCD Grafana alerts" },
		{ ...row("envoy", [], 20), searchText: "Envoy gateway grafana dashboards" },
		{ ...row("bare", [], 30), title: "grafana notes", cwd: "/w/obs" },
	];
	const paths = (query: string) => buildRecentList(sessions, { now: NOW, query }).map((s) => s.path);
	assert.deepEqual(paths("GRAFANA"), ["argo", "envoy", "bare"]);
	assert.deepEqual(paths("grafana  argocd"), ["argo"]);
	assert.deepEqual(paths("obs"), ["bare"], "falls back to title and cwd without searchText");
	assert.deepEqual(paths("nothing-here"), []);
	assert.deepEqual(paths("   "), ["argo", "envoy", "bare"]);
});

test("open descendants walk parent links, deepest first, skipping closed", () => {
	const issues = [
		{ id: "mission-a1", status: "open" },
		{ id: "mission-a1.1", parent: "mission-a1", status: "open" },
		{ id: "mission-a1.1.1", parent: "mission-a1.1", status: "in_progress" },
		{ id: "mission-a1.2", parent: "mission-a1", status: "closed" },
		{ id: "mission-zz.9", parent: "mission-a1", status: "blocked" },
		{ id: "mission-b22.1", parent: "mission-b22", status: "open" },
	];
	assert.deepEqual(openDescendants(issues, "mission-a1"), ["mission-a1.1.1", "mission-a1.1", "mission-zz.9"]);
	assert.deepEqual(openDescendants(issues, "mission-c3"), []);
});

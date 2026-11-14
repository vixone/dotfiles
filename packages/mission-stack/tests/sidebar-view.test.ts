import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { buildMissionTree, type RecentRow, type SessionNode, type SessionRow } from "../modules/sessions/extensions/sidebar/tree.ts";
import { SidebarView, type KeybindingsLike, type MissionActions, type ThemeLike } from "../modules/sessions/extensions/sidebar/view.ts";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const theme: ThemeLike = { fg: (_t, text) => `\x1b[2m${text}\x1b[0m`, bold: (text) => text };
const KEYS = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", tab: "\t" };
const keybindings: KeybindingsLike = {
	matches: (data, action) =>
		({
			"tui.select.up": KEYS.up,
			"tui.select.down": KEYS.down,
			"tui.select.confirm": KEYS.enter,
			"tui.select.cancel": KEYS.esc,
		})[action] === data,
};

function missions() {
	const row = (path: string, linked: string[], min: number, title = path): SessionRow => ({
		path, cwd: "/w", title, model: "m", linked, updated: new Date(NOW - min * 60_000).toISOString(),
	});
	return buildMissionTree(
		[
			row("a-new", ["mission-xmu4"], 10, "Resume alerting with a very long title that must be truncated 🚀 宽字符"),
			row("a-old", ["mission-xmu4"], 600),
			row("b", ["mission-41vx"], 60),
		],
		[
			{ id: "mission-xmu4", title: "ArgoCD alerting", status: "in_progress" },
			{ id: "mission-41vx", title: "Envoy switch", status: "open" },
		],
		{ now: NOW },
	);
}

function setup(rows = 40, missionActions?: MissionActions, openInNewTab?: (s: SessionNode) => Promise<void>) {
	const events: { picked?: SessionNode; cancelled: boolean; toggles: boolean[] } = { cancelled: false, toggles: [] };
	const view = new SidebarView({
		missionActions,
		openInNewTab,
		theme,
		keybindings,
		getRows: () => rows,
		now: () => NOW,
		onPick: (s) => (events.picked = s),
		onCancel: () => (events.cancelled = true),
		onToggleClosed: (v) => events.toggles.push(v),
		requestRender: () => {},
	});
	return { view, events };
}

test("every rendered line fits the width, including wide chars", () => {
	const { view } = setup();
	view.setState({ kind: "ready", missions: missions() });
	view.handleInput(KEYS.right);
	for (const width of [40, 80, 200]) {
		const lines = view.render(width);
		assert.ok(lines.length >= 5, `width ${width}: header, rows, hint, footer`);
		for (const line of lines) assert.equal(visibleWidth(line), width, `width ${width}: ${JSON.stringify(line)}`);
	}
});

test("loading and error states render inside the frame", () => {
	const { view } = setup();
	assert.match(view.render(60).join("\n"), /Loading sessions/);
	view.setState({ kind: "error", message: "mx list failed: boom" });
	assert.match(view.render(60).join("\n"), /mx list failed: boom/);
});

test("enter on a mission resumes its newest session", () => {
	const { view, events } = setup();
	view.setState({ kind: "ready", missions: missions() });
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "a-new");
});

test("expand, step into children, pick an older session", () => {
	const { view, events } = setup();
	view.setState({ kind: "ready", missions: missions() });
	view.handleInput(KEYS.right); // expand xmu4
	view.handleInput(KEYS.right); // move to first child
	view.handleInput(KEYS.down); // second child
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "a-old");
});

test("left on a child collapses back to its mission", () => {
	const { view, events } = setup();
	view.setState({ kind: "ready", missions: missions() });
	view.handleInput(KEYS.right);
	view.handleInput(KEYS.down);
	view.handleInput(KEYS.left);
	view.handleInput(KEYS.down); // now on 41vx, not a child row
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "b");
});

test("c toggles closed missions and esc cancels", () => {
	const { view, events } = setup();
	view.setState({ kind: "ready", missions: missions() });
	view.handleInput("c");
	view.handleInput("c");
	assert.deepEqual(events.toggles, [true, false]);
	view.handleInput(KEYS.esc);
	assert.equal(events.cancelled, true);
});

test("body scrolls to keep the cursor visible on short terminals", () => {
	const { view } = setup(6); // body height clamps to 3 rows
	const many = buildMissionTree(
		Array.from({ length: 10 }, (_, i) => ({
			path: `p${i}`, cwd: "/w", title: `s${i}`, model: "m", linked: [`mission-m${i}x`],
			updated: new Date(NOW - i * 60_000).toISOString(),
		})),
		Array.from({ length: 10 }, (_, i) => ({ id: `mission-m${i}x`, title: `M${i}`, status: "open" })),
		{ now: NOW },
	);
	view.setState({ kind: "ready", missions: many });
	for (let i = 0; i < 7; i++) view.handleInput(KEYS.down);
	const text = view.render(50).join("\n");
	assert.match(text, /M7/);
	assert.doesNotMatch(text, /M0/);
});

function recent(): RecentRow[] {
	const row = (path: string, linked: string[], min: number, title: string, cwd: string, searchText?: string): RecentRow => ({
		path, cwd, title, model: "m", linked, updated: new Date(NOW - min * 60_000).toISOString(), searchText,
	});
	return [
		row("mine", ["mission-xmu4"], 1, "Current work", "/Users/me/.pi"),
		row("loose", [], 30, "Debug kubectl auth with a very long title that needs truncating 🚀 宽字符", "/Users/me/sandbox/my-gitops-repo", "kubectl token expired grafana"),
		row("other", [], 90, "Write release notes", "/Users/me/notes", "changelog draft"),
		row("tied", ["mission-41vx"], 5, "Linked only", "/w"),
	];
}

function ready(view: SidebarView) {
	view.setState({ kind: "ready", missions: missions(), recent: recent(), currentPath: "mine" });
}

test("tab switches to recent: unlinked sessions plus the current one", () => {
	const { view } = setup();
	ready(view);
	view.handleInput(KEYS.tab);
	assert.equal(view.activeTab, "recent");
	const text = view.render(80).join("\n");
	assert.match(text, /Current work/);
	assert.match(text, /Write release notes/);
	assert.doesNotMatch(text, /Linked only/);
	view.handleInput(KEYS.tab);
	assert.equal(view.activeTab, "missions");
});

test("recent tab lines fit the width", () => {
	const { view } = setup();
	ready(view);
	view.handleInput(KEYS.tab);
	view.handleInput("/");
	view.handleInput("k");
	for (const width of [40, 80, 200]) {
		for (const line of view.render(width)) assert.equal(visibleWidth(line), width, `width ${width}: ${JSON.stringify(line)}`);
	}
});

test("slash focuses the query, typing filters, enter resumes the match", () => {
	const { view, events } = setup();
	ready(view);
	view.focused = true;
	view.handleInput(KEYS.tab);
	view.handleInput("c"); // not a query key until / is pressed
	assert.deepEqual(events.toggles, []);
	view.handleInput("/");
	for (const ch of "Grafana") view.handleInput(ch);
	const text = view.render(80).join("\n");
	assert.doesNotMatch(text, /release notes/);
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "loose");
});

test("arrows move within filtered results while typing", () => {
	const { view, events } = setup();
	ready(view);
	view.handleInput(KEYS.tab);
	view.handleInput("/");
	view.handleInput("e"); // matches all three
	view.handleInput(KEYS.down);
	view.handleInput(KEYS.down);
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "other");
});

test("esc clears the query first, then closes", () => {
	const { view, events } = setup();
	ready(view);
	view.handleInput(KEYS.tab);
	view.handleInput("/");
	for (const ch of "zzz") view.handleInput(ch);
	assert.match(view.render(80).join("\n"), /No matching sessions/);
	view.handleInput(KEYS.esc);
	assert.equal(events.cancelled, false);
	assert.match(view.render(80).join("\n"), /Write release notes/);
	view.handleInput(KEYS.esc);
	assert.equal(events.cancelled, true);
});

test("j and k move outside the query and type inside it", () => {
	const { view, events } = setup();
	ready(view);
	view.handleInput("j"); // missions: xmu4 -> 41vx
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "b");
	view.handleInput("k");
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "a-new");

	view.handleInput(KEYS.tab);
	view.handleInput("j");
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "loose");

	view.handleInput("/");
	for (const ch of "jk") view.handleInput(ch);
	assert.match(view.render(80).join("\n"), /\/ jk/);
	assert.match(view.render(80).join("\n"), /esc clear/);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeActions(children: string[] = [], failClose?: string) {
	const calls: string[] = [];
	const actions: MissionActions = {
		openChildren: async (id) => (calls.push(`children ${id}`), children),
		close: async (id, kids) => {
			calls.push(`close ${id} [${kids.join(",")}]`);
			if (failClose) throw new Error(failClose);
		},
		reopen: async (id) => void calls.push(`reopen ${id}`),
	};
	return { actions, calls };
}

test("x asks before closing a mission with its open children, y closes and reloads", async () => {
	const { actions, calls } = fakeActions(["mission-xmu4.2", "mission-xmu4.1"]);
	const { view, events } = setup(40, actions);
	ready(view);
	view.handleInput("x");
	assert.match(view.render(80).join("\n"), /Checking open work under xmu4/);
	await tick();
	assert.match(view.render(80).join("\n"), /Close xmu4 and 2 open children\? y\/n/);
	view.handleInput("y");
	await tick();
	assert.deepEqual(calls, ["children mission-xmu4", "close mission-xmu4 [mission-xmu4.2,mission-xmu4.1]"]);
	assert.deepEqual(events.toggles, [false], "reloads with the current closed filter");
	assert.match(view.render(80).join("\n"), /Closed xmu4 and 2 open children/);
	view.handleInput("j");
	assert.doesNotMatch(view.render(80).join("\n"), /Closed xmu4/, "any key clears the notice");
});

test("any key but y cancels the close prompt, and esc does not close the sidebar", async () => {
	const { actions, calls } = fakeActions();
	const { view, events } = setup(40, actions);
	ready(view);
	view.handleInput("x");
	await tick();
	assert.match(view.render(80).join("\n"), /Close xmu4\? y\/n/);
	view.handleInput(KEYS.esc);
	assert.equal(events.cancelled, false);
	view.handleInput("x");
	await tick();
	view.handleInput("n");
	await tick();
	assert.deepEqual(calls, ["children mission-xmu4", "children mission-xmu4"]);
	assert.match(view.render(80).join("\n"), /x close/);
});

test("x on a closed mission offers reopen; mx errors show in the status line", async () => {
	const reopenCalls = fakeActions();
	const r = setup(40, reopenCalls.actions);
	r.view.setState({
		kind: "ready",
		missions: buildMissionTree(
			[{ path: "p", cwd: "/w", title: "t", model: "m", linked: ["mission-old1"], updated: new Date(NOW).toISOString() }],
			[{ id: "mission-old1", title: "Old", status: "closed" }],
			{ now: NOW, includeClosed: true },
		),
	});
	r.view.handleInput("x");
	assert.match(r.view.render(80).join("\n"), /Reopen old1\? y\/n/);
	r.view.handleInput("y");
	await tick();
	assert.deepEqual(reopenCalls.calls, ["reopen mission-old1"]);

	const failing = setup(40, fakeActions([], "mx close failed: locked").actions);
	ready(failing.view);
	failing.view.handleInput("x");
	await tick();
	failing.view.handleInput("y");
	await tick();
	assert.match(failing.view.render(80).join("\n"), /mx close failed: locked/);
	assert.deepEqual(failing.events.toggles, []);
});

function tabOpener(fail?: string) {
	const opened: string[] = [];
	const open = async (s: SessionNode) => {
		if (fail) throw new Error(fail);
		opened.push(s.path);
	};
	return { open, opened };
}

test("n opens the selected session in a new tab and keeps the sidebar open", async () => {
	const { open, opened } = tabOpener();
	const { view, events } = setup(40, undefined, open);
	ready(view);
	assert.match(view.render(80).join("\n"), /n tab/);
	view.handleInput("n"); // mission row: newest session
	await tick();
	view.handleInput(KEYS.tab);
	view.handleInput("j"); // loose
	view.handleInput("n");
	await tick();
	assert.deepEqual(opened, ["a-new", "loose"]);
	assert.equal(events.picked, undefined);
	assert.equal(events.cancelled, false);
	assert.match(view.render(200).join("\n"), /Opened "Debug kubectl auth[^"]*…" in a new tab/);
});

test("n refuses the current session and asks first for a live one", async () => {
	const { open, opened } = tabOpener();
	const { view } = setup(40, undefined, open);
	const rows: RecentRow[] = [
		{ path: "mine", cwd: "/w", title: "Here", model: "m", linked: [], updated: new Date(NOW).toISOString() },
		{ path: "busy", cwd: "/w", title: "Other tab", model: "m", linked: [], updated: new Date(NOW - 30_000).toISOString() },
	];
	view.setState({ kind: "ready", missions: [], recent: rows, currentPath: "mine" });
	view.handleInput(KEYS.tab);
	view.handleInput("n");
	assert.match(view.render(120).join("\n"), /That is this session/);
	view.handleInput("j");
	view.handleInput("n");
	assert.match(view.render(120).join("\n"), /"Other tab" changed <2m ago.*y\/n/);
	view.handleInput("y");
	await tick();
	assert.deepEqual(opened, ["busy"]);
});

test("n without WezTerm does nothing; spawn errors show in the status line", async () => {
	const plain = setup();
	ready(plain.view);
	assert.doesNotMatch(plain.view.render(80).join("\n"), /n tab/);
	plain.view.handleInput("n");
	assert.equal(plain.events.picked, undefined);

	const broken = setup(40, undefined, tabOpener("wezterm cli spawn failed: no socket").open);
	ready(broken.view);
	broken.view.handleInput("n");
	await tick();
	assert.match(broken.view.render(120).join("\n"), /wezterm cli spawn failed: no socket/);
});

test("n types into the query while editing", () => {
	const { open, opened } = tabOpener();
	const { view } = setup(40, undefined, open);
	ready(view);
	view.handleInput(KEYS.tab);
	view.handleInput("/");
	view.handleInput("n");
	assert.deepEqual(opened, []);
	assert.match(view.render(80).join("\n"), /\/ n/);
});

test("a refresh keeps the cursor on the same mission and session", () => {
	const { view, events } = setup();
	ready(view);
	view.handleInput("j"); // 41vx
	view.handleInput(KEYS.tab);
	view.handleInput("j"); // loose
	const fresh = buildMissionTree(
		[
			{ path: "z", cwd: "/w", title: "z", model: "m", linked: ["mission-new1"], updated: new Date(NOW).toISOString() },
			{ path: "b", cwd: "/w", title: "b", model: "m", linked: ["mission-41vx"], updated: new Date(NOW - 60 * 60_000).toISOString() },
		],
		[
			{ id: "mission-new1", title: "New", status: "open" },
			{ id: "mission-41vx", title: "Envoy switch", status: "open" },
		],
		{ now: NOW },
	);
	const extra: RecentRow = { path: "fresh", cwd: "/w", title: "Fresh", model: "m", linked: [], updated: new Date(NOW).toISOString() };
	view.setState({ kind: "ready", missions: fresh, recent: [extra, ...recent()], currentPath: "mine" });
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "loose", "recent cursor followed its session");
	view.handleInput(KEYS.tab);
	view.handleInput(KEYS.enter);
	assert.equal(events.picked?.path, "b", "missions cursor followed 41vx down a row");
});

test("showError keeps the list and reports in the status line", () => {
	const { view } = setup();
	assert.equal(view.hasData, false);
	ready(view);
	assert.equal(view.hasData, true);
	view.showError("mx list failed: timeout");
	const text = view.render(80).join("\n");
	assert.match(text, /mx list failed: timeout/);
	assert.match(text, /ArgoCD alerting/);
});

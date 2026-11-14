/**
 * Sidebar overlay component with two tabs: a keyboard tree of missions and
 * their sessions, and a searchable list of recent sessions with no mission.
 * Depends on pi-tui only (no pi runtime), so tests drive it directly.
 */
import { basename } from "node:path";

import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type Focusable } from "@earendil-works/pi-tui";

import {
	buildRecentList,
	DEFAULT_LIVE_WINDOW_MS,
	flattenTree,
	formatStamp,
	targetOf,
	type MissionNode,
	type RecentRow,
	type SessionNode,
	type TreeRow,
} from "./tree.ts";

export type ThemeLike = {
	fg(token: "accent" | "muted" | "dim" | "border" | "borderAccent" | "success" | "warning" | "error" | "text", text: string): string;
	bold(text: string): string;
};

export type KeybindingsLike = {
	matches(data: string, action: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean;
};

export type SidebarState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; missions: MissionNode[]; recent?: RecentRow[]; currentPath?: string };

export type SidebarTab = "missions" | "recent";

export type SidebarViewOptions = {
	theme: ThemeLike;
	keybindings: KeybindingsLike;
	/** Terminal rows; the view sizes its body to fit. */
	getRows: () => number;
	now: () => number;
	onPick: (session: SessionNode) => void;
	onCancel: () => void;
	/** Load (or reload) missions, with or without closed ones. */
	onToggleClosed: (includeClosed: boolean) => void;
	requestRender: () => void;
	/** mx writes behind the x key; omitted means the key does nothing. */
	missionActions?: MissionActions;
	/** Resume in a new terminal tab (n key); omitted outside WezTerm. */
	openInNewTab?: (session: SessionNode) => Promise<void>;
};

export type MissionActions = {
	/** Open descendants, in the order they should be closed. */
	openChildren: (id: string) => Promise<string[]>;
	close: (id: string, children: string[]) => Promise<void>;
	reopen: (id: string) => Promise<void>;
};

/** A side effect behind a key; resolves to the success notice. */
type Task = { busy: string; work: () => Promise<string>; reload?: boolean };

type Pending =
	| { kind: "checking"; text: string }
	| { kind: "confirm"; prompt: string; task: Task }
	| { kind: "busy"; text: string };

type Notice = { tone: "success" | "error"; text: string };

const shortId = (id: string) => id.replace(/^mission-/, "");
const quoteTitle = (title: string) => `"${title.length > 40 ? `${title.slice(0, 39)}…` : title}"`;

const EDIT_HINT = "type to filter  ↑↓ move  ⏎ open  esc clear";

type TabState = { cursor: number; scroll: number };

export class SidebarView implements Focusable {
	private state: SidebarState = { kind: "loading" };
	private readonly expanded = new Set<string>();
	private tab: SidebarTab = "missions";
	private readonly tabs: Record<SidebarTab, TabState> = {
		missions: { cursor: 0, scroll: 0 },
		recent: { cursor: 0, scroll: 0 },
	};
	private includeClosed = false;
	private pending: Pending | undefined;
	private notice: Notice | undefined;
	private readonly query = new Input({ prompt: "/ " });
	private editing = false;
	private hasFocus = false;
	private recentCache: SessionNode[] | undefined;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(private readonly opts: SidebarViewOptions) {}

	/** Focusable: the TUI sets this; the query input gets it while editing. */
	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		this.query.focused = value && this.editing;
	}

	/** Swap in new data; each tab's cursor stays on the same mission or session. */
	setState(state: SidebarState): void {
		const keys = { missions: this.cursorKey("missions"), recent: this.cursorKey("recent") };
		this.state = state;
		this.recentCache = undefined;
		for (const tab of ["missions", "recent"] as const) {
			const t = this.tabs[tab];
			const found = keys[tab] === undefined ? -1 : this.keys(tab).indexOf(keys[tab]);
			t.cursor = found >= 0 ? found : Math.min(t.cursor, Math.max(0, this.count(tab) - 1));
		}
		this.changed();
	}

	/** True once there is a list on screen (fresh or cached). */
	get hasData(): boolean {
		return this.state.kind === "ready";
	}

	/** A failed background refresh: keep the list, report in the status line. */
	showError(message: string): void {
		this.notice = { tone: "error", text: message };
		this.changed();
	}

	private keys(tab: SidebarTab): string[] {
		if (tab === "recent") return this.recent().map((s) => s.path);
		return this.rows().map((r) => (r.kind === "mission" ? `m:${r.mission.id}` : `s:${r.mission.id}:${r.session.path}`));
	}

	private cursorKey(tab: SidebarTab): string | undefined {
		return this.keys(tab)[this.tabs[tab].cursor];
	}

	get closedShown(): boolean {
		return this.includeClosed;
	}

	get activeTab(): SidebarTab {
		return this.tab;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	private changed(): void {
		this.invalidate();
		this.opts.requestRender();
	}

	private rows(): TreeRow[] {
		return this.state.kind === "ready" ? flattenTree(this.state.missions, this.expanded) : [];
	}

	private recent(): SessionNode[] {
		if (this.state.kind !== "ready") return [];
		this.recentCache ??= buildRecentList(this.state.recent ?? [], {
			now: this.opts.now(),
			currentPath: this.state.currentPath,
			query: this.query.getValue(),
		});
		return this.recentCache;
	}

	private count(tab: SidebarTab): number {
		return tab === "missions" ? this.rows().length : this.recent().length;
	}

	private bodyHeight(): number {
		// 90% of the terminal minus top border, hint and bottom border; the
		// Recent tab also gives one row to the query line.
		const rows = Math.max(3, Math.floor(this.opts.getRows() * 0.9) - 3);
		return this.tab === "recent" ? Math.max(2, rows - 1) : rows;
	}

	private setEditing(value: boolean): void {
		this.editing = value;
		this.query.focused = value && this.hasFocus;
	}

	private clearQuery(): void {
		this.query.setValue("");
		this.recentCache = undefined;
		this.tabs.recent.cursor = 0;
		this.setEditing(false);
	}

	handleInput(data: string): void {
		const kb = this.opts.keybindings;
		if (this.pending) {
			this.handlePending(data);
			return;
		}
		this.notice = undefined;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift(Key.tab))) {
			this.tab = this.tab === "missions" ? "recent" : "missions";
			this.setEditing(false);
			this.changed();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.tab === "recent" && this.query.getValue() !== "") {
				this.clearQuery();
				this.changed();
			} else {
				this.opts.onCancel();
			}
			return;
		}
		if (this.tab === "recent") this.handleRecent(data);
		else this.handleMissions(data);
	}

	/** Up/down (or k/j outside the query) wrap; false when the key is not a move. */
	private move(data: string, length: number): boolean {
		const kb = this.opts.keybindings;
		const t = this.tabs[this.tab];
		const vim = !this.editing;
		if (kb.matches(data, "tui.select.up") || (vim && data === "k")) t.cursor = (t.cursor - 1 + length) % length;
		else if (kb.matches(data, "tui.select.down") || (vim && data === "j")) t.cursor = (t.cursor + 1) % length;
		else return false;
		return true;
	}

	private handleRecent(data: string): void {
		const kb = this.opts.keybindings;
		const list = this.recent();
		const t = this.tabs.recent;
		if (list.length > 0 && this.move(data, list.length)) {
			this.changed();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			if (list.length > 0) this.opts.onPick(list[t.cursor]);
			return;
		}
		if (!this.editing) {
			if ((data === "n" || data === "N") && list.length > 0) {
				this.startOpenInTab(list[t.cursor]);
				return;
			}
			if (data !== "/") return;
			this.setEditing(true);
			this.changed();
			return;
		}
		const before = this.query.getValue();
		this.query.handleInput(data);
		if (this.query.getValue() !== before) {
			this.recentCache = undefined;
			t.cursor = 0;
		}
		this.changed();
	}

	private hints(): string {
		const tab = this.opts.openInNewTab ? "  n tab" : "";
		return this.tab === "missions"
			? `⇥ recent  jk move  hl expand  ⏎ open${tab}  x close  c closed  esc`
			: `⇥ missions  jk move  / search  ⏎ open${tab}  esc`;
	}

	/** While a prompt or task is in flight only y (confirm) and cancel matter. */
	private handlePending(data: string): void {
		const pending = this.pending!;
		if (pending.kind === "confirm" && (data === "y" || data === "Y")) {
			this.execute(pending.task);
		} else if (pending.kind === "confirm" || (pending.kind === "checking" && this.opts.keybindings.matches(data, "tui.select.cancel"))) {
			this.pending = undefined;
		} else {
			return;
		}
		this.changed();
	}

	private startAction(mission: MissionNode): void {
		const actions = this.opts.missionActions;
		if (!actions) return;
		const id = shortId(mission.id);
		if (mission.status === "closed") {
			this.pending = {
				kind: "confirm",
				prompt: `Reopen ${id}? y/n`,
				task: { busy: `Reopening ${id}…`, reload: true, work: async () => (await actions.reopen(mission.id), `Reopened ${id}`) },
			};
			this.changed();
			return;
		}
		const checking: Pending = { kind: "checking", text: `Checking open work under ${id}…` };
		this.pending = checking;
		this.changed();
		actions.openChildren(mission.id).then(
			(children) => {
				if (this.pending !== checking) return;
				const extra = children.length > 0 ? ` and ${children.length} open children` : "";
				this.pending = {
					kind: "confirm",
					prompt: `Close ${id}${extra}? y/n`,
					task: {
						busy: `Closing ${id}…`,
						reload: true,
						work: async () => (await actions.close(mission.id, children), `Closed ${id}${extra}`),
					},
				};
				this.changed();
			},
			(error: unknown) => this.fail(checking, error),
		);
	}

	/** n: resume in a new tab and keep the sidebar open for the next one. */
	private startOpenInTab(session: SessionNode): void {
		const open = this.opts.openInNewTab;
		if (!open) return;
		if (session.current) {
			this.notice = { tone: "error", text: "That is this session; a second pi on it could corrupt it" };
			this.changed();
			return;
		}
		const title = quoteTitle(session.title);
		const task: Task = {
			busy: `Opening ${title} in a new tab…`,
			work: async () => (await open(session), `Opened ${title} in a new tab`),
		};
		if (session.live) {
			const minutes = Math.round(DEFAULT_LIVE_WINDOW_MS / 60000);
			this.pending = { kind: "confirm", prompt: `${title} changed <${minutes}m ago, maybe open elsewhere. Open anyway? y/n`, task };
			this.changed();
			return;
		}
		this.execute(task);
		this.changed();
	}

	private execute(task: Task): void {
		const busy: Pending = { kind: "busy", text: task.busy };
		this.pending = busy;
		task.work().then(
			(text) => {
				if (this.pending !== busy) return;
				this.pending = undefined;
				this.notice = { tone: "success", text };
				if (task.reload) this.opts.onToggleClosed(this.includeClosed);
				this.changed();
			},
			(error: unknown) => this.fail(busy, error),
		);
	}

	private fail(from: Pending, error: unknown): void {
		if (this.pending !== from) return;
		this.pending = undefined;
		this.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
		this.changed();
	}

	private handleMissions(data: string): void {
		const kb = this.opts.keybindings;
		if (data === "c" || data === "C") {
			this.includeClosed = !this.includeClosed;
			this.opts.onToggleClosed(this.includeClosed);
			this.changed();
			return;
		}

		const rows = this.rows();
		if (rows.length === 0) return;
		const t = this.tabs.missions;
		const row = rows[t.cursor];
		if (data === "x" || data === "X") {
			this.startAction(row.mission);
			return;
		}
		if (data === "n" || data === "N") {
			this.startOpenInTab(targetOf(row));
			return;
		}

		if (this.move(data, rows.length)) {
			this.changed();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.opts.onPick(targetOf(row));
			return;
		} else if (matchesKey(data, Key.right) || data === "l") {
			if (row.kind === "mission") {
				if (row.expanded) t.cursor += 1;
				else this.expanded.add(row.mission.id);
			}
		} else if (matchesKey(data, Key.left) || data === "h") {
			const id = row.mission.id;
			if (row.kind === "session" || row.expanded) {
				this.expanded.delete(id);
				t.cursor = this.rows().findIndex((r) => r.kind === "mission" && r.mission.id === id);
			}
		} else if (matchesKey(data, Key.space)) {
			const id = row.mission.id;
			if (this.expanded.has(id)) this.expanded.delete(id);
			else this.expanded.add(id);
			t.cursor = this.rows().findIndex((r) => r.kind === "mission" && r.mission.id === id);
		} else {
			return;
		}
		this.changed();
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const t = this.opts.theme;
		const inner = Math.max(1, width - 2);
		const frame = (content: string) => {
			const cut = truncateToWidth(content, inner);
			return t.fg("border", "│") + cut + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + t.fg("border", "│");
		};

		const label = (tab: SidebarTab, text: string) =>
			tab === this.tab ? t.fg("accent", t.bold(text)) : t.fg("muted", text);
		const title = label("missions", ` Missions${this.includeClosed ? " (+closed)" : ""} `) +
			t.fg("border", "│") + label("recent", " Recent ");
		const head = truncateToWidth(title, Math.max(0, inner - 1), "");
		const top = t.fg("border", "╭─") + head +
			t.fg("border", "─".repeat(Math.max(0, inner - 1 - visibleWidth(head))) + "╮");
		const bottom = t.fg("border", "╰" + "─".repeat(inner) + "╯");

		const body: string[] = [];
		const height = this.bodyHeight();
		if (this.state.kind === "loading") {
			body.push(t.fg("muted", " Loading sessions…"));
		} else if (this.state.kind === "error") {
			body.push(t.fg("error", ` ${this.state.message}`));
		} else if (this.tab === "missions") {
			const rows = this.rows();
			if (rows.length === 0) body.push(t.fg("muted", " No open missions with sessions"));
			const now = this.opts.now();
			for (const i of this.window(rows.length, height)) {
				body.push(this.renderRow(rows[i], i === this.tabs.missions.cursor, inner, now));
			}
		} else {
			body.push(this.renderQuery(inner));
			const list = this.recent();
			if (list.length === 0) {
				body.push(t.fg("muted", this.query.getValue() ? " No matching sessions" : " No recent sessions without a mission"));
			}
			const now = this.opts.now();
			for (const i of this.window(list.length, height)) {
				body.push(this.renderRecent(list[i], i === this.tabs.recent.cursor, inner, now));
			}
		}

		const lines = [top, ...body.map(frame), frame(this.statusLine()), bottom];
		this.cache = { width, lines };
		return lines;
	}

	/** Bottom line: a pending close prompt, the last result, or key hints. */
	private statusLine(): string {
		const t = this.opts.theme;
		const p = this.pending;
		if (p?.kind === "checking" || p?.kind === "busy") return t.fg("muted", ` ${p.text}`);
		if (p?.kind === "confirm") return t.fg("warning", ` ${p.prompt}`);
		if (this.notice) return t.fg(this.notice.tone, ` ${this.notice.text}`);
		return t.fg("dim", ` ${this.editing ? EDIT_HINT : this.hints()}`);
	}

	/** Indices visible in the body, scrolling the active tab to its cursor. */
	private window(length: number, height: number): number[] {
		const s = this.tabs[this.tab];
		if (s.cursor < s.scroll) s.scroll = s.cursor;
		if (s.cursor >= s.scroll + height) s.scroll = s.cursor - height + 1;
		const out: number[] = [];
		for (let i = s.scroll; i < Math.min(length, s.scroll + height); i++) out.push(i);
		return out;
	}

	private renderQuery(inner: number): string {
		const t = this.opts.theme;
		if (this.editing) return " " + (this.query.render(Math.max(1, inner - 1))[0] ?? "");
		const value = this.query.getValue();
		return value ? ` ${t.fg("accent", "/")} ${value}` : t.fg("dim", " / search title and messages");
	}

	private renderRecent(s: SessionNode, selected: boolean, inner: number, now: number): string {
		const t = this.opts.theme;
		const pointer = selected ? t.fg("accent", "›") : " ";
		const mark = s.current ? t.fg("success", "●") : s.live ? t.fg("warning", "!") : t.fg("dim", "○");
		const left = `${pointer}${mark} ${t.fg("muted", formatStamp(s.updatedMs, now))} ${s.title}`;
		const dir = basename(s.cwd) || s.cwd;
		return padBetween(left, t.fg("dim", ` ${truncateToWidth(dir, 16)}`), inner);
	}

	private renderRow(row: TreeRow, selected: boolean, inner: number, now: number): string {
		const t = this.opts.theme;
		const pointer = selected ? t.fg("accent", "›") : " ";
		if (row.kind === "mission") {
			const m = row.mission;
			const arrow = row.expanded ? "▾" : "▸";
			const id = m.id.replace(/^mission-/, "");
			const right = ` ${formatStamp(m.latestMs, now)}`;
			const left = `${pointer}${arrow} ${t.fg("accent", id)} ${m.status === "closed" ? t.fg("dim", m.title) : m.title}`;
			return padBetween(left, t.fg("muted", right), inner);
		}
		const s = row.session;
		const branch = t.fg("dim", row.last ? "└" : "├");
		const mark = s.current ? t.fg("success", "●") : s.live ? t.fg("warning", "!") : t.fg("dim", "○");
		const left = `${pointer}  ${branch} ${mark} ${t.fg("muted", formatStamp(s.updatedMs, now))} ${s.title}`;
		return truncateToWidth(left, inner);
	}
}

/** Left text truncated so the right text stays flush right. */
function padBetween(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(left, width);
	const cut = truncateToWidth(left, width - rightWidth);
	return cut + " ".repeat(Math.max(0, width - rightWidth - visibleWidth(cut))) + right;
}

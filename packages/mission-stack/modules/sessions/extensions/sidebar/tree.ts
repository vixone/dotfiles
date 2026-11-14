/**
 * Pure mission -> session tree for the sidebar. No pi runtime imports, so it
 * typechecks and unit-tests on its own.
 */

/** Subset of a pi-sessions index row the sidebar needs. */
export type SessionRow = {
	path: string;
	cwd: string;
	title: string;
	model: string;
	linked: string[];
	updated: string | null;
};

/** Subset of an mx epic row. */
export type Epic = {
	id: string;
	title?: string;
	status?: string;
};

export type SessionNode = {
	path: string;
	cwd: string;
	title: string;
	model: string;
	updatedMs: number;
	/** The session this pi process is showing right now. */
	current: boolean;
	/** Touched recently and not ours: probably open in another tab. */
	live: boolean;
};

export type MissionNode = {
	id: string;
	title: string;
	status: string;
	latestMs: number;
	/** Newest first, capped at maxSessions. */
	sessions: SessionNode[];
	/** Session count before the cap. */
	total: number;
};

export type TreeOptions = {
	now: number;
	currentPath?: string;
	includeClosed?: boolean;
	maxMissions?: number;
	maxSessions?: number;
	liveWindowMs?: number;
};

export const DEFAULT_MAX_MISSIONS = 15;
export const DEFAULT_MAX_SESSIONS = 5;
export const DEFAULT_LIVE_WINDOW_MS = 2 * 60 * 1000;

function timeMs(value: string | null): number {
	const ms = Date.parse(value ?? "");
	return Number.isNaN(ms) ? 0 : ms;
}

export function buildMissionTree(sessions: SessionRow[], epics: Epic[], opts: TreeOptions): MissionNode[] {
	const maxMissions = opts.maxMissions ?? DEFAULT_MAX_MISSIONS;
	const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
	const liveWindow = opts.liveWindowMs ?? DEFAULT_LIVE_WINDOW_MS;

	const epicById = new Map<string, Epic>();
	for (const epic of epics) {
		if (!opts.includeClosed && epic.status === "closed") continue;
		epicById.set(epic.id.toLowerCase(), epic);
	}

	const byMission = new Map<string, SessionNode[]>();
	for (const row of sessions) {
		const updatedMs = timeMs(row.updated);
		const current = opts.currentPath !== undefined && row.path === opts.currentPath;
		const node: SessionNode = {
			path: row.path,
			cwd: row.cwd,
			title: row.title,
			model: row.model,
			updatedMs,
			current,
			live: !current && updatedMs > 0 && opts.now - updatedMs < liveWindow,
		};
		for (const id of new Set(row.linked.map((m) => m.toLowerCase()))) {
			if (!epicById.has(id)) continue;
			const list = byMission.get(id) ?? [];
			list.push(node);
			byMission.set(id, list);
		}
	}

	const missions: MissionNode[] = [];
	for (const [id, list] of byMission) {
		list.sort((a, b) => b.updatedMs - a.updatedMs || a.path.localeCompare(b.path));
		const epic = epicById.get(id)!;
		missions.push({
			id,
			title: epic.title ?? "",
			status: epic.status ?? "",
			latestMs: list[0].updatedMs,
			sessions: list.slice(0, maxSessions),
			total: list.length,
		});
	}
	missions.sort((a, b) => b.latestMs - a.latestMs || a.id.localeCompare(b.id));
	return missions.slice(0, maxMissions);
}

/** Row for the Recent tab; searchText is what keyword queries match. */
export type RecentRow = SessionRow & { searchText?: string };

export type RecentOptions = {
	now: number;
	currentPath?: string;
	/** Whitespace-separated keywords, all must match (case-insensitive). */
	query?: string;
	limit?: number;
	liveWindowMs?: number;
};

export const DEFAULT_RECENT_LIMIT = 30;

const lowered = new WeakMap<RecentRow, string>();

function haystack(row: RecentRow): string {
	let text = lowered.get(row);
	if (text === undefined) {
		text = (row.searchText ?? `${row.title} ${row.cwd}`).toLowerCase();
		lowered.set(row, text);
	}
	return text;
}

/**
 * Sessions with no mission link, newest first, plus the current session so
 * the user can always find their way back. Same keyword semantics as the
 * pi-sessions CLI default: every term is an exact case-insensitive substring.
 */
export function buildRecentList(sessions: RecentRow[], opts: RecentOptions): SessionNode[] {
	const limit = opts.limit ?? DEFAULT_RECENT_LIMIT;
	const liveWindow = opts.liveWindowMs ?? DEFAULT_LIVE_WINDOW_MS;
	const terms = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);

	const nodes: SessionNode[] = [];
	for (const row of sessions) {
		const current = opts.currentPath !== undefined && row.path === opts.currentPath;
		if (row.linked.length > 0 && !current) continue;
		if (terms.length > 0) {
			const text = haystack(row);
			if (!terms.every((term) => text.includes(term))) continue;
		}
		const updatedMs = timeMs(row.updated);
		nodes.push({
			path: row.path,
			cwd: row.cwd,
			title: row.title,
			model: row.model,
			updatedMs,
			current,
			live: !current && updatedMs > 0 && opts.now - updatedMs < liveWindow,
		});
	}
	nodes.sort((a, b) => b.updatedMs - a.updatedMs || a.path.localeCompare(b.path));
	return nodes.slice(0, limit);
}

/** Subset of an mx issue row used to find a mission's open work. */
export type IssueLink = { id: string; parent?: string | null; status?: string };

/**
 * Non-closed descendants of rootId via parent links, deepest first, so
 * closing them in order never hits mx's "epic has open children" guard.
 */
export function openDescendants(issues: IssueLink[], rootId: string): string[] {
	const children = new Map<string, IssueLink[]>();
	for (const issue of issues) {
		if (!issue.parent) continue;
		const list = children.get(issue.parent) ?? [];
		list.push(issue);
		children.set(issue.parent, list);
	}
	const levels: string[][] = [];
	const seen = new Set([rootId]);
	let frontier = [rootId];
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const child of children.get(id) ?? []) {
				if (seen.has(child.id)) continue;
				seen.add(child.id);
				next.push(child.id);
			}
		}
		levels.push(next);
		frontier = next;
	}
	const status = new Map(issues.map((i) => [i.id, i.status]));
	return levels.reverse().flat().filter((id) => status.get(id) !== "closed");
}

export type TreeRow =
	| { kind: "mission"; mission: MissionNode; expanded: boolean }
	| { kind: "session"; mission: MissionNode; session: SessionNode; last: boolean };

/** Visible rows for the current expansion state. */
export function flattenTree(missions: MissionNode[], expanded: ReadonlySet<string>): TreeRow[] {
	const rows: TreeRow[] = [];
	for (const mission of missions) {
		const open = expanded.has(mission.id);
		rows.push({ kind: "mission", mission, expanded: open });
		if (!open) continue;
		mission.sessions.forEach((session, i) => {
			rows.push({ kind: "session", mission, session, last: i === mission.sessions.length - 1 });
		});
	}
	return rows;
}

/** Session Enter resumes: a mission row means its newest session. */
export function targetOf(row: TreeRow): SessionNode {
	return row.kind === "session" ? row.session : row.mission.sessions[0];
}

/** Short relative-ish stamp: HH:MM today, else dd.MM. */
export function formatStamp(ms: number, now: number): string {
	if (ms <= 0) return "--.--";
	const d = new Date(ms);
	const n = new Date(now);
	const pad = (v: number) => String(v).padStart(2, "0");
	const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
	return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

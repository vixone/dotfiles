/**
 * focus-land
 *
 * Registers the `/start`, `/focus` and `/land` slash commands for a
 * mission-aware session workflow backed by the mx mission store. `/continue`
 * (next.ts) only hands over; `/land` is the one path that captures knowledge.
 *
 * Commands:
 *   - `/start <title>` — create a new mission (epic, in_progress) with the
 *     given title and auto-focus it in one step. Combines `mx create` +
 *     `/focus` so you never need to look up the ID manually.
 *   - `/focus <id|text>` — resolves a mission via staged search (active
 *     in-progress epics → all epics → title/id search), scoring against id,
 *     title, and description. Persists the selection in the pi session via
 *     an append-only custom entry (`land-focus`, latest-wins). On success
 *     shows a verbose multi-line summary (status, priority, labels,
 *     description snippet) so the user can confirm the right mission was
 *     picked. While focused, every agent turn gets a system-prompt block
 *     injected (see `buildMissionSystemPromptBlock`) that carries the
 *     mission's *working state*: the latest "## Context Snapshot" from the
 *     mission notes (environment, AWS profile, cluster, key commands,
 *     current state) plus the open child issues ("what's left"). This is
 *     what makes a resumed session continue seamlessly instead of
 *     rediscovering credentials/paths/commands from scratch.
 *   - `/focus` (no args) — show the currently focused mission.
 *   - `/focus clear` — clear the session focus.
 *   - Auto-focus — when a fresh session's first prompt opens with
 *     "Resume mission-<id> ..." (the shape a land RESUME PROMPT emits) and
 *     nothing is focused yet, the mission is focused automatically (see
 *     `maybeAutoFocus` + `parseResumeIntent`), so a pasted resume prompt
 *     needs no manual `/focus`. It never overrides an explicit `/focus`.
 *
 *   - `/land [mission-id]` — update the mission with this session's state and
 *     stay in the session. `prepareLandTurn` resolves the target (id, else
 *     the focused mission, else a UI chooser over in-progress epics),
 *     preloads the latest snapshot and the children list into the prompt (so
 *     the turn does not re-read them), surfaces correction candidates and
 *     arms `queuedLand`. The turn captures missing findings, decisions and at
 *     most two lessons, then saves one Context Snapshot.
 *   - On a completed turn with a saved snapshot, `agent_settled` consumes the
 *     surfaced corrections and indexes the mission's new children. The
 *     focused system-prompt block is not refreshed, so the prompt cache holds.
 *
 * The built-in `/compact` is deliberately NOT overridden.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { mxBin, openStore, type MissionReader } from "../../lib/mx-store.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	collectCorrectionCandidates,
	markCorrectionsConsumed,
	renderCorrectionsSection,
	type CorrectionCandidate,
} from "./correction-detector.ts";
import { trackedIndex } from "./knowledge-capture.ts";
import { createMemoryClient, isEmptyMemoryResult, type MemoryClient } from "./memory-client.ts";
import { type Coordinator } from "./context-coordinator.ts";
import { parseResumeIntent } from "./mission-resume.ts";

// Shared context coordinator (set in registerFocusLand). A focus change clears
// the coordinator's session dedup so context for the new mission rehydrates.
let focusCoordinator: Coordinator | undefined;

// Missions live in ONE global mx store (~/.missions/mx.db, or MX_DB). Reads
// go in-process through ../../lib/mx-store.ts; writes run the mx CLI. There
// is no cwd-based discovery, on purpose.
type Reader = () => MissionReader;

// Memory graph access goes through ./memory-client.ts (Phase 1.1 refactor).

const MISSION_RE = /\bmission-[a-z0-9]+(?:\.\d+)?\b/i;
const FOCUS_ENTRY_TYPE = "land-focus";


type Epic = {
	id: string;
	title?: string;
	status?: string;
	issue_type?: string;
};

type FocusState = { id: string; title?: string } | null;

function normalizeMissionId(input: string): string | null {
	const match = input.toLowerCase().match(MISSION_RE);
	if (!match) return null;
	return match[0].split(".")[0];
}

function getFocusedMission(entries: unknown[]): FocusState {
	const focusEntry = entries
		.filter((e: any) => e?.type === "custom" && e?.customType === FOCUS_ENTRY_TYPE)
		.pop() as { data?: FocusState } | undefined;
	return focusEntry?.data ?? null;
}

function setFocusedMission(pi: ExtensionAPI, focus: FocusState): void {
	pi.appendEntry(FOCUS_ENTRY_TYPE, focus);
	focusCoordinator?.onFocusChange(focus?.id ?? "clear");
}

function scoreEpicMatch(epic: Epic, query: string): number {
	const q = query.trim().toLowerCase();
	if (!q) return 0;
	const id = epic.id.toLowerCase();
	const title = (epic.title ?? "").toLowerCase();
	const desc = String((epic as any).description ?? "").toLowerCase();
	const notes = String((epic as any).notes ?? "").toLowerCase();
	const labels: string[] = Array.isArray((epic as any).labels) ? (epic as any).labels.map((l: string) => l.toLowerCase()) : [];
	const labelsStr = labels.join(" ");
	if (id === q) return 1000;
	if (title === q) return 950;
	if (id.includes(q)) return 850;
	if (title.includes(q)) return 800;
	if (desc.includes(q)) return 760;
	if (notes.includes(q)) return 740;
	const terms = q.split(/\s+/).filter(Boolean);
	if (terms.length === 0) return 0;
	// Normalize both corpus AND terms so hyphens/punctuation don't break matching
	const normalizedTitle = title.replace(/[^a-z0-9]+/g, " ");
	const normalizedDesc = desc.replace(/[^a-z0-9]+/g, " ");
	const normalizedNotes = notes.replace(/[^a-z0-9]+/g, " ");
	const normalizedTerms = terms.map((t) => t.replace(/[^a-z0-9]+/g, " ").trim());
	const inTitle = normalizedTerms.filter((t) => normalizedTitle.includes(t) || id.includes(t)).length;
	const inDesc = normalizedTerms.filter((t) => normalizedDesc.includes(t)).length;
	const inNotes = normalizedTerms.filter((t) => normalizedNotes.includes(t)).length;
	const inLabels = normalizedTerms.filter((t) => labelsStr.includes(t)).length;
	if (inTitle === terms.length) return 720 + terms.length;
	if (inTitle + inDesc >= terms.length) return 680 + inTitle * 10 + inDesc * 3;
	if (inTitle + inNotes >= terms.length) return 660 + inTitle * 10 + inNotes * 3;
	const totalHits = Math.min(inTitle + inDesc + inNotes + inLabels, terms.length);
	if (totalHits === terms.length) return 640 + inTitle * 10 + inDesc * 5 + inNotes * 3 + inLabels * 2;
	if (inTitle > 0 || inDesc > 0 || inNotes > 0 || inLabels > 0) {
		const coverage = totalHits / terms.length;
		if (coverage >= 0.5) return 500 + inTitle * 20 + inDesc * 5 + inNotes * 3 + inLabels * 2;
	}
	return 0;
}

function resolveMissionQuery(epics: Epic[], query: string): { match?: Epic; ambiguous?: Epic[] } {
	const scored = epics
		.map((epic) => ({ epic, score: scoreEpicMatch(epic, query) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.epic.id.localeCompare(b.epic.id));
	if (scored.length === 0) return {};
	if (scored.length === 1 || scored[0].score > scored[1].score) return { match: scored[0].epic };
	return { ambiguous: scored.filter((x) => x.score === scored[0].score).map((x) => x.epic) };
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function validateOne(reader: Reader, id: string): Promise<{ id: string; ok: boolean; error?: string }> {
	try {
		return { id, ok: reader().showIssue(id) !== null };
	} catch (e) {
		return { id, ok: false, error: errorText(e) };
	}
}

function epicList(read: () => Epic[]): { epics: Epic[]; error: string | null } {
	try {
		return { epics: read(), error: null };
	} catch (e) {
		return { epics: [], error: errorText(e) };
	}
}

async function listInProgressEpics(reader: Reader): Promise<{ epics: Epic[]; error: string | null }> {
	return epicList(() => reader().epicRows({ statuses: ["in_progress"] }));
}

async function listAllEpics(reader: Reader): Promise<{ epics: Epic[]; error: string | null }> {
	return epicList(() => reader().epicRows());
}

async function searchEpics(reader: Reader, query: string): Promise<{ epics: Epic[]; error: string | null }> {
	return epicList(() => reader().searchEpics(query, { includeClosed: true }));
}

type MissionDetail = {
	id: string;
	title?: string;
	status?: string;
	priority?: number | string;
	labels?: string[];
	description?: string;
	notes?: string;
	updated_at?: string;
};

type MissionChild = {
	id: string;
	title?: string;
	status?: string;
};

function extractLatestSnapshot(notes: string): string {
	const body = (notes ?? "").trim();
	const idx = body.lastIndexOf("## Context Snapshot");
	return idx === -1 ? body : body.slice(idx).trim();
}

function snapshotPreview(notes: string, maxChars = 2200): string {
	const snapshot = extractLatestSnapshot(notes);
	if (snapshot.length <= maxChars) return snapshot;
	return snapshot.slice(0, maxChars).trimEnd() + "\n...(truncated - run `mx show <mission-id>` for full notes)";
}

async function fetchMissionDetail(reader: Reader, id: string): Promise<MissionDetail | null> {
	try {
		return reader().showIssue(id);
	} catch {
		return null;
	}
}

// Fetch a mission's child issues (the [finding]/[decision]/[action] items).
// We surface the OPEN [action] children into the injected context so a resumed
// session immediately knows what's left to do without re-deriving it.
async function fetchMissionChildren(reader: Reader, id: string): Promise<MissionChild[]> {
	try {
		return reader().children(id);
	} catch {
		return [];
	}
}

// Render open action items (and a count of remaining open non-action children)
// as a compact "what's left" list for the injected mission context.
function renderOpenWork(children: MissionChild[], maxItems = 10): string | null {
	const open = children.filter((c) => c.status && c.status !== "closed");
	if (open.length === 0) return null;
	const actions = open.filter((c) => /^\s*\[action\]/i.test(c.title ?? ""));
	const rest = open.filter((c) => !/^\s*\[action\]/i.test(c.title ?? ""));
	const ordered = [...actions, ...rest].slice(0, maxItems);
	const lines = ordered.map((c) => {
		const title = (c.title ?? "(untitled)").replace(/^\s*\[(action|finding|decision)\]\s*/i, "");
		return `- ${c.id}: ${title}`;
	});
	if (open.length > maxItems) lines.push(`- ...and ${open.length - maxItems} more open item(s)`);
	return lines.join("\n");
}

const LAND_SNAPSHOT_MAX = 8000;
const LAND_CLOSED_CHILDREN = 40;

/**
 * The mission state a land turn needs, preloaded so it does not run `mx show` / `mx children`: the full latest
 * snapshot (it carries Pending capture) and the children, open first, then the newest closed ones for dedup.
 */
/**
 * The Pending capture section of the newest snapshot that has one, when that is not the latest snapshot (a
 * /continue snapshot after a /land has none). Null when the latest has its own or the carried list is empty.
 */
export function carriedPending(notes: string): { heading: string; items: string } | null {
	const parts = (notes ?? "").split(/(?=^## Context Snapshot)/m).filter((p) => p.startsWith("## Context Snapshot"));
	if (parts.length === 0 || parts[parts.length - 1].includes("### Pending capture")) return null;
	for (let i = parts.length - 2; i >= 0; i--) {
		const at = parts[i].indexOf("### Pending capture");
		if (at === -1) continue;
		const items = parts[i].slice(at + "### Pending capture".length).split(/^#{2,3} /m)[0].trim();
		if (!items || /^-\s*None\.?$/i.test(items)) return null;
		return { heading: parts[i].split("\n")[0].trim(), items };
	}
	return null;
}

export function renderLandState(detail: { notes?: string } | null, children: MissionChild[]): string {
	const snapshot = extractLatestSnapshot(detail?.notes ?? "");
	const carried = carriedPending(detail?.notes ?? "");
	const shown = snapshot.length > LAND_SNAPSHOT_MAX ? `${snapshot.slice(0, LAND_SNAPSHOT_MAX).trimEnd()}\n...(truncated)` : snapshot;
	const seq = (c: MissionChild) => Number(c.id.split(".").pop()) || 0;
	const open = children.filter((c) => c.status !== "closed");
	const closed = children.filter((c) => c.status === "closed").sort((a, b) => seq(b) - seq(a));
	const listed = [...open, ...closed.slice(0, LAND_CLOSED_CHILDREN)];
	const omitted = children.length - listed.length;
	const lines = [
		"",
		"## Mission state (preloaded, current as of this prompt; do not re-read it)",
		"",
		"### Latest snapshot",
		shown || "- None",
		...(carried ? ["", `### Pending capture carried from \`${carried.heading}\``, carried.items] : []),
		"",
		`### Children (${children.length}: ${open.length} open${omitted > 0 ? `, ${omitted} older closed not listed` : ""})`,
		...(listed.length ? listed.map((c) => `- ${c.id} [${c.status ?? "?"}] ${c.title ?? "(untitled)"}`) : ["- None"]),
	];
	return lines.join("\n");
}

// Phase 5C — cross-mission graph view. Reads only; no new embedding API
// calls (uses children's stored embeddings). Returns the sentinel "_No
// graph footprint..." string for missions with zero :MissionChild rows
// (e.g. fresh /start) so we can suppress the prompt block cleanly.
async function fetchPriorArt(memory: MemoryClient, query: string): Promise<string | null> {
	try {
		const res = await memory.search(query, { timeout: 15000 });
		if (isEmptyMemoryResult(res.stdout)) return null;
		return res.stdout.trim();
	} catch {
		return null;
	}
}

async function fetchBlastRadius(memory: MemoryClient, missionId: string): Promise<string | null> {
	try {
		const res = await memory.blastRadius(missionId);
		if (isEmptyMemoryResult(res.stdout)) return null;
		return res.stdout.trim();
	} catch {
		return null;
	}
}

function renderFocusSummary(id: string, fallbackTitle: string | undefined, detail: MissionDetail | null): string {
	const title = detail?.title ?? fallbackTitle ?? "(untitled)";
	const header = `Focused mission: ${id} — ${title}`;
	if (!detail) return header;
	const lines: string[] = [header];
	const meta: string[] = [];
	if (detail.status) meta.push(`status: ${detail.status}`);
	if (detail.priority !== undefined && detail.priority !== null) meta.push(`priority: P${detail.priority}`);
	if (detail.updated_at) meta.push(`updated: ${detail.updated_at.slice(0, 10)}`);
	if (meta.length > 0) lines.push(meta.join(" · "));
	if (detail.labels && detail.labels.length > 0) lines.push(`labels: ${detail.labels.join(", ")}`);
	const desc = (detail.description ?? "").trim();
	if (desc) {
		const snippet = desc.split(/\n+/).slice(0, 3).join(" • ");
		const truncated = snippet.length > 360 ? `${snippet.slice(0, 357)}...` : snippet;
		lines.push("", truncated);
	}
	return lines.join("\n");
}

async function notifyFocusSummary(
	reader: Reader,
	ctx: { hasUI: boolean; ui: { notify: (message: string, type?: "error" | "info" | "warning") => void } },
	id: string,
	fallbackTitle?: string,
): Promise<void> {
	if (!ctx.hasUI) return;
	const detail = await fetchMissionDetail(reader, id);
	ctx.ui.notify(renderFocusSummary(id, fallbackTitle, detail), "info");
}

async function resolveMissionAgentically(reader: Reader, query: string): Promise<{ match?: Epic; ambiguous?: Epic[]; error?: string }> {
	const fast = await listInProgressEpics(reader);
	if (fast.error) return { error: fast.error };
	const fastResolved = resolveMissionQuery(fast.epics, query);
	if (fastResolved.match && scoreEpicMatch(fastResolved.match, query) >= 700) return fastResolved;

	const all = await listAllEpics(reader);
	if (all.error) return { error: all.error };
	const allResolved = resolveMissionQuery(all.epics, query);
	if (allResolved.match) return allResolved;

	const searched = await searchEpics(reader, query);
	if (!searched.error) {
		const searchResolved = resolveMissionQuery(searched.epics, query);
		if (searchResolved.match) return searchResolved;
		if (searchResolved.ambiguous && searchResolved.ambiguous.length > 0) return searchResolved;
	}

	return allResolved;
}

// Canonical land-the-plane prompt lives in ~/Missions.md between the
// <!-- land-the-plane-prompt:begin --> and <!-- land-the-plane-prompt:end -->
// markers inside a fenced block. We read it at module load and substitute
// `{MISSION_IDS}`. If the file is missing / unparseable we fall back to the
// hardcoded template below so /land still works.
const LAND_PROMPT_FALLBACK_TEMPLATE = [
	"LAND THE PLANE for {MISSION_IDS}: update the mission with this session's state. The session continues afterwards, so write no resume prompt.",
	"",
	"The mission state is preloaded below; do not run mx show or mx children. Do not investigate, change code, commit or close the mission.",
	"1. Capture only what this session established and mx does not have yet: atomic findings and decisions as closed children, changed actions, and at most 2 cross-task lessons (zero is normal). Call `memory_check_duplicate` before each `mx remember`. Keep secrets out. On a failed write keep the item pending; do not retry.",
	"2. Save ONE `mx note {MISSION_IDS}` last, headed `## Context Snapshot <YYYY-MM-DD HH:MM>Z (/land)`: current state and next action first, then `### Recorded` (IDs/keys) and `### Pending capture` (or `- None`).",
	"3. Reply in at most 5 lines: snapshot saved or not, recorded IDs and keys, pending items.",
].join("\n");

const MISSIONS_FILE = join(homedir(), "Missions.md");

export function loadLandPromptTemplate(missionsFilePath = MISSIONS_FILE): { template: string; source: "missions-md" | "fallback"; reason?: string } {
	try {
		const md = readFileSync(missionsFilePath, "utf8");
		const begin = md.indexOf("<!-- land-the-plane-prompt:begin -->");
		const end = md.indexOf("<!-- land-the-plane-prompt:end -->");
		if (begin === -1 || end === -1 || end <= begin) {
			return { template: LAND_PROMPT_FALLBACK_TEMPLATE, source: "fallback", reason: "markers not found in Missions.md" };
		}
		const between = md.slice(begin, end);
		const fence = between.match(/```[^\n]*\n([\s\S]*?)\n```/);
		if (!fence) return { template: LAND_PROMPT_FALLBACK_TEMPLATE, source: "fallback", reason: "no fenced block between markers" };
		const body = fence[1].trim();
		if (!body.includes("{MISSION_IDS}")) {
			return { template: LAND_PROMPT_FALLBACK_TEMPLATE, source: "fallback", reason: "fenced block missing {MISSION_IDS} placeholder" };
		}
		return { template: body, source: "missions-md" };
	} catch (e) {
		return { template: LAND_PROMPT_FALLBACK_TEMPLATE, source: "fallback", reason: e instanceof Error ? e.message : String(e) };
	}
}

export function renderLandPrompt(template: string, idList: string): string {
	return template.split("{MISSION_IDS}").join(idList);
}

/**
 * Register focus-land's slash commands and event handlers. Called from
 * the umbrella extension's index.ts. Behavior is unchanged from the
 * pre-Phase-1.1 file; only the memory-graph access has been factored
 * into ./memory-client.ts.
 */
export type FocusLandDeps = { store?: Reader };

/** The part of a command context prepareLandTurn reads: focus entries, and a UI for the chooser. */
type LandPrepareCtx = {
	hasUI: boolean;
	ui: {
		notify: (message: string, type?: "error" | "info" | "warning") => void;
		select?: (prompt: string, options: string[]) => Promise<string | null | undefined>;
		setStatus?: (key: string, text: string | undefined) => void;
		theme?: any;
	};
	sessionManager: { getEntries: () => unknown[] };
};

export function registerFocusLand(pi: ExtensionAPI, coordinator?: Coordinator, deps: FocusLandDeps = {}): void {
	const memory = createMemoryClient(pi.exec.bind(pi));
	const reader: Reader = deps.store ?? (() => openStore());
	focusCoordinator = coordinator;

	// Keep the target and correction batch together. Focus can change while a
	// landing turn runs, so post-land work must not use currentFocus.
	let queuedLand: {
		id: string;
		title?: string;
		corrections: CorrectionCandidate[];
		previousSnapshot: string | null;
		outcome: "completed" | "aborted" | "error" | null;
	} | null = null;
	// True from /land until its prompt is sent, including the wait for idle.
	let landRequested = false;

	// Tracks current focus for the status indicator (mirrors session entries).
	let currentFocus: FocusState = null;

	// Cached mission detail for system prompt injection (refreshed on focus change).
	let cachedMissionDetail: MissionDetail | null = null;

	// Cached prior art from memory graph (refreshed on focus change).
	let cachedPriorArt: string | null = null;

	// Cached blast radius (cross-mission graph view) — only meaningful for
	// missions that already exist in the graph (i.e. /focus on existing
	// missions, not /start on brand-new ones).
	let cachedBlastRadius: string | null = null;

	// Cached open work (open child issues) for the focused mission, rendered as
	// a compact "what's left" list. Refreshed on focus change so a resumed
	// session knows the next steps without re-deriving them.
	let cachedOpenWork: string | null = null;

	function updateFocusStatus(ctx: { hasUI: boolean; ui: any }): void {
		if (!ctx.hasUI) return;
		if (currentFocus) {
			const shortId = currentFocus.id.replace(/^mission-/, "");
			const label = currentFocus.title
				? `🎯 ${shortId} — ${currentFocus.title}`
				: `🎯 ${shortId}`;
			const theme = ctx.ui.theme;
			ctx.ui.setStatus("focus", theme.fg("accent", label));
		} else {
			ctx.ui.setStatus("focus", undefined);
		}
	}

	async function refreshMissionDetail(): Promise<void> {
		if (!currentFocus) {
			cachedMissionDetail = null;
			cachedPriorArt = null;
			cachedBlastRadius = null;
			cachedOpenWork = null;
			return;
		}
		cachedMissionDetail = await fetchMissionDetail(reader, currentFocus.id);
		// Surface open child issues (esp. open [action] items) so a resumed
		// session knows what's left to do without re-deriving it.
		const children = await fetchMissionChildren(reader, currentFocus.id);
		cachedOpenWork = renderOpenWork(children);
		// Fetch prior art from memory graph — use title + latest notes snapshot for richer signal
		const titlePart = cachedMissionDetail?.title ?? currentFocus.title ?? currentFocus.id;
		const notesPart = snapshotPreview(cachedMissionDetail?.notes ?? "", 400)
			.replace(/\s+/g, " ")
			.trim();
		const descPart = notesPart || (cachedMissionDetail?.description ?? "").trim().split("\n").slice(0, 2).join(" ");
		const searchQuery = descPart ? `${titlePart}. ${descPart}`.slice(0, 300) : titlePart;
		cachedPriorArt = await fetchPriorArt(memory, searchQuery);
		// Cross-mission blast radius — returns null on missions with zero
		// :MissionChild rows (fresh /start) or no neighbors above the floor,
		// in which case we simply skip the prompt block.
		cachedBlastRadius = await fetchBlastRadius(memory, currentFocus.id);
	}

	function buildMissionSystemPromptBlock(): string | null {
		if (!currentFocus) return null;
		const id = currentFocus.id;
		const title = cachedMissionDetail?.title ?? currentFocus.title ?? "(untitled)";
		const lines: string[] = [
			"",
			`## Active Mission: ${id} — ${title}`,
			"",
			"You are actively working ON this mission. Treat the context below as authoritative working state carried over from previous sessions.",
			"BEFORE searching the filesystem, asking the user for credentials/paths/cluster names, or re-deriving setup: read the mission context below — the environment, profiles, key commands, and current state are usually already recorded here.",
			`Only if a needed detail is genuinely absent from this block should you run \`mx show ${id}\` (full notes) or \`mx children ${id}\`, or then ask the user.`,
			"When you make findings, decisions, or actionable follow-ups relevant to this mission, note them for capture when the user lands.",
			"When debugging errors or choosing between approaches, use `agent_memory_memory_search` to check if relevant lessons exist before re-investigating from scratch.",
		];
		// Include a brief description snippet if available so the agent knows the mission scope.
		const desc = (cachedMissionDetail?.description ?? "").trim();
		if (desc) {
			const snippet = desc.split(/\n+/).slice(0, 2).join(" ");
			const truncated = snippet.length > 200 ? `${snippet.slice(0, 197)}...` : snippet;
			lines.push(`Mission scope: ${truncated}`);
		}
		// Inject the latest Context Snapshot from the mission notes. THIS is the
		// carried-over working state (environment, AWS profile, cluster, key
		// commands, current state) that lets a resumed session continue without
		// rediscovering everything. This is the single most important block.
		const snapshot = snapshotPreview(cachedMissionDetail?.notes ?? "");
		if (snapshot) {
			lines.push("");
			lines.push("### Mission working context (latest snapshot from notes)");
			lines.push("");
			lines.push(snapshot);
		}
		// Inject the open work list so the model knows what remains.
		if (cachedOpenWork) {
			lines.push("");
			lines.push("### Open work on this mission (from mx children)");
			lines.push("");
			lines.push(cachedOpenWork);
		}
		// Inject prior art from memory graph if available
		if (cachedPriorArt) {
			lines.push("");
			lines.push("### Prior Art (from memory graph)");
			lines.push("");
			lines.push(cachedPriorArt);
		}
		// Inject cross-mission blast radius if the mission has graph footprint
		if (cachedBlastRadius) {
			lines.push("");
			lines.push("### Cross-mission graph view");
			lines.push("");
			lines.push(cachedBlastRadius);
		}
		return lines.join("\n");
	}

	const loaded = loadLandPromptTemplate();
	const landPromptTemplate = loaded.template;
	const landPromptSource = loaded.source;
	const landPromptFallbackReason = loaded.reason;

	// Restore focus status indicator on session start / resume.
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		currentFocus = getFocusedMission(entries);
		updateFocusStatus(ctx);
		await refreshMissionDetail();
	});

	// Auto-focus a mission when a fresh session opens with a "Resume mission-<id>"
	// prompt (the shape /land emits). Only fires when nothing is focused yet, so
	// it never overrides an explicit /focus, and only on an anchored resume verb
	// so ordinary mentions of a mission id do not hijack focus.
	async function maybeAutoFocus(prompt: string, ctx: { hasUI: boolean; ui: any }): Promise<void> {
		if (currentFocus) return;
		const id = parseResumeIntent(prompt);
		if (!id) return;
		const validated = await validateOne(reader, id);
		if (!validated.ok) return;
		setFocusedMission(pi, { id });
		currentFocus = { id };
		updateFocusStatus(ctx);
		await refreshMissionDetail();
		await notifyFocusSummary(reader, ctx, id);
	}

	// Inject mission context into system prompt on every agent turn.
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType === "user") await maybeAutoFocus(event.prompt, ctx);
		const block = buildMissionSystemPromptBlock();
		if (!block) return;
		return { systemPrompt: block + "\n\n" + event.systemPrompt };
	});

	pi.on("agent_before_settle", (event) => {
		if (queuedLand) queuedLand.outcome = event.outcome;
	});

	pi.on("agent_settled", async (event, ctx) => {
		const land = queuedLand;
		queuedLand = null;
		if (!land) return;
		if (event.aborted || land.outcome !== "completed") return;

		const detail = await fetchMissionDetail(reader, land.id);
		const snapshot = extractLatestSnapshot(detail?.notes ?? "");
		if (land.previousSnapshot === null || snapshot === land.previousSnapshot ||
			!snapshot.startsWith("## Context Snapshot") || !snapshot.includes("### Pending capture")) {
			if (ctx.hasUI) ctx.ui.notify(`/land saved no new snapshot on ${land.id}. Corrections remain pending.`, "warning");
			return;
		}

		markCorrectionsConsumed(pi, land.corrections);
		const outcome = await trackedIndex(() => memory.addChildren(land.id));
		if (ctx.hasUI) {
			if (outcome.action === "indexed") {
				ctx.ui.notify(`Memory indexed children for ${land.id} (attempt ${outcome.attempts}).`, "info");
			} else {
				ctx.ui.notify(
					`Memory index for ${land.id} is pending-reconcile after ${outcome.attempts} attempts: ${(outcome.error ?? "").slice(0, 120)}. Run a full memory_sync to backfill.`,
					"warning",
				);
			}
		}
	});

	pi.registerCommand("focus", {
		description: "Set/show/clear the active mission for this pi session by ID or fuzzy title, e.g. /focus compact extension",
		handler: async (args, ctx) => {
			const query = args.trim();
			const current = getFocusedMission(ctx.sessionManager.getEntries());
			if (!query) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						current ? `Current focused mission: ${current.id}${current.title ? ` — ${current.title}` : ""}` : "No focused mission set. Use /focus <mission-title>.",
						current ? "info" : "warning",
					);
				}
				return;
			}
			if (query.toLowerCase() === "clear") {
				setFocusedMission(pi, null);
				currentFocus = null;
				cachedMissionDetail = null;
				updateFocusStatus(ctx);
				if (ctx.hasUI) ctx.ui.notify("Cleared focused mission for this session.", "info");
				return;
			}
			const explicitId = normalizeMissionId(query);
			if (explicitId) {
				const validated = await validateOne(reader, explicitId);
				if (!validated.ok) {
					if (ctx.hasUI) ctx.ui.notify(`Invalid mission ID: ${explicitId}`, "warning");
					return;
				}
				setFocusedMission(pi, { id: explicitId });
				currentFocus = { id: explicitId };
				updateFocusStatus(ctx);
				await refreshMissionDetail();
				await notifyFocusSummary(reader, ctx, explicitId);
				return;
			}
			const { match, ambiguous, error } = await resolveMissionAgentically(reader, query);
			if (error) {
				if (ctx.hasUI) ctx.ui.notify(`Failed to search missions: ${error}`, "warning");
				return;
			}
			if (match) {
				setFocusedMission(pi, { id: match.id, title: match.title });
				currentFocus = { id: match.id, title: match.title };
				updateFocusStatus(ctx);
				await refreshMissionDetail();
				await notifyFocusSummary(reader, ctx, match.id, match.title);
				return;
			}
			if (ctx.hasUI) {
				if (ambiguous && ambiguous.length > 0 && ctx.ui.select) {
					const options = ambiguous.map((e) => `${e.id}${e.title ? ` — ${e.title}` : ""}`);
					const choice = await ctx.ui.select("Choose matching mission", options);
					if (choice) {
						const selectedId = String(choice).split(" — ")[0] || "";
						const picked = ambiguous.find((e) => e.id === selectedId);
						setFocusedMission(pi, { id: selectedId, title: picked?.title });
						currentFocus = { id: selectedId, title: picked?.title };
						updateFocusStatus(ctx);
						await refreshMissionDetail();
						await notifyFocusSummary(reader, ctx, selectedId, picked?.title);
						return;
					}
					ctx.ui.notify("No mission selected.", "warning");
				} else if (ambiguous && ambiguous.length > 0) {
					ctx.ui.notify(`Ambiguous mission match: ${ambiguous.map((e) => `${e.id}${e.title ? ` — ${e.title}` : ""}`).join(" | ")}. Refine /focus text.`, "warning");
				} else {
					ctx.ui.notify(`No matching mission found for: ${query}`, "warning");
				}
			}
		},
	});

	pi.registerCommand("start", {
		description: "Create a new mission and auto-focus it: /start investigate gatekeeper issues on prod cluster",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /start <what you're working on>", "warning");
				return;
			}
			// Derive a short title (max ~8 words) from the input; full text becomes description if longer
			const words = input.split(/\s+/);
			const title = words.slice(0, 8).join(" ") + (words.length > 8 ? "..." : "");
			const description = words.length > 8 ? input : "";

			// Fetch prior art BEFORE creating the mission — use the full input
			// text (richer signal than the truncated title)
			const priorArt = await fetchPriorArt(memory, input);

			try {
				// argv only, no shell: the title and description are never interpolated.
				const createArgs = ["create", "--type", "epic", "--title", title, ...(description ? ["--description", description] : []), "--silent"];
				const created0 = await pi.exec(mxBin(), createArgs, { timeout: 10000 });
				const newId = created0.stdout.trim();
				if (created0.code !== 0 || !newId) {
					if (ctx.hasUI) ctx.ui.notify(`Failed to create mission: ${created0.stderr || "unknown error"}`, "warning");
					return;
				}
				const res = await pi.exec(mxBin(), ["update", newId, "--claim", "--json"], { timeout: 10000 });
				if (res.code !== 0) {
					if (ctx.hasUI) ctx.ui.notify(`Created ${newId} but could not claim it: ${res.stderr || "unknown error"}`, "warning");
					return;
				}
				// mx update --claim --json outputs an array with the updated issue
				const parsed = JSON.parse(res.stdout || "[]");
				const created = Array.isArray(parsed) ? parsed[0] : parsed;
				const missionId: string | undefined = created?.id;
				if (!missionId) {
					if (ctx.hasUI) ctx.ui.notify("Mission created but could not parse ID from output.", "warning");
					return;
				}
				// Auto-focus the new mission — use prior art already fetched (skip
				// redundant search in refreshMissionDetail). Skip blast radius
				// entirely: a mission created seconds ago has no :MissionChild
				// rows in the graph and no RELATED_ACROSS edges yet —
				// memory_blast_radius would correctly return the empty sentinel.
				setFocusedMission(pi, { id: missionId, title });
				currentFocus = { id: missionId, title };
				updateFocusStatus(ctx);
				cachedMissionDetail = await fetchMissionDetail(reader, missionId);
				cachedPriorArt = priorArt;
				cachedBlastRadius = null;
				cachedOpenWork = null;
				await notifyFocusSummary(reader, ctx, missionId, title);
				if (ctx.hasUI) {
					ctx.ui.notify(`✅ Created & focused: ${missionId} — ${title}`, "info");
					if (priorArt) ctx.ui.notify("📚 Prior art found — injected into context.", "info");
				}
			} catch (e) {
				if (ctx.hasUI) ctx.ui.notify(`Error creating mission: ${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});

	// Resolve the target, preload its state, surface corrections and arm
	// queuedLand. Returns the prompt to send, or null when nothing resolves.
	async function prepareLandTurn(ctx: LandPrepareCtx, query: string): Promise<{ id: string; prompt: string } | null> {
		let missionId: string | null = normalizeMissionId(query);
		let missionTitle: string | undefined;

		if (!missionId) {
			const focused = getFocusedMission(ctx.sessionManager.getEntries());
			if (focused?.id) {
				missionId = focused.id;
				missionTitle = focused.title;
			} else {
				const { epics, error } = await listInProgressEpics(reader);
				if (error) {
					if (ctx.hasUI) ctx.ui.notify(`Failed to list in-progress epics: ${error}`, "warning");
					return null;
				}
				if (epics.length === 0 || !ctx.hasUI || !ctx.ui.select) return null;
				const options = epics.map((epic) => `${epic.id} — ${epic.title ?? "(untitled)"}`);
				const choice = await ctx.ui.select("Choose mission to land", options);
				if (!choice) {
					ctx.ui.notify("No mission selected.", "warning");
					return null;
				}
				missionId = String(choice).split(" — ")[0] || null;
				const picked = epics.find((e) => e.id === missionId);
				missionTitle = picked?.title;
				if (missionId) {
					setFocusedMission(pi, { id: missionId, title: missionTitle });
					currentFocus = { id: missionId, title: missionTitle };
					updateFocusStatus(ctx);
					await refreshMissionDetail();
					await notifyFocusSummary(reader, ctx, missionId, missionTitle);
				}
			}
		}

		if (!missionId) return null;
		const validated = await validateOne(reader, missionId);
		if (!validated.ok) {
			if (ctx.hasUI) ctx.ui.notify(`Invalid mission ID: ${missionId}`, "warning");
			return null;
		}
		if (currentFocus?.id !== missionId) {
			setFocusedMission(pi, { id: missionId, title: missionTitle });
			currentFocus = { id: missionId, title: missionTitle };
			updateFocusStatus(ctx);
			await refreshMissionDetail();
		}
		if (ctx.hasUI && landPromptSource === "fallback") {
			ctx.ui.notify(`Using fallback land-the-plane prompt (${landPromptFallbackReason ?? "unknown reason"}). Fix ~/Missions.md markers/fenced block.`, "warning");
		}
		let corrections = "";
		let candidates: CorrectionCandidate[] = [];
		try {
			candidates = collectCorrectionCandidates(ctx);
			corrections = renderCorrectionsSection(candidates);
			if (candidates.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`${candidates.length} correction candidates surfaced for landing.`, "info");
			}
		} catch {
			// Correction collection must not prevent the handover.
		}
		const detail = await fetchMissionDetail(reader, missionId);
		const children = await fetchMissionChildren(reader, missionId);
		queuedLand = {
			id: missionId,
			title: missionTitle,
			corrections: candidates,
			previousSnapshot: detail ? extractLatestSnapshot(detail.notes ?? "") : null,
			outcome: null,
		};
		return { id: missionId, prompt: renderLandPrompt(landPromptTemplate, missionId) + renderLandState(detail, children) + corrections };
	}

	pi.registerCommand("land", {
		description: "Update the mission with this session's state: missing findings and decisions, at most 2 lessons, one Context Snapshot. Stays in this session. Queues when busy. /land [mission-id]",
		handler: async (args, ctx) => {
			if (landRequested || queuedLand) {
				if (ctx.hasUI) ctx.ui.notify("/land already queued or running.", "warning");
				return;
			}
			landRequested = true;
			try {
				if (!ctx.isIdle()) {
					if (ctx.hasUI) ctx.ui.notify("/land queued. Waiting for the current work to finish.", "info");
					await ctx.waitForIdle();
				}
				const prepared = await prepareLandTurn(ctx, args.trim());
				if (!prepared) {
					if (ctx.hasUI) ctx.ui.notify("/land: no mission to land. Use /focus <mission> or /land <mission-id>.", "warning");
					return;
				}
				if (ctx.hasUI) ctx.ui.notify(`Landing ${prepared.id}...`, "info");
				pi.sendUserMessage(prepared.prompt);
			} finally {
				landRequested = false;
			}
		},
	});
}

/**
 * mission sidebar
 *
 * /sessions (Ctrl+F) opens a right-anchored overlay listing recent not-closed missions
 * with their sessions (from the shared pi-sessions index), and a Recent tab
 * of sessions with no mission, searchable by keyword. Enter resumes the
 * picked session in this pi process via ctx.switchSession. Built for the
 * "PC restarted, reopen my tabs" flow.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { SessionIndex, type IndexedSession } from "../../src/index.mjs";
import { resumeCommand } from "../../src/launch.mjs";
import { sessionSearchText } from "../../src/search.mjs";
import {
	buildMissionTree,
	DEFAULT_LIVE_WINDOW_MS,
	openDescendants,
	type Epic,
	type RecentRow,
	type SessionNode,
} from "./tree.ts";
import { SidebarView, type MissionActions, type SidebarState } from "./view.ts";
import { mxBin, openStore, type MxStore } from "../../../missions/lib/mx-store.ts";

const CLOSE_REASON = "Closed from /sessions";

/** Runs the mx CLI (the only writer); args are passed as argv, never through a shell. */
async function mx(pi: ExtensionAPI, args: string[]): Promise<string> {
	const res = await pi.exec(mxBin(), args, { timeout: 30000 });
	if (res.code !== 0) throw new Error(`mx ${args[0]} failed: ${(res.stderr || res.stdout).trim().split("\n").pop()}`);
	return res.stdout;
}

export function missionActions(pi: ExtensionAPI, store: () => MxStore = () => openStore()): MissionActions {
	return {
		openChildren: async (id) => openDescendants(store().listUnclosed(), id),
		close: async (id, children) => {
			// Children are forced: x means "close this mission and its open work",
			// even items blocked by something outside it. The epic close stays
			// unforced, so mx's open-children guard catches anything left behind.
			if (children.length > 0) await mx(pi, ["close", ...children, "--force", "--reason", `${CLOSE_REASON} with ${id}`]);
			await mx(pi, ["close", id, "--reason", CLOSE_REASON]);
		},
		reopen: async (id) => {
			await mx(pi, ["reopen", id, "--reason", "Reopened from /sessions"]);
		},
	};
}

/**
 * n key: resume in a new WezTerm tab through an interactive login shell, so
 * PATH matches a normal tab and the shell stays after pi exits.
 */
export function weztermOpener(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env) {
	if (!env.WEZTERM_PANE) return undefined;
	const bundled = env.WEZTERM_EXECUTABLE_DIR ? join(env.WEZTERM_EXECUTABLE_DIR, "wezterm") : "";
	const wezterm = bundled && existsSync(bundled) ? bundled : "wezterm";
	const shell = env.SHELL || "/bin/zsh";
	return async (session: SessionNode): Promise<void> => {
		const script = `${resumeCommand(session)}; exec ${shell} -il`;
		const res = await pi.exec(wezterm, ["cli", "spawn", "--cwd", session.cwd, "--", shell, "-lic", script], { timeout: 10000 });
		if (res.code !== 0) throw new Error(`wezterm cli spawn failed: ${(res.stderr || res.stdout).trim().split("\n").pop()}`);
	};
}

/** Epics straight from mx.db: well under a millisecond, no subprocess. */
function listEpics(includeClosed: boolean): Epic[] {
	return openStore().listEpics({ includeClosed });
}

type Snapshot = { sessions: IndexedSession[]; recent: RecentRow[]; currentPath?: string };

/** Session side of the state: ~150ms warm. */
async function loadSessions(ctx: ExtensionCommandContext): Promise<Snapshot> {
	const index = new SessionIndex();
	try {
		await index.refresh(join(getAgentDir(), "sessions"));
		const sessions = index.list();
		const currentPath = ctx.sessionManager.getSessionFile();
		// Only Recent-tab candidates need the (multi-MB) search text.
		const recent: RecentRow[] = sessions
			.filter((row) => row.linked.length === 0 || row.path === currentPath)
			.map((row) => ({ ...row, searchText: sessionSearchText(row) }));
		return { sessions, recent, currentPath };
	} finally {
		index.close();
	}
}

function buildState(snap: Snapshot, epics: Epic[], includeClosed: boolean): SidebarState {
	const missions = buildMissionTree(snap.sessions, epics, { now: Date.now(), currentPath: snap.currentPath, includeClosed });
	return { kind: "ready", missions, recent: snap.recent, currentPath: snap.currentPath };
}

async function openSidebar(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const picked = await ctx.ui.custom<SessionNode | undefined>(
		(tui, theme, keybindings, done) => {
			let generation = 0;
			let finished = false;
			const finish = (value: SessionNode | undefined) => {
				finished = true;
				done(value);
			};
			const view = new SidebarView({
				theme,
				keybindings,
				getRows: () => tui.terminal.rows,
				now: Date.now,
				onPick: finish,
				onCancel: () => finish(undefined),
				onToggleClosed: (includeClosed) => load(includeClosed),
				missionActions: missionActions(pi),
				openInNewTab: weztermOpener(pi),
				requestRender: () => tui.requestRender(),
			});
			// Epics are an in-process SQLite read, so the only wait is the
			// session index. Latest request wins, so a slow load never
			// overwrites a newer toggle.
			const load = (includeClosed: boolean) => {
				const mine = ++generation;
				const live = () => !finished && mine === generation;
				if (!view.hasData) view.setState({ kind: "loading" });
				loadSessions(ctx)
					.then((snap) => buildState(snap, listEpics(includeClosed), includeClosed))
					.then(
						(state) => live() && view.setState(state),
						(error: unknown) => {
							if (!live()) return;
							const message = error instanceof Error ? error.message : String(error);
							if (view.hasData) view.showError(message);
							else view.setState({ kind: "error", message });
						},
					);
			};
			load(false);
			return view;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "right-center", width: "40%", minWidth: 44, maxHeight: "90%", margin: 1 },
		},
	);

	if (!picked) return;
	if (picked.current) {
		ctx.ui.notify("Already in this session", "info");
		return;
	}
	if (picked.live) {
		const minutes = Math.round(DEFAULT_LIVE_WINDOW_MS / 60000);
		const ok = await ctx.ui.confirm(
			"Session may be open elsewhere",
			`"${picked.title}" changed in the last ${minutes} minutes, maybe in another tab. Two pi processes writing one session can corrupt it. Open here anyway?`,
		);
		if (!ok) return;
	}
	await ctx.waitForIdle();
	const result = await ctx.switchSession(picked.path);
	if (result.cancelled) ctx.ui.notify("Session switch cancelled", "warning");
}

export default function (pi: ExtensionAPI) {
	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/sessions needs the interactive TUI", "error");
			return;
		}
		await openSidebar(pi, ctx);
	};
	pi.registerCommand("sessions", {
		description: "Browse open missions or recent sessions and resume one (Ctrl+F)",
		handler,
	});
	pi.registerCommand("sidebar", {
		description: "Alias for /sessions",
		handler,
	});
	pi.registerShortcut("ctrl+f", {
		description: "Browse missions and recent sessions (/sessions)",
		handler: () => {
			// Dispatch the command to get its session-switching context. Without
			// expansion, sendUserMessage would send /sessions to the model.
			pi.sendUserMessage("/sessions", { expandPromptTemplates: true });
		},
	});
}

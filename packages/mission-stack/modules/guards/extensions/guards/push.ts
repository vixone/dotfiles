/**
 * push.ts — guard logic for pushes to protected branches (main/master).
 *
 * Parses `git push` out of a bash command and decides whether it would land on
 * a protected branch. Pure logic + a `git`-exec dependency for resolving the
 * current branch on a bare push; no UI. index.ts turns the verdict into a
 * confirm dialog (interactive) or a hard block (headless).
 *
 * Config (env):
 *   PUSH_GUARD_DISABLED=1                 disable just this guard
 *   PUSH_GUARD_PROTECTED=main,master,prod protected branch names (default main,master)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitSegments, tokenize, refBasename, extractCd } from "./shell.ts";

export function pushDisabled(): boolean {
	return process.env.PUSH_GUARD_DISABLED === "1";
}

export function protectedBranches(): Set<string> {
	const raw = process.env.PUSH_GUARD_PROTECTED;
	if (raw && raw.trim()) {
		return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
	}
	return new Set(["main", "master"]);
}

export type PushInfo = {
	cwdOverride?: string;
	explicitDsts: string[];
	hasRefspecs: boolean;
	pushesAll: boolean;
	force: boolean;
};

// Flags that consume the following token as their value.
const VALUE_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/** Parse a single tokenized segment. Returns push info if it's a `git push`,
 * else null. */
export function parsePushSegment(tokens: string[]): PushInfo | null {
	const gi = tokens.findIndex((t) => t === "git");
	if (gi === -1) return null;

	let cwdOverride: string | undefined;
	let pi = -1;
	for (let k = gi + 1; k < tokens.length; k++) {
		const t = tokens[k];
		if (t === "-C" && k + 1 < tokens.length) { cwdOverride = tokens[++k]; continue; }
		if (t === "-c" && k + 1 < tokens.length) { k++; continue; } // git -c key=val
		if (t.startsWith("-")) continue; // other global flags
		if (t === "push") { pi = k; break; }
		return null; // first non-flag subcommand isn't push
	}
	if (pi === -1) return null;

	const args = tokens.slice(pi + 1);
	const positionals: string[] = [];
	let pushesAll = false;
	let force = false;

	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (a === "--all" || a === "--mirror") { pushesAll = true; continue; }
		if (a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a.startsWith("--force-if-includes")) { force = true; continue; }
		if (VALUE_FLAGS.has(a)) { k++; continue; }
		if (a.startsWith("-")) continue; // other flags (boolean or --flag=val)
		positionals.push(a);
	}

	const refspecs = positionals.slice(1); // [0] = remote
	const explicitDsts: string[] = [];
	for (const spec of refspecs) {
		if (spec.includes(":")) {
			explicitDsts.push(refBasename(spec.slice(spec.indexOf(":") + 1)));
		} else {
			explicitDsts.push(refBasename(spec));
		}
	}

	return { cwdOverride, explicitDsts, hasRefspecs: refspecs.length > 0, pushesAll, force };
}

async function resolveCurrentTargets(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const targets: string[] = [];
	try {
		const cur = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, signal, timeout: 3000 });
		if (cur.code === 0) {
			const name = cur.stdout.trim();
			if (name && name !== "HEAD") targets.push(name);
		}
	} catch { /* ignore */ }
	try {
		const up = await pi.exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"], { cwd, signal, timeout: 3000 });
		if (up.code === 0) {
			const name = up.stdout.trim(); // e.g. origin/main
			if (name) targets.push(refBasename(name));
		}
	} catch { /* ignore */ }
	return targets;
}

export type PushVerdict = { blocked: boolean; targets: string[]; force: boolean; pushesAll: boolean };

/** Evaluate a bash command for a protected-branch push. Returns a verdict, or
 * null if no protected push is detected. */
export async function evaluatePush(
	pi: ExtensionAPI,
	command: string,
	baseCwd: string,
	signal?: AbortSignal,
): Promise<PushVerdict | null> {
	const guarded = protectedBranches();

	// Track cwd as running state: a `cd` in an earlier segment (e.g.
	// `cd repo; git push`) must apply to a later bare push so we resolve its
	// current branch in the right directory. A same-command `git -C` wins.
	let runningCwd = baseCwd;

	for (const segment of splitSegments(command)) {
		const tokens = tokenize(segment);

		// Update running cwd from any leading `cd` in this segment.
		const segCd = extractCd(tokens);
		if (segCd) {
			runningCwd = segCd.startsWith("/") ? segCd : `${runningCwd.replace(/\/$/, "")}/${segCd}`;
		}

		if (!tokens.includes("push")) continue;
		const info = parsePushSegment(tokens);
		if (!info) continue;

		// `git -C <path>` overrides for this command only; else the running cwd.
		const cwd = info.cwdOverride
			? (info.cwdOverride.startsWith("/") ? info.cwdOverride : `${runningCwd.replace(/\/$/, "")}/${info.cwdOverride}`)
			: runningCwd;

		if (info.pushesAll) {
			return { blocked: true, targets: [...guarded], force: info.force, pushesAll: true };
		}

		const dsts = info.hasRefspecs ? info.explicitDsts : await resolveCurrentTargets(pi, cwd, signal);
		const hit = dsts.filter((d) => guarded.has(d));
		if (hit.length > 0) {
			return { blocked: true, targets: [...new Set(hit)], force: info.force, pushesAll: false };
		}
	}
	return null;
}

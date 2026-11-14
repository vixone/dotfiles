/**
 * first-contact — proactive memory injection on first interaction with a system
 *
 * When the agent first touches a system (k8s namespace, repo, key config file,
 * terraform module) this session, searches the knowledge graph and injects top
 * relevant lessons into the tool result. Fires once per system per session —
 * bounded, proactive, no agent cooperation needed.
 *
 * Coordination:
 *   - Skips if /focus happened within last 60s (focus-land already injected)
 *   - Fires on successful tool results only (errors handled by memory-guard)
 *   - Additive to mutation guard (different trigger: first-contact vs pre-mutate)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

import { createMemoryClient } from "./memory-client.ts";
import { type MemoryHit } from "./memory-contract.ts";
import { type Coordinator } from "./context-coordinator.ts";

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

const SCORE_THRESHOLD = 0.88;
const MAX_RESULTS = 2;
const MAX_INJECTIONS_PER_SESSION = 5;
const FOCUS_COOLDOWN_MS = 60_000;
const SEARCH_TIMEOUT_MS = 5_000;

const FOCUS_ENTRY_TYPE = "land-focus";

// --------------------------------------------------------------------------
// Entity extraction
// --------------------------------------------------------------------------

function extractEntitiesFromBash(command: string): string[] {
	const entities: string[] = [];

	// k8s namespace
	const ns = command.match(/-n\s+(\S+)|--namespace[= ](\S+)/);
	if (ns) entities.push(ns[1] || ns[2]);

	// helm release name (helm upgrade/install RELEASE CHART)
	const helm = command.match(/helm\s+(?:upgrade|install)\s+(\S+)\s+(\S+)/);
	if (helm) entities.push(helm[1]);

	// terraform var-file
	const tfvars = command.match(/-var-file[= ](\S+)/);
	if (tfvars) entities.push(tfvars[1].replace(/.*\//, "").replace(/\.tfvars$/, ""));

	// repo directory under a common checkout root (paths or cd commands)
	const repo = command.match(REPO_DIR);
	if (repo) entities.push(repo[1]);

	// aws service (skip generic ones)
	const awsSvc = command.match(/aws\s+([a-z0-9-]+)\s/);
	if (awsSvc && !["configure", "sts", "s3", "sso"].includes(awsSvc[1])) {
		entities.push(`aws ${awsSvc[1]}`);
	}

	return entities;
}

/** First directory under a common checkout root, e.g. ~/src/<repo>/... */
const REPO_DIR = /\/(?:sandbox|src|code|projects|repos|git)\/([A-Za-z0-9][A-Za-z0-9._-]+)/;

function extractEntitiesFromPath(filePath: string): string[] {
	const entities: string[] = [];
	if (!filePath) return entities;

	const basename = filePath.split("/").pop() ?? "";

	// Key config filenames — include parent dir for disambiguation
	if (/^(kustomization|settings|values[_-]?\w*)\.ya?ml$/.test(basename)) {
		const parent = filePath.split("/").slice(-2, -1)[0] ?? "";
		entities.push(`${parent} ${basename}`.trim());
	}

	// Repo directory name
	const repoMatch = filePath.match(REPO_DIR);
	if (repoMatch) entities.push(repoMatch[1]);

	// Namespace-like directories
	const nsDir = filePath.match(/\/(arc-runners|arc-system|argocd|bootstrap)\//);
	if (nsDir) entities.push(nsDir[1]);

	// tfvars files
	if (filePath.endsWith(".tfvars")) {
		entities.push(basename.replace(/\.tfvars$/, ""));
	}

	return entities;
}

function extractEntities(event: any): string[] {
	if (isBashToolResult(event)) {
		const cmd = typeof event.input === "object" && event.input !== null
			? (event.input as { command?: string }).command ?? ""
			: "";
		return extractEntitiesFromBash(cmd);
	}

	// Read/Edit/Write — look for file_path in input
	const input = event.input as Record<string, unknown> | null;
	if (input && typeof input === "object") {
		const filePath = (input.file_path ?? input.path ?? "") as string;
		if (filePath) return extractEntitiesFromPath(filePath);
	}

	return [];
}

// --------------------------------------------------------------------------
// Result filtering
// --------------------------------------------------------------------------

export type ParsedHit = { score: number; key: string; excerpt: string };

// Filter structured memory-v1 hits for first-contact briefing: apply the score
// threshold, drop the low-signal "memory" domain, and take the top N by score.
// Replaces the old Markdown regex scraping (mission-927.8).
export function filterStructuredHits(hits: MemoryHit[]): ParsedHit[] {
	const kept: ParsedHit[] = [];
	for (const h of hits) {
		if (h.score < SCORE_THRESHOLD) continue;
		if (h.type === "lesson" && h.domain === "memory") continue;
		kept.push({ score: h.score, key: h.key, excerpt: (h.excerpt ?? "").trim().slice(0, 100) });
	}
	kept.sort((a, b) => b.score - a.score);
	return kept.slice(0, MAX_RESULTS);
}

function formatInjection(entity: string, hits: ParsedHit[]): string {
	const lines = [
		"",
		"---",
		`📌 **Context** (first time touching ${entity}):`,
	];
	for (const hit of hits) {
		lines.push(`- \`${hit.key}\`: ${hit.excerpt}`);
	}
	return lines.join("\n");
}

// --------------------------------------------------------------------------
// Session coordination
// --------------------------------------------------------------------------

function lastFocusTs(ctx: ExtensionContext): number {
	try {
		const entries = ctx.sessionManager.getEntries();
		let latest = 0;
		for (const e of entries as unknown as Array<Record<string, unknown>>) {
			if (e.type === "custom" && (e as { customType?: string }).customType === FOCUS_ENTRY_TYPE) {
				const ts = Number((e as { timestamp?: number }).timestamp ?? 0);
				if (ts > latest) latest = ts;
			}
		}
		return latest;
	} catch {
		return 0;
	}
}

// --------------------------------------------------------------------------
// Register
// --------------------------------------------------------------------------

export function registerFirstContact(pi: ExtensionAPI, coordinator?: Coordinator): void {
	if (process.env.MS_FIRST_CONTACT === "off") return;

	const memory = createMemoryClient(pi.exec.bind(pi));
	const seenSystems = new Set<string>();
	let injectionCount = 0;

	pi.on("tool_result", async (event, ctx) => {
		// Skip errors — memory-guard handles those
		if (event.isError) return;

		// Rate limit: max injections per session
		if (injectionCount >= MAX_INJECTIONS_PER_SESSION) return;

		// Respect /focus cooldown
		const focusAge = Date.now() - lastFocusTs(ctx);
		if (focusAge < FOCUS_COOLDOWN_MS) return;

		const entities = extractEntities(event);
		if (entities.length === 0) return;

		// Find first un-briefed entity
		const newEntities = entities.filter(e => !seenSystems.has(e));
		if (newEntities.length === 0) return;

		// Take the first new entity (most specific is usually first in the list).
		// NOTE: do NOT mark it seen yet — only after a SUCCESSFUL injection, so a
		// retrieval failure does not suppress retries forever (mission-927.10).
		const entity = newEntities[0];

		try {
			let hits: ParsedHit[];
			if (coordinator) {
				// Submit a file/tool first-contact signal to the shared selector
				// (env-exact precedes semantic; dedup + budget are shared).
				const sel = await coordinator.select("file", entity, { signal: ctx.signal });
				if (!sel.inject) return; // no-match/deduped/timeout -> retry allowed later
				hits = sel.items.map((it) => ({ score: it.score ?? 1, key: it.key, excerpt: it.text.slice(0, 100) }));
			} else {
				const parsed = await memory.searchStructured(entity, {
					timeout: SEARCH_TIMEOUT_MS,
					signal: ctx.signal,
				});
				if (!parsed.ok) return; // failure -> not marked seen -> retryable
				hits = filterStructuredHits(parsed.envelope.hits ?? []);
				if (hits.length === 0) return;
			}

			injectionCount++;
			seenSystems.add(entity); // mark briefed only after a successful injection

			// Append to existing tool result content
			const existingContent = Array.isArray(event.content) ? event.content : [];
			const existingText = existingContent
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");

			return {
				content: [{ type: "text", text: existingText + formatInjection(entity, hits) }],
			};
		} catch {
			return;
		}
	});
}

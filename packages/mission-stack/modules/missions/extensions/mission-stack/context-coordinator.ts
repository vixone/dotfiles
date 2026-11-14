/**
 * context-coordinator
 *
 * The single selector every retrieval hook submits signals to (mission-927.10).
 * Prompt, focus, repo, file, tool and error hooks call `select(source, query)`
 * instead of each running its own retrieval + dedup + threshold logic. The
 * coordinator centralizes:
 *
 *   - source priority: an exact scoped ENVIRONMENT match precedes a semantic
 *     guess (generic historical similarity is not current applicability);
 *   - a shared retrieval cache (TTL) so multiple hooks in one turn don't
 *     re-query the same thing;
 *   - session dedup: the same key is not reinjected within the session;
 *   - a token budget across the whole session;
 *   - graceful degradation on retrieval timeout/error;
 *   - inspectable selection reasons.
 *
 * Session-state transitions (resume/fork/compaction, focused-mission change)
 * call `resetSession()` so context rehydrates cleanly instead of staying
 * suppressed by stale dedup state. A FAILED retrieval never marks anything as
 * seen, so first contact can retry later (no permanent suppression).
 *
 * Dependencies are injected so the coordinator is fully unit-testable without a
 * pi runtime. NOT a pi extension.
 */

import { loadStackConfig, estimateTokens, type StackConfig } from "./stack-config.ts";
import { type EnvRecord, type EnvScope, type ResolveResult } from "./environment-source.ts";
import { type ParseResult, type MemoryHit } from "./memory-contract.ts";

export type SignalSource = "prompt" | "focus" | "repo" | "file" | "tool" | "error";

export type ContextItem = {
	kind: "environment" | "lesson" | "mission";
	key: string;
	scope?: string;
	text: string;
	score?: number; // semantic score; absent for exact env matches
	source: SignalSource;
};

export type SelectionReason =
	| "disabled"
	| "empty-query"
	| "env-exact"
	| "semantic"
	| "no-match"
	| "deduped"
	| "budget-exhausted"
	| "retrieval-timeout";

export type Selection = {
	inject: boolean;
	reason: SelectionReason;
	items: ContextItem[];
	query: string;
	source: SignalSource;
	stale?: boolean;
};

export type CoordinatorDeps = {
	/** Resolve an exact/alias/scope/path/lexical environment match. */
	envResolve: (query: string) => ResolveResult;
	/** Render an environment record (optionally scoped) into fact text. */
	renderEnv: (record: EnvRecord, scope?: EnvScope) => string;
	/** Structured semantic search (memory-v1). */
	semanticSearch: (query: string, opts?: { timeout?: number; signal?: AbortSignal }) => Promise<ParseResult>;
	config?: Partial<StackConfig>;
	now?: () => number;
};

type CacheEntry = { ts: number; items: ContextItem[]; reason: SelectionReason; stale?: boolean };

export type Coordinator = {
	select(source: SignalSource, query: string, opts?: { signal?: AbortSignal }): Promise<Selection>;
	/** Clear session dedup + budget (resume/fork/compaction, focused-mission change). */
	resetSession(cause?: string): void;
	/** Signal a focused-mission change; clears dedup so new context rehydrates. */
	onFocusChange(missionId: string): void;
	/** Recent decisions for inspection (newest last). */
	recentDecisions(): ReadonlyArray<Selection & { at: number }>;
	readonly config: Readonly<StackConfig>;
	readonly budgetUsed: number;
};

const norm = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, " ");

export function createCoordinator(deps: CoordinatorDeps): Coordinator {
	const config = { ...loadStackConfig(), ...deps.config };
	const now = deps.now ?? Date.now;
	const cache = new Map<string, CacheEntry>();
	let injectedKeys = new Set<string>();
	let budgetUsed = 0;
	const decisions: Array<Selection & { at: number }> = [];

	const record = (sel: Selection): Selection => {
		decisions.push({ ...sel, at: now() });
		if (decisions.length > 50) decisions.shift();
		return sel;
	};

	// Build candidate items for a query (env-first, then semantic). Cached by
	// normalized query for cacheTtlMs. Never caches a timeout/error.
	async function retrieve(
		source: SignalSource,
		nq: string,
		signal?: AbortSignal,
	): Promise<{ items: ContextItem[]; reason: SelectionReason; stale?: boolean }> {
		const cached = cache.get(nq);
		if (cached && now() - cached.ts <= config.cacheTtlMs) {
			return { items: cached.items.map((it) => ({ ...it, source })), reason: cached.reason, stale: cached.stale };
		}

		// Priority 1: exact scoped environment match.
		const env = deps.envResolve(nq);
		if (env.matchType !== "none" && env.record) {
			const text = deps.renderEnv(env.record, env.scope);
			const item: ContextItem = {
				kind: "environment",
				key: env.scope ? `${env.record.id}#${env.scope.id}` : env.record.id,
				scope: env.scope?.id,
				text,
				source,
			};
			const result = { items: [item], reason: "env-exact" as SelectionReason, stale: env.stale };
			cache.set(nq, { ts: now(), items: [item], reason: result.reason, stale: env.stale });
			return result;
		}

		// Priority 2: semantic search (applicability gated by minSemanticScore).
		let parsed: ParseResult;
		try {
			parsed = await deps.semanticSearch(nq, { timeout: config.retrievalTimeoutMs, signal });
		} catch {
			return { items: [], reason: "retrieval-timeout" }; // degrade, do not cache
		}
		if (!parsed.ok) {
			// Malformed/version-mismatch/server-error: treat as no usable context,
			// do not cache (so a transient failure can be retried).
			return { items: [], reason: "retrieval-timeout" };
		}
		const hits = (parsed.envelope.hits ?? []).filter((h) => h.score >= config.minSemanticScore);
		if (hits.length === 0) {
			cache.set(nq, { ts: now(), items: [], reason: "no-match" });
			return { items: [], reason: "no-match" };
		}
		// Merge lessons + mission children into one score-ordered list (the Go
		// producer sorts within each section; here we rank across both).
		const items = hits
			.slice()
			.sort((a, b) => b.score - a.score)
			.map((h: MemoryHit) => ({
				kind: h.type === "lesson" ? ("lesson" as const) : ("mission" as const),
				key: h.key,
				scope: h.kind,
				text: h.excerpt,
				score: h.score,
				source,
			}));
		cache.set(nq, { ts: now(), items, reason: "semantic" });
		return { items, reason: "semantic" };
	}

	return {
		config,
		get budgetUsed() {
			return budgetUsed;
		},

		async select(source, query, opts) {
			if (!config.enabled) return record({ inject: false, reason: "disabled", items: [], query, source });
			const nq = norm(query);
			if (!nq) return record({ inject: false, reason: "empty-query", items: [], query, source });

			const { items, reason, stale } = await retrieve(source, nq, opts?.signal);
			if (reason === "retrieval-timeout") {
				return record({ inject: false, reason, items: [], query, source });
			}
			if (items.length === 0) {
				return record({ inject: false, reason: "no-match", items: [], query, source, stale });
			}

			// Session dedup: drop keys already injected.
			const fresh = items.filter((it) => !injectedKeys.has(it.key));
			if (fresh.length === 0) {
				return record({ inject: false, reason: "deduped", items: [], query, source, stale });
			}

			// Token budget across the session; cap per-selection item count.
			const chosen: ContextItem[] = [];
			for (const it of fresh.slice(0, config.maxItemsPerSelection)) {
				const cost = estimateTokens(it.text);
				if (budgetUsed + cost > config.tokenBudget) break;
				budgetUsed += cost;
				injectedKeys.add(it.key);
				chosen.push(it);
			}
			if (chosen.length === 0) {
				return record({ inject: false, reason: "budget-exhausted", items: [], query, source, stale });
			}
			return record({ inject: true, reason, items: chosen, query, source, stale });
		},

		resetSession(_cause) {
			injectedKeys = new Set();
			budgetUsed = 0;
			cache.clear();
		},

		onFocusChange(_missionId) {
			// A new focused mission means previously injected context may no longer
			// be the priority; clear dedup so applicable context rehydrates. Budget
			// is preserved (still one session).
			injectedKeys = new Set();
			cache.clear();
		},

		recentDecisions() {
			return decisions;
		},
	};
}

/**
 * stack-config
 *
 * One place for the mission-stack coordination knobs (mission-927.10):
 * source priority, timeouts, shared-cache TTL, session dedup window and the
 * context token budget. Behavioral policy prose lives in
 * policies/context-selection.md; this file is just the typed, env-overridable
 * values so the coordinator and hooks read the same numbers.
 *
 * NOT a pi extension. Imported by sibling files.
 */

export type StackConfig = {
	/** Master switch for coordinated context injection. */
	enabled: boolean;
	/** Shared retrieval cache TTL (ms) so hooks in one turn don't re-query. */
	cacheTtlMs: number;
	/** Context token budget per session (rough len/4 estimate). */
	tokenBudget: number;
	/** Max items a single selection may inject. */
	maxItemsPerSelection: number;
	/** Minimum semantic score to count as applicable (generic similarity is not
	 * applicability). Env-exact matches bypass this. */
	minSemanticScore: number;
	/** Per-retrieval timeout (ms) handed to the semantic search. */
	retrievalTimeoutMs: number;
};

function envFlagDisabled(v: string | undefined): boolean {
	return v === "1" || v === "true";
}

function clampNum(raw: string | undefined, def: number, lo: number, hi: number): number {
	if (!raw) return def;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < lo || n > hi) return def;
	return n;
}

export function loadStackConfig(env: NodeJS.ProcessEnv = process.env): StackConfig {
	return {
		enabled: !envFlagDisabled(env.MS_CONTEXT_COORDINATOR_DISABLED),
		cacheTtlMs: clampNum(env.MS_CONTEXT_CACHE_TTL_MS, 15_000, 0, 600_000),
		tokenBudget: clampNum(env.MS_CONTEXT_TOKEN_BUDGET, 1_200, 0, 20_000),
		maxItemsPerSelection: clampNum(env.MS_CONTEXT_MAX_ITEMS, 3, 1, 20),
		minSemanticScore: clampNum(env.MS_CONTEXT_MIN_SCORE, 0.85, 0.5, 1.0),
		retrievalTimeoutMs: clampNum(env.MS_CONTEXT_RETRIEVAL_TIMEOUT_MS, 10_000, 500, 60_000),
	};
}

/** Rough token estimate for budget accounting (no tokenizer dependency). */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Resolved config with the precedence source of each value, for status/explain
 * (explicit precedence: env override > default). */
export type ConfigSource = { value: string | number | boolean; source: "env" | "default" };

export function resolveConfigSources(env: NodeJS.ProcessEnv = process.env): Record<keyof StackConfig, ConfigSource> {
	const cfg = loadStackConfig(env);
	const src = (key: string): "env" | "default" => (env[key] != null && env[key] !== "" ? "env" : "default");
	return {
		enabled: { value: cfg.enabled, source: src("MS_CONTEXT_COORDINATOR_DISABLED") },
		cacheTtlMs: { value: cfg.cacheTtlMs, source: src("MS_CONTEXT_CACHE_TTL_MS") },
		tokenBudget: { value: cfg.tokenBudget, source: src("MS_CONTEXT_TOKEN_BUDGET") },
		maxItemsPerSelection: { value: cfg.maxItemsPerSelection, source: src("MS_CONTEXT_MAX_ITEMS") },
		minSemanticScore: { value: cfg.minSemanticScore, source: src("MS_CONTEXT_MIN_SCORE") },
		retrievalTimeoutMs: { value: cfg.retrievalTimeoutMs, source: src("MS_CONTEXT_RETRIEVAL_TIMEOUT_MS") },
	};
}

/** L3 auto-injection is opt-in / OFF by default. */
export function isL3Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MS_AUTO_INJECT_ENABLED === "1";
}

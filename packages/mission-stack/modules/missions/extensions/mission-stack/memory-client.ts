/**
 * memory-client
 *
 * Shared client for the memory-server Go binary (~/.pi/bin/memory-server), a
 * self-contained sqlite-vec index over mx lessons + mission work.
 *
 * All extensions that talk to the memory graph route through this module so:
 *   - environment variables, paths, and timeouts are configured in one place
 *   - the structured memory-v1 JSON contract is parsed in one place
 *   - new pi tools / hooks compose with the same primitives
 *
 * Configuration precedence (highest first):
 *   1. process.env.MS_MEMORY_*  — runtime override
 *   2. Constructor cfg overrides  — programmatic override
 *   3. Hardcoded defaults         — preserve existing behavior on fresh installs
 *
 * Phase 2.1 will layer an optional config file (~/.pi/agent/mission-stack.config.json)
 * between (1) and (3). The Phase 1.1 surface is intentionally minimal: just
 * enough to dedupe the memory-guard and focus-land call sites.
 *
 * NOT exported as a pi extension. Imported by sibling files in the
 * mission-stack umbrella directory. See the [finding] mission-l4w.28
 * for why a directory-extension layout is required (jiti does not follow
 * symlinks for relative imports).
 *
 * Historical note: an earlier prototype used a Python MCP server over Neo4j;
 * that is fully replaced by the Go binary + sqlite-vec. No Python/Neo4j path
 * remains.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvelope, type ParseResult } from "./memory-contract.ts";
import { defaultMxDb } from "../../lib/mx-store.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type MemoryClientConfig = {
	/** Path to the memory-server Go binary. */
	binary: string;
	/** Path to sqlite-vec database file. */
	dbPath: string;
	/** Path to ONNX model cache directory. */
	modelDir: string;
};

const DEFAULTS: MemoryClientConfig = {
	binary: join(homedir(), ".pi", "bin", "memory-server"),
	dbPath: join(homedir(), ".pi", "state", "memory.db"),
	modelDir: join(homedir(), ".pi", "state", "models"),
};

/**
 * Resolve config from env-vars layered over defaults, with optional
 * programmatic overrides. Env-var keys are prefixed `MS_MEMORY_` to avoid
 * collision with anything else in the user's shell.
 */
export function resolveConfig(overrides: Partial<MemoryClientConfig> = {}): MemoryClientConfig {
	return {
		binary: overrides.binary ?? process.env.MS_MEMORY_BINARY ?? DEFAULTS.binary,
		dbPath: overrides.dbPath ?? process.env.MS_MEMORY_DB_PATH ?? DEFAULTS.dbPath,
		modelDir: overrides.modelDir ?? process.env.MS_MEMORY_MODEL_DIR ?? DEFAULTS.modelDir,
	};
}

// ---------------------------------------------------------------------------
// Exec abstraction
// ---------------------------------------------------------------------------

export type MemoryExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

export type MemoryExecOptions = {
	timeout?: number;
	signal?: AbortSignal;
};

/**
 * Subset of pi.exec we depend on. Kept narrow so the client is testable
 * without booting a full pi runtime.
 */
export type ExecFn = (
	command: string,
	args: string[],
	options?: MemoryExecOptions,
) => Promise<MemoryExecResult>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type CheckDuplicateOptions = MemoryExecOptions & {
	/** Optional proposed key for the new lesson. The server uses it to
	 * exclude self-matches when the agent is updating an existing key. */
	proposedKey?: string;
};

/** Native filters, forwarded to the binary (no client-side pre-filter that
 * could lose valid matches through top-k truncation). */
export type SearchOptions = MemoryExecOptions & {
	/** Restrict lessons to a domain (e.g. "eks"). */
	domain?: string;
	/** Restrict mission children to a kind (finding/decision/action). */
	typeFilter?: string;
};

export type MemoryClient = {
	/** KNN search over lessons + mission children. Returns the raw Markdown
	 * string (human output). Forwards native domain/type filters. */
	search(query: string, opts?: SearchOptions): Promise<MemoryExecResult>;
	/** Structured (contract memory-v1) search: parsed typed hits or a
	 * diagnostic error. Replaces regex-scraping the Markdown report. */
	searchStructured(query: string, opts?: SearchOptions): Promise<ParseResult>;
	/** Pre-`mx remember` duplicate check. Returns the human Markdown output. */
	checkDuplicate(text: string, opts?: CheckDuplicateOptions): Promise<MemoryExecResult>;
	/** Structured duplicate check: the shared verdict + matches, or an error. */
	checkDuplicateStructured(text: string, opts?: CheckDuplicateOptions): Promise<ParseResult>;
	/** Mission-level neighborhood — "what past missions touched this?" */
	relatedMissions(query: string, opts?: MemoryExecOptions): Promise<MemoryExecResult>;
	/** Structured related missions. */
	relatedStructured(query: string, opts?: MemoryExecOptions): Promise<ParseResult>;
	/** Read-only status/coverage snapshot (no embed, no write). */
	statusStructured(opts?: MemoryExecOptions): Promise<ParseResult>;
	/** Cross-mission graph view for an existing mission. */
	blastRadius(missionId: string, opts?: MemoryExecOptions): Promise<MemoryExecResult>;
	/** Full rebuild from the mx store. Long-running (~3min); only needed for initial setup or repair. */
	sync(opts?: MemoryExecOptions): Promise<MemoryExecResult>;
	/** Index a single lesson by key. Fast (~1.5s). Call after a successful mx remember. */
	addLesson(key: string, opts?: MemoryExecOptions): Promise<MemoryExecResult>;
	/** Index new children for a mission. Fast (~1-2s). Call after /land creates children. */
	addChildren(missionId: string, opts?: MemoryExecOptions): Promise<MemoryExecResult>;
	/** Read-only access to the resolved config (for diagnostics / doctor command). */
	readonly config: Readonly<MemoryClientConfig>;
};

/**
 * Default per-operation timeouts (ms). Callers can override via `opts.timeout`.
 * These match the values the legacy call sites used so the refactor is a
 * pure no-op behaviorally.
 */
const DEFAULT_TIMEOUTS = {
	search: 10_000,
	checkDuplicate: 10_000,
	relatedMissions: 10_000,
	blastRadius: 10_000,
	sync: 120_000,
	addLesson: 15_000,
	addChildren: 30_000,
} as const;

/**
 * Build the env-export prefix that every memory invocation needs. We use
 * exec(/bin/sh -c "..." -- "$1") so that the user-supplied query (which can
 * contain quotes, spaces, etc.) is passed as $1 and never interpolated into
 * the shell string. This is the same pattern the legacy code used.
 */




/** Single-quote a value for sh. */
const shQuote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";

export function createMemoryClient(exec: ExecFn, overrides: Partial<MemoryClientConfig> = {}): MemoryClient {
	const cfg = resolveConfig(overrides);
	const bin = cfg.binary;
	const baseArgs = [`--db`, cfg.dbPath, `--model-dir`, cfg.modelDir];

	// The memory-server reads lessons and mission children straight from the
	// mx store (--sync / --add-lesson / --add-children), so it must open the
	// same mx.db as the extensions. pi.exec does not provide a login-shell
	// env, so we run the server through `sh -c` with an explicit MX_DB (same
	// resolution as mx-store.ts) and a hardened PATH. The binary + server args
	// are passed as positional parameters ($@) and re-exec'd, so user text
	// (search queries, lesson bodies) is never re-interpolated by the shell.
	const envScript = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export MX_DB=${shQuote(defaultMxDb())}; exec "$@"`;

	const invoke = (serverArgs: string[], timeout: number, signal?: AbortSignal) =>
		exec("/bin/sh", ["-c", envScript, "sh", bin, ...serverArgs], { timeout, signal });

	// Append native filter flags when requested.
	const withFilters = (args: string[], opts?: SearchOptions): string[] => {
		const out = [...args];
		if (opts?.domain) out.push("--domain", opts.domain);
		if (opts?.typeFilter) out.push("--type", opts.typeFilter);
		return out;
	};

	return {
		config: cfg,

		async search(query, opts) {
			const args = withFilters([...baseArgs, "--search", query], opts);
			return invoke(args, opts?.timeout ?? DEFAULT_TIMEOUTS.search, opts?.signal);
		},

		async searchStructured(query, opts) {
			const args = withFilters([...baseArgs, "--search", query, "--json"], opts);
			const res = await invoke(args, opts?.timeout ?? DEFAULT_TIMEOUTS.search, opts?.signal);
			if (res.code !== 0 && !res.stdout.trim()) {
				return { ok: false, error: (res.stderr || `memory-server exited ${res.code}`).trim() };
			}
			return parseEnvelope(res.stdout, "search");
		},

		async checkDuplicate(text, opts) {
			const timeout = opts?.timeout ?? DEFAULT_TIMEOUTS.checkDuplicate;
			const args = [...baseArgs, "--check-dup", text];
			if (opts?.proposedKey) {
				args.push("--key", opts.proposedKey);
			}
			return invoke(args, timeout, opts?.signal);
		},

		async checkDuplicateStructured(text, opts) {
			const timeout = opts?.timeout ?? DEFAULT_TIMEOUTS.checkDuplicate;
			const args = [...baseArgs, "--check-dup", text, "--json"];
			if (opts?.proposedKey) {
				args.push("--key", opts.proposedKey);
			}
			const res = await invoke(args, timeout, opts?.signal);
			if (res.code !== 0 && !res.stdout.trim()) {
				return { ok: false, error: (res.stderr || `memory-server exited ${res.code}`).trim() };
			}
			return parseEnvelope(res.stdout, "check-dup");
		},

		async relatedMissions(query, opts) {
			return invoke([...baseArgs, "--related", query], opts?.timeout ?? DEFAULT_TIMEOUTS.relatedMissions, opts?.signal);
		},

		async relatedStructured(query, opts) {
			const res = await invoke([...baseArgs, "--related", query, "--json"], opts?.timeout ?? DEFAULT_TIMEOUTS.relatedMissions, opts?.signal);
			if (res.code !== 0 && !res.stdout.trim()) {
				return { ok: false, error: (res.stderr || `memory-server exited ${res.code}`).trim() };
			}
			return parseEnvelope(res.stdout, "related");
		},

		async statusStructured(opts) {
			const res = await invoke([...baseArgs, "--status", "--json"], opts?.timeout ?? DEFAULT_TIMEOUTS.blastRadius, opts?.signal);
			if (res.code !== 0 && !res.stdout.trim()) {
				return { ok: false, error: (res.stderr || `memory-server exited ${res.code}`).trim() };
			}
			return parseEnvelope(res.stdout, "status");
		},

		async blastRadius(missionId, opts) {
			return invoke([...baseArgs, "--blast-radius", missionId], opts?.timeout ?? DEFAULT_TIMEOUTS.blastRadius, opts?.signal);
		},

		async sync(opts) {
			return invoke([...baseArgs, "--sync"], opts?.timeout ?? DEFAULT_TIMEOUTS.sync, opts?.signal);
		},

		async addLesson(key, opts) {
			return invoke([...baseArgs, "--add-lesson", key], opts?.timeout ?? DEFAULT_TIMEOUTS.addLesson, opts?.signal);
		},

		async addChildren(missionId, opts) {
			return invoke([...baseArgs, "--add-children", missionId], opts?.timeout ?? DEFAULT_TIMEOUTS.addChildren, opts?.signal);
		},
	};
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Tells you whether stdout from a memory operation indicates "no results"
 * (the various sentinel strings the python side emits). Useful for callers
 * that want to short-circuit before doing further filtering.
 */
export function isEmptyMemoryResult(stdout: string): boolean {
	const trimmed = stdout.trim();
	if (!trimmed) return true;
	if (trimmed.includes("No relevant prior art")) return true;
	if (trimmed.startsWith("_No graph footprint")) return true;
	if (trimmed.startsWith("_`") && trimmed.endsWith("no cross-mission neighbors above the score floor._")) return true;
	return false;
}

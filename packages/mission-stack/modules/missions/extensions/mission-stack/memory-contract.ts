/**
 * memory-contract
 *
 * The single, versioned contract between the Go memory-server and every TS
 * consumer. Replaces the old regex-scraping of human Markdown reports
 * (mission-927.8). Consumers call the binary with `--json`, parse the envelope
 * here, and get typed hits + a shared duplicate verdict. A malformed or
 * version-mismatched response yields a visible diagnostic error instead of a
 * silent empty result.
 *
 * NOT a pi extension. Imported by sibling files in the mission-stack
 * umbrella directory.
 */

export const CONTRACT_VERSION = "memory-v1";

/** Mirror of the Go SchemaVersion const (memory-server main.go). Used to detect
 * an index built by an older/newer binary. */
export const INDEX_SCHEMA_VERSION = "2";

/** Duplicate tiers. Mirror of the Go Dup* consts; the single calibrated set
 * shared by the preview (check-dup) and the write gate. */
export const DUP_TIERS = { merge: 0.96, likely: 0.93, related: 0.9 } as const;

export type HitType = "lesson" | "mission_child";
export type DupVerdict = "existing_key" | "merge" | "likely" | "related" | "none";

export type MemoryHit = {
	type: HitType;
	key: string;
	domain?: string;
	mission_id?: string;
	kind?: string;
	status?: string;
	score: number; // full precision
	excerpt: string;
	provenance: string;
	tier?: DupVerdict;
};

export type MemoryMission = {
	id: string;
	title: string;
	status?: string;
	top_score: number;
	children?: MemoryHit[];
};

export type DuplicateResult = {
	proposed_key?: string;
	verdict: DupVerdict;
	top_score: number;
	tiers: { merge: number; likely: number; related: number };
	matches: MemoryHit[];
	exact_key?: MemoryHit;
};

export type MemoryStatus = {
	indexed: boolean;
	lessons: number;
	children: number;
	missions: number;
	similar_edges: number;
	related_edges: number;
	last_sync_ts: string;
	sync_status: string;
	embed_model: string;
	embed_dims: string;
	index_schema_version: string;
};

export type MemoryEnvelope = {
	contract_version: string;
	command: string;
	model: string;
	embed_dims: number;
	schema_version: string;
	sync_status?: string;
	query?: string;
	filters?: { domain?: string; kind?: string };
	hits?: MemoryHit[];
	missions?: MemoryMission[];
	duplicate?: DuplicateResult;
	status?: MemoryStatus;
	error: { code: string; message: string } | null;
};

export type ParseResult =
	| { ok: true; envelope: MemoryEnvelope }
	| { ok: false; error: string };

/**
 * Parse a --json response. Returns a diagnostic error (never throws) on empty
 * output, malformed JSON, a wrong/missing contract version, or a server-side
 * error field. Callers treat !ok as "degrade gracefully, surface the reason".
 */
export function parseEnvelope(stdout: string, command?: string): ParseResult {
	const trimmed = (stdout ?? "").trim();
	if (!trimmed) {
		return { ok: false, error: "empty response from memory-server" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (e) {
		return { ok: false, error: `malformed JSON from memory-server: ${(e as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, error: "memory-server response was not a JSON object" };
	}
	const env = parsed as MemoryEnvelope;
	if (env.contract_version !== CONTRACT_VERSION) {
		return {
			ok: false,
			error: `contract version mismatch: expected ${CONTRACT_VERSION}, got ${env.contract_version ?? "(none)"} - rebuild memory-server`,
		};
	}
	if (command && env.command && env.command !== command) {
		return { ok: false, error: `unexpected command in response: wanted ${command}, got ${env.command}` };
	}
	if (env.error) {
		return { ok: false, error: `memory-server error [${env.error.code}]: ${env.error.message}` };
	}
	return { ok: true, envelope: env };
}

/** Top hit across lessons + mission children (already score-sorted by the
 * server within each list; this merges the two lists by score). */
export function topHit(env: MemoryEnvelope): MemoryHit | null {
	const hits = env.hits ?? [];
	if (hits.length === 0) return null;
	return hits.reduce((best, h) => (h.score > best.score ? h : best), hits[0]);
}

/** True when the verdict means the write gate should block a new-key remember. */
export function verdictBlocks(verdict: DupVerdict): boolean {
	return verdict === "merge" || verdict === "likely";
}

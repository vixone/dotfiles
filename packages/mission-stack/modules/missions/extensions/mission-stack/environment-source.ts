/**
 * environment-source
 *
 * Loads validated, scoped environment records from knowledge/environment/*.md
 * (mission-927.9). Each record is Markdown with an environment-v1 frontmatter
 * block (see contracts/environment-v1.schema.json): stable id, aliases,
 * applicable scopes, sources, verified_at and typed relations. The body holds
 * concise facts. `lintNoCommands` rejects executable command syntax in the
 * title and each scope summary (the free-text fields most likely to be pasted
 * from a shell); it does NOT scan id/aliases/sources or the body. Credentials
 * in any field are caught separately by the remember-gate secret scan on write.
 *
 * Resolution order: path form (`id#scope`) first when the query contains `#`,
 * then exact id, record alias, scope alias, a substring lexical fallback over
 * titles/aliases/scope ids, and finally a token fallback that matches individual
 * query words against the controlled anchor vocabulary (record id/aliases, scope
 * ids/aliases) so natural-language questions ("argo tenant apps") resolve without
 * embedding env records. Everything runs before any semantic fallback elsewhere.
 * Same-named facts in different environments stay distinct because they live in
 * separate scopes.
 * Adding a valid Markdown record needs no code change (the loader globs the
 * directory).
 *
 * NOT a pi extension. Imported by sibling files in the mission-stack
 * umbrella directory.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnvScope = { id: string; aliases: string[]; summary: string };
export type EnvRelationType = "relates-to" | "supersedes" | "depends-on";
export type EnvRelation = { type: EnvRelationType; target: string };

export type EnvRecord = {
	id: string;
	title: string;
	aliases: string[];
	scopes: EnvScope[];
	sources: string[];
	verifiedAt: string;
	relations: EnvRelation[];
	body: string;
	path: string;
};

export type MatchType = "id" | "alias" | "scope-alias" | "path" | "lexical" | "token" | "none";

export type ResolveResult = {
	matchType: MatchType;
	record?: EnvRecord;
	scope?: EnvScope;
	/** True when the record's verified_at is older than the freshness window. */
	stale?: boolean;
};

export type LoadResult = {
	records: Map<string, EnvRecord>;
	errors: string[];
};

const RELATION_TYPES: EnvRelationType[] = ["relates-to", "supersedes", "depends-on"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Metadata must be plain facts. Reject anything that looks like an executable
// command / shell injection (no credentials either, but those are caught by
// the remember-gate secret scanner on write).
const COMMAND_LIKE_RE = /[`]|\$\(|\$\{/;

// ---------------------------------------------------------------------------
// Frontmatter parser (small YAML subset: scalars, inline [a, b] arrays,
// block lists of scalars, and block lists of maps). Deterministic and
// dependency-free; the record shapes here are fully under our control.
// ---------------------------------------------------------------------------

type Frontmatter = Record<string, unknown>;

export function splitFrontmatter(md: string): { frontmatter: string; body: string } | null {
	const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) return null;
	return { frontmatter: m[1], body: m[2].trim() };
}

function stripQuotes(s: string): string {
	const t = s.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1);
	}
	return t;
}

function parseInlineArray(s: string): string[] {
	const inner = s.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
	if (!inner) return [];
	return inner.split(",").map((x) => stripQuotes(x)).filter((x) => x.length > 0);
}

function parseScalarOrArray(raw: string): string | string[] {
	const t = raw.trim();
	if (t.startsWith("[")) return parseInlineArray(t);
	return stripQuotes(t);
}

const indentOf = (line: string): number => line.length - line.replace(/^ +/, "").length;

/** Parse the frontmatter subset into a plain object. Throws on structure it
 * does not understand so malformed metadata surfaces as a validation error. */
export function parseFrontmatter(fm: string): Frontmatter {
	const out: Frontmatter = {};
	const lines = fm.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (indentOf(line) !== 0) throw new Error(`unexpected indentation: ${line}`);
		const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
		if (!kv) throw new Error(`malformed line: ${line}`);
		const key = kv[1];
		const rest = kv[2];
		if (rest !== "") {
			out[key] = parseScalarOrArray(rest);
			i++;
			continue;
		}
		// Block value: collect indented lines.
		const block: string[] = [];
		i++;
		while (i < lines.length && indentOf(lines[i]) >= 2) {
			block.push(lines[i]);
			i++;
		}
		out[key] = parseBlockList(block);
	}
	return out;
}

/** Parse an indented block into an array of scalars or maps. */
function parseBlockList(block: string[]): unknown {
	const items: unknown[] = [];
	let current: Record<string, unknown> | null = null;
	for (const line of block) {
		const trimmed = line.trim();
		if (trimmed.startsWith("- ")) {
			const after = trimmed.slice(2).trim();
			const kv = after.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
			if (kv) {
				current = { [kv[1]]: parseScalarOrArray(kv[2]) };
				items.push(current);
			} else {
				items.push(stripQuotes(after));
				current = null;
			}
		} else if (current) {
			const kv = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
			if (!kv) throw new Error(`malformed block entry: ${line}`);
			current[kv[1]] = parseScalarOrArray(kv[2]);
		} else {
			throw new Error(`orphan block line: ${line}`);
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function asStringArray(v: unknown): string[] {
	if (v == null) return [];
	if (Array.isArray(v)) return v.map((x) => String(x));
	return [String(v)];
}

function lintNoCommands(label: string, value: string, errors: string[]): void {
	if (COMMAND_LIKE_RE.test(value)) {
		errors.push(`${label}: metadata must not contain executable command syntax (backticks / $()/ \${}): ${value}`);
	}
}

/** Validate a parsed frontmatter object against environment-v1. Returns the
 * record (best-effort) plus any errors. */
export function validateRecord(fm: Frontmatter, path: string): { record?: EnvRecord; errors: string[] } {
	const errors: string[] = [];
	const id = typeof fm.id === "string" ? fm.id : "";
	if (!ID_RE.test(id)) errors.push(`${path}: invalid or missing id`);

	const title = typeof fm.title === "string" ? fm.title : "";
	if (title.length < 3) errors.push(`${path}: missing/short title`);
	lintNoCommands(`${path} title`, title, errors);

	const aliases = asStringArray(fm.aliases);
	for (const a of aliases) {
		if (!ALIAS_RE.test(a)) errors.push(`${path}: invalid alias "${a}"`);
	}
	if (new Set(aliases).size !== aliases.length) errors.push(`${path}: duplicate aliases`);

	const sources = asStringArray(fm.sources);
	if (sources.length === 0) errors.push(`${path}: at least one source is required`);

	const verifiedAt = typeof fm.verified_at === "string" ? fm.verified_at : "";
	if (!DATE_RE.test(verifiedAt)) errors.push(`${path}: verified_at must be YYYY-MM-DD`);

	const scopes: EnvScope[] = [];
	const rawScopes = Array.isArray(fm.scopes) ? fm.scopes : [];
	const scopeIds = new Set<string>();
	for (const s of rawScopes as Array<Record<string, unknown>>) {
		const sid = typeof s.id === "string" ? s.id : "";
		const summary = typeof s.summary === "string" ? s.summary : "";
		if (!ID_RE.test(sid)) errors.push(`${path}: invalid scope id "${sid}"`);
		if (summary.length < 3) errors.push(`${path}: scope "${sid}" missing summary`);
		lintNoCommands(`${path} scope ${sid} summary`, summary, errors);
		if (scopeIds.has(sid)) errors.push(`${path}: duplicate scope id "${sid}"`);
		scopeIds.add(sid);
		const sAliases = asStringArray(s.aliases);
		for (const a of sAliases) if (!ALIAS_RE.test(a)) errors.push(`${path}: invalid scope alias "${a}"`);
		scopes.push({ id: sid, aliases: sAliases, summary });
	}

	const relations: EnvRelation[] = [];
	const rawRelations = Array.isArray(fm.relations) ? fm.relations : [];
	for (const r of rawRelations as Array<Record<string, unknown>>) {
		const type = typeof r.type === "string" ? r.type : "";
		const target = typeof r.target === "string" ? r.target : "";
		if (!RELATION_TYPES.includes(type as EnvRelationType)) errors.push(`${path}: invalid relation type "${type}"`);
		if (!ID_RE.test(target)) errors.push(`${path}: invalid relation target "${target}"`);
		relations.push({ type: type as EnvRelationType, target });
	}

	if (errors.length > 0) return { errors };
	return {
		record: { id, title, aliases, scopes, sources, verifiedAt, relations, body: "", path },
		errors: [],
	};
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Load and validate every *.md environment record in a directory. Detects
 * duplicate ids and dangling relation targets across the whole set. */
export function loadEnvironmentRecords(dir: string): LoadResult {
	const records = new Map<string, EnvRecord>();
	const errors: string[] = [];
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
	} catch (e) {
		return { records, errors: [`cannot read ${dir}: ${(e as Error).message}`] };
	}

	for (const file of files) {
		const path = join(dir, file);
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (e) {
			errors.push(`${path}: ${(e as Error).message}`);
			continue;
		}
		const split = splitFrontmatter(raw);
		if (!split) {
			errors.push(`${path}: missing frontmatter block`);
			continue;
		}
		let fm: Frontmatter;
		try {
			fm = parseFrontmatter(split.frontmatter);
		} catch (e) {
			errors.push(`${path}: frontmatter parse error: ${(e as Error).message}`);
			continue;
		}
		const { record, errors: recErrors } = validateRecord(fm, path);
		errors.push(...recErrors);
		if (!record) continue;
		record.body = split.body;
		if (records.has(record.id)) {
			errors.push(`${path}: duplicate record id "${record.id}" (also in ${records.get(record.id)!.path})`);
			continue;
		}
		records.set(record.id, record);
	}

	// Dangling relation targets (checked once every id is known).
	for (const rec of records.values()) {
		for (const rel of rec.relations) {
			if (!records.has(rel.target)) {
				errors.push(`${rec.path}: dangling relation target "${rel.target}"`);
			}
		}
	}

	return { records, errors };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export const DEFAULT_FRESHNESS_DAYS = 180;

export function isStale(record: EnvRecord, now = Date.now(), maxAgeDays = DEFAULT_FRESHNESS_DAYS): boolean {
	const t = Date.parse(record.verifiedAt + "T00:00:00Z");
	if (Number.isNaN(t)) return true;
	return now - t > maxAgeDays * 24 * 60 * 60 * 1000;
}

/** Split a query into anchor-shaped tokens. Preserves the `. _ -` characters
 * that appear inside aliases (e.g. `api-prod-eu`) so a hyphenated alias
 * stays one token, while spaces and other punctuation break words apart. */
function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9._-]+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);
}

/**
 * Resolve a query to a record (and scope when matched via a scope). Order:
 * path form (`id#scope`) first when the query contains `#`, then exact id,
 * record alias, scope alias, a substring lexical fallback over titles/aliases/
 * scope ids, and finally a token fallback that matches individual query words
 * against the controlled anchor vocabulary (record id/aliases, scope ids/
 * aliases). Free-text titles/summaries are excluded from token matching to keep
 * it precise. Returns matchType "none" when nothing matches, so callers can fall
 * back to semantic search explicitly instead of guessing.
 */
export function resolve(records: Map<string, EnvRecord>, query: string, now = Date.now()): ResolveResult {
	const q = query.trim().toLowerCase();
	if (!q) return { matchType: "none" };

	// Path form: id#scope
	if (q.includes("#")) {
		const [left, right] = q.split("#", 2);
		const rec = findByIdOrAlias(records, left);
		if (rec) {
			const scope = findScope(rec, right);
			if (scope) return { matchType: "path", record: rec, scope, stale: isStale(rec, now) };
			return { matchType: "path", record: rec, stale: isStale(rec, now) };
		}
	}

	// Exact id.
	const byId = records.get(q);
	if (byId) return { matchType: "id", record: byId, stale: isStale(byId, now) };

	// Record alias.
	for (const rec of records.values()) {
		if (rec.aliases.includes(q)) return { matchType: "alias", record: rec, stale: isStale(rec, now) };
	}

	// Scope alias / scope id.
	for (const rec of records.values()) {
		const scope = findScope(rec, q);
		if (scope) return { matchType: "scope-alias", record: rec, scope, stale: isStale(rec, now) };
	}

	// Lexical fallback (substring over title / aliases / scope ids).
	for (const rec of records.values()) {
		const hay = [rec.title.toLowerCase(), ...rec.aliases, ...rec.scopes.map((s) => s.id)].join(" ");
		if (hay.includes(q)) return { matchType: "lexical", record: rec, stale: isStale(rec, now) };
	}

	// Token fallback: match individual query words against the controlled anchor
	// vocabulary (record id/aliases, scope ids/aliases). Generic words like
	// "tenant" or "apps" are not anchors, so they never match; only curated
	// anchors do. The record with the most distinct token hits wins (ties resolve
	// to map insertion order for determinism).
	const tokens = tokenize(q);
	if (tokens.length > 0) {
		let best: { rec: EnvRecord; scope?: EnvScope; hits: number } | undefined;
		for (const rec of records.values()) {
			const anchors = new Set<string>([rec.id, ...rec.aliases]);
			for (const s of rec.scopes) {
				anchors.add(s.id);
				for (const a of s.aliases) anchors.add(a);
			}
			let hits = 0;
			let matchedScope: EnvScope | undefined;
			for (const t of tokens) {
				if (!anchors.has(t)) continue;
				hits++;
				if (!matchedScope) matchedScope = rec.scopes.find((s) => s.id === t || s.aliases.includes(t));
			}
			if (hits > 0 && (!best || hits > best.hits)) best = { rec, scope: matchedScope, hits };
		}
		if (best) return { matchType: "token", record: best.rec, scope: best.scope, stale: isStale(best.rec, now) };
	}

	return { matchType: "none" };
}

function findByIdOrAlias(records: Map<string, EnvRecord>, key: string): EnvRecord | undefined {
	const byId = records.get(key);
	if (byId) return byId;
	for (const rec of records.values()) if (rec.aliases.includes(key)) return rec;
	return undefined;
}

function findScope(rec: EnvRecord, key: string): EnvScope | undefined {
	return rec.scopes.find((s) => s.id === key || s.aliases.includes(key));
}

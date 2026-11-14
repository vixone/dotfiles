/**
 * In-process, read-only access to the mx mission store (~/.missions/mx.db).
 * mx is the only writer; extensions read here (sub-millisecond) and write by
 * running the mx CLI. Connections are opened lazily and cached per path.
 * WAL mode means every statement sees the latest committed mx write.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export const SCHEMA_VERSION = "1";

export class MxStoreMissing extends Error {
	readonly path: string;
	constructor(path: string) {
		super(`mx store not found at ${path} (set MX_DB, or create it with mx import / mx create)`);
		this.name = "MxStoreMissing";
		this.path = path;
	}
}

/** MX_DB if set, else ~/.missions/mx.db. */
export function defaultMxDb(env: NodeJS.ProcessEnv = process.env): string {
	if (env.MX_DB) return env.MX_DB;
	return join(env.HOME || homedir(), ".missions", "mx.db");
}

/** The mx CLI for writes: MX_BIN, else ~/.local/bin/mx when present, else PATH. */
export function mxBin(env: NodeJS.ProcessEnv = process.env): string {
	if (env.MX_BIN) return env.MX_BIN;
	const local = join(env.HOME || homedir(), ".local", "bin", "mx");
	return existsSync(local) ? local : "mx";
}

export type EpicRow = { id: string; title: string; status: string; updated_at: string };

/** Enough of an issue to walk the hierarchy. */
export type IssueLink = { id: string; parent: string | null; status: string };

export type IssueRow = {
	id: string;
	title: string;
	description: string;
	status: string;
	priority: number;
	issue_type: string;
	parent: string | null;
	assignee: string | null;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	close_reason: string | null;
	labels: string[];
};

export type Comment = { author: string; text: string; created_at: string };

export type IssueDetail = IssueRow & {
	design: string;
	acceptance_criteria: string;
	notes: string;
	owner: string | null;
	created_by: string | null;
	started_at: string | null;
	comments: Comment[];
};

const UNCLOSED = "('open','in_progress','blocked','deferred')";
const ROW_COLUMNS = `id, title, description, status, priority, issue_type, parent_id as parent, assignee,
	created_at, updated_at, closed_at, close_reason`;

type Raw = Record<string, unknown>;

export class MxStore {
	readonly path: string;
	readonly db: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();

	constructor(path: string, db: DatabaseSync) {
		this.path = path;
		this.db = db;
	}

	private all(sql: string, ...params: SQLInputValue[]): Raw[] {
		let stmt = this.statements.get(sql);
		if (!stmt) {
			stmt = this.db.prepare(sql);
			this.statements.set(sql, stmt);
		}
		return stmt.all(...params) as Raw[];
	}

	private labelsFor(ids: string[]): Map<string, string[]> {
		const out = new Map<string, string[]>();
		if (ids.length === 0) return out;
		const rows = this.all(
			"select issue_id, label from labels where issue_id in (select value from json_each(?)) order by issue_id, label",
			JSON.stringify(ids),
		);
		for (const r of rows) {
			const id = String(r.issue_id);
			const list = out.get(id) ?? [];
			list.push(String(r.label));
			out.set(id, list);
		}
		return out;
	}

	private rows(raw: Raw[]): IssueRow[] {
		const labels = this.labelsFor(raw.map((r) => String(r.id)));
		return raw.map((r) => toRow(r, labels.get(String(r.id)) ?? []));
	}

	/** Epics, newest update first. Closed ones only with includeClosed. */
	listEpics(opts: { includeClosed?: boolean } = {}): EpicRow[] {
		const where = opts.includeClosed ? "" : `and status in ${UNCLOSED}`;
		return this.all(
			`select id, title, status, updated_at from issues where issue_type='epic' ${where} order by updated_at desc, id`,
		).map((r) => ({ id: String(r.id), title: String(r.title), status: String(r.status), updated_at: String(r.updated_at) }));
	}

	/** Every non-closed issue with its parent, for descendant walks. */
	listUnclosed(): IssueLink[] {
		return this.all(`select id, parent_id, status from issues where status in ${UNCLOSED} order by id`).map((r) => ({
			id: String(r.id),
			parent: r.parent_id == null ? null : String(r.parent_id),
			status: String(r.status),
		}));
	}

	/** Full issue with labels and comments, or null when the id is unknown. */
	showIssue(id: string): IssueDetail | null {
		const raw = this.all(
			`select ${ROW_COLUMNS}, design, acceptance_criteria, notes, owner, created_by, started_at from issues where id=?`,
			id,
		)[0];
		if (!raw) return null;
		const [row] = this.rows([raw]);
		const comments = this.all(
			"select author, text, created_at from comments where issue_id=? order by created_at, id",
			id,
		).map((c) => ({ author: String(c.author), text: String(c.text), created_at: String(c.created_at) }));
		return {
			...row,
			design: String(raw.design ?? ""),
			acceptance_criteria: String(raw.acceptance_criteria ?? ""),
			notes: String(raw.notes ?? ""),
			owner: nullable(raw.owner),
			created_by: nullable(raw.created_by),
			started_at: nullable(raw.started_at),
			comments,
		};
	}

	/** Direct children, ordered by numeric id suffix (.2 before .10). */
	children(id: string): IssueRow[] {
		return this.rows(
			this.all(
				`select ${ROW_COLUMNS} from issues where parent_id=? order by cast(substr(id, length(?) + 2) as integer), id`,
				id,
				id,
			),
		);
	}

	/** Epic rows (with description and labels), optionally by status. */
	epicRows(opts: { statuses?: string[] } = {}): IssueRow[] {
		if (opts.statuses) {
			return this.rows(
				this.all(
					`select ${ROW_COLUMNS} from issues where issue_type='epic'
					 and status in (select value from json_each(?)) order by priority, updated_at desc, id`,
					JSON.stringify(opts.statuses),
				),
			);
		}
		return this.rows(this.all(`select ${ROW_COLUMNS} from issues where issue_type='epic' order by priority, updated_at desc, id`));
	}

	/** Epics whose title or id contains q (case-insensitive, no wildcards). */
	searchEpics(q: string, opts: { includeClosed?: boolean } = {}): IssueRow[] {
		const where = opts.includeClosed ? "" : `and status in ${UNCLOSED}`;
		return this.rows(
			this.all(
				`select ${ROW_COLUMNS} from issues where issue_type='epic' ${where}
				 and (instr(lower(title), lower(?)) > 0 or instr(lower(id), lower(?)) > 0)
				 order by priority, updated_at desc, id`,
				q,
				q,
			),
		);
	}

	close(): void {
		this.statements.clear();
		this.db.close();
		cache.delete(this.path);
	}
}

function nullable(v: unknown): string | null {
	return v == null || v === "" ? null : String(v);
}

function toRow(r: Raw, labels: string[]): IssueRow {
	return {
		id: String(r.id),
		title: String(r.title),
		description: String(r.description ?? ""),
		status: String(r.status),
		priority: Number(r.priority),
		issue_type: String(r.issue_type),
		parent: nullable(r.parent),
		assignee: nullable(r.assignee),
		created_at: String(r.created_at),
		updated_at: String(r.updated_at),
		closed_at: nullable(r.closed_at),
		close_reason: nullable(r.close_reason),
		labels,
	};
}

/** The read surface extensions depend on; tests pass stubs of it. */
export type MissionReader = Pick<MxStore, "listEpics" | "epicRows" | "listUnclosed" | "showIssue" | "children" | "searchEpics">;

const cache = new Map<string, MxStore>();

/** Read-only store at path (default: MX_DB or ~/.missions/mx.db). */
export function openStore(path: string = defaultMxDb()): MxStore {
	const hit = cache.get(path);
	if (hit) return hit;
	if (!existsSync(path)) throw new MxStoreMissing(path);
	const db = new DatabaseSync(path, { readOnly: true });
	db.exec("pragma busy_timeout = 5000");
	const version = (db.prepare("select value from meta where key='schema_version'").get() as Raw | undefined)?.value;
	if (String(version) !== SCHEMA_VERSION) {
		db.close();
		throw new Error(`${path}: schema_version ${String(version)} is not ${SCHEMA_VERSION}; update mission-stack`);
	}
	const store = new MxStore(path, db);
	cache.set(path, store);
	return store;
}

/**
 * knowledge-status
 *
 * One read-only status / explain surface for the mission-stack (mission-927.12).
 * It reports active modules, L3 state, loaded environment records + load
 * reasons, source/index coverage, model/schema/binary identity, the last
 * complete reconciliation and actionable failures. It NEVER writes or embeds:
 * the numbers come from the read-only `memory-server --status --json` snapshot
 * plus in-process config/env-record state.
 *
 * `explainSelection` turns a coordinator decision reason into a human
 * explanation so "why was/ wasn't context injected" is answerable.
 *
 * NOT a pi extension. Imported by index.ts.
 */

import { INDEX_SCHEMA_VERSION, type MemoryStatus } from "./memory-contract.ts";
import { type StackConfig } from "./stack-config.ts";
import { type SelectionReason } from "./context-coordinator.ts";

export type ModuleState = { name: string; enabled: boolean; note?: string };

export type StatusInput = {
	config: StackConfig;
	l3Enabled: boolean;
	modules: ModuleState[];
	environment: { records: string[]; errors: string[] };
	/** Parsed server status, or an error string if --status failed. */
	server: { ok: true; status: MemoryStatus } | { ok: false; error: string };
	/** The binary's contract/schema version (from any envelope). */
	binarySchemaVersion?: string;
};

export type StatusReport = {
	l3Enabled: boolean;
	modules: ModuleState[];
	environmentRecords: string[];
	coverage:
		| { indexed: boolean; lessons: number; children: number; missions: number; lastSync: string; syncStatus: string }
		| { error: string };
	identity:
		| { model: string; embedDims: string; indexSchema: string; binarySchema: string; schemaMatch: boolean }
		| { error: string };
	failures: string[];
};

export function buildStatus(input: StatusInput): StatusReport {
	const failures: string[] = [];

	for (const e of input.environment.errors) failures.push(`environment record: ${e}`);
	if (input.environment.records.length === 0) failures.push("no environment records loaded (retrieval will be semantic-only)");

	let coverage: StatusReport["coverage"];
	let identity: StatusReport["identity"];
	if (!input.server.ok) {
		coverage = { error: input.server.error };
		identity = { error: input.server.error };
		failures.push(`memory-server status unavailable: ${input.server.error}`);
	} else {
		const s = input.server.status;
		if (!s.indexed) {
			coverage = { error: "index not built (run a full memory_sync)" };
			failures.push("index not built - run a full memory_sync");
		} else {
			coverage = {
				indexed: true,
				lessons: s.lessons,
				children: s.children,
				missions: s.missions,
				lastSync: s.last_sync_ts,
				syncStatus: s.sync_status,
			};
			if (s.sync_status && s.sync_status !== "complete") {
				failures.push(`last reconciliation was ${s.sync_status} - run a full memory_sync to complete coverage`);
			}
			if (s.lessons === 0) failures.push("index has zero lessons - likely a stale or empty DB");
		}
		const binarySchema = input.binarySchemaVersion ?? INDEX_SCHEMA_VERSION;
		const schemaMatch = !s.index_schema_version || s.index_schema_version === binarySchema;
		identity = {
			model: s.embed_model,
			embedDims: s.embed_dims,
			indexSchema: s.index_schema_version,
			binarySchema,
			schemaMatch,
		};
		if (!schemaMatch) {
			failures.push(`index schema v${s.index_schema_version} != binary schema v${binarySchema} - rebuild the index`);
		}
	}

	return {
		l3Enabled: input.l3Enabled,
		modules: input.modules,
		environmentRecords: input.environment.records,
		coverage,
		identity,
		failures,
	};
}

export function renderStatus(report: StatusReport): string {
	const lines: string[] = ["## Mission-stack status", ""];
	lines.push(`- L3 auto-inject: ${report.l3Enabled ? "ON" : "OFF (opt-in)"}`);
	lines.push(`- modules: ${report.modules.map((m) => `${m.name}${m.enabled ? "" : " (off)"}`).join(", ")}`);
	lines.push(`- environment records (${report.environmentRecords.length}): ${report.environmentRecords.join(", ") || "none"}`);
	if ("error" in report.coverage) {
		lines.push(`- coverage: ${report.coverage.error}`);
	} else {
		const c = report.coverage;
		lines.push(`- coverage: ${c.lessons} lessons, ${c.children} children, ${c.missions} missions (last sync ${c.lastSync || "never"}, ${c.syncStatus || "unknown"})`);
	}
	if ("error" in report.identity) {
		lines.push(`- identity: ${report.identity.error}`);
	} else {
		const i = report.identity;
		lines.push(`- identity: model ${i.model || "?"} (${i.embedDims || "?"} dims), index schema v${i.indexSchema || "?"}, binary schema v${i.binarySchema}${i.schemaMatch ? "" : " [MISMATCH]"}`);
	}
	lines.push("");
	if (report.failures.length === 0) {
		lines.push("No actionable failures.");
	} else {
		lines.push("### Actionable failures");
		for (const f of report.failures) lines.push(`- ${f}`);
	}
	return lines.join("\n");
}

const REASON_EXPLANATIONS: Record<SelectionReason, string> = {
	disabled: "context coordination is disabled (MS_CONTEXT_COORDINATOR_DISABLED=1)",
	"empty-query": "the query was empty after normalization",
	"env-exact": "injected an exact scoped environment fact (env matches precede semantic)",
	semantic: "injected a semantic match above the applicability threshold",
	"no-match": "no environment match and no semantic hit above the threshold - zero context",
	deduped: "the top hit was already injected earlier this session",
	"budget-exhausted": "the session context token budget is spent",
	"retrieval-timeout": "retrieval timed out or errored - degraded to no context (retryable)",
};

export function explainSelection(reason: SelectionReason): string {
	return REASON_EXPLANATIONS[reason] ?? `unknown reason: ${reason}`;
}

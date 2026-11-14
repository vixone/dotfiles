/**
 * mission-stack — umbrella extension
 *
 * Wires the mission-stack feature set into pi as a single extension. From
 * pi's perspective this directory is one extension; internally each feature
 * lives in its own sibling .ts file with a `register*(pi)` entry point so
 * we can keep separation of concerns while sharing `./memory-client.ts`.
 *
 * Why a single umbrella: jiti (pi's TS loader) does not follow symlinks
 * when resolving relative imports, so siblings cannot share code if they
 * are symlinked individually. Symlinking the whole directory works. See
 * mission-l4w.28 [finding] and the lesson key
 * `pi-jiti-symlink-resolution-requires-directory-symlinks`.
 *
 * Adding a new feature: create `<feature>.ts` next to this file, export a
 * `register<Feature>(pi: ExtensionAPI)` function from it, and call it from
 * the factory below.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCorrectionDetector } from "./correction-detector.ts";
import { registerFirstContact } from "./first-contact.ts";
import { registerFocusLand } from "./focus-land.ts";
import { registerNext } from "./next.ts";
import { registerMemoryGuard } from "./memory-guard.ts";
import { registerMemoryPolicy } from "./memory-policy.ts";
import { registerMemoryTools } from "./memory-tools.ts";
import { registerRememberGate } from "./remember-gate.ts";
import { createMemoryClient } from "./memory-client.ts";
import { createCoordinator, type Coordinator } from "./context-coordinator.ts";
import { loadEnvironmentRecords, resolve as resolveEnv, type EnvRecord, type EnvScope } from "./environment-source.ts";
import { buildStatus, renderStatus, type ModuleState } from "./knowledge-status.ts";
import { loadStackConfig, isL3Enabled } from "./stack-config.ts";

// Personal environment records live in ~/.pi/agent/knowledge/environment
// (seeded by install.sh, then user-edited). Not resolved relative to this file:
// the extension loads from the repo as a pi package, where ../../knowledge is
// the bundled seed set. Override with MS_ENV_RECORDS_DIR. Missing dir =>
// empty map => semantic-only (coordinator degrades gracefully).
function environmentDir(): string {
	if (process.env.MS_ENV_RECORDS_DIR) return process.env.MS_ENV_RECORDS_DIR;
	return join(homedir(), ".pi", "agent", "knowledge", "environment");
}

function renderEnv(rec: EnvRecord, scope?: EnvScope): string {
	if (scope) return `${rec.title} - ${scope.summary}`;
	const firstPara = rec.body.split("\n\n").map((s) => s.trim()).find((s) => s && !s.startsWith("#")) ?? rec.title;
	return `${rec.title}: ${firstPara.replace(/\s+/g, " ").slice(0, 400)}`;
}

// Build the single shared context coordinator every retrieval hook submits to.
function buildCoordinator(pi: ExtensionAPI): Coordinator {
	const memory = createMemoryClient(pi.exec.bind(pi));
	const { records } = loadEnvironmentRecords(environmentDir());
	return createCoordinator({
		envResolve: (q) => resolveEnv(records, q),
		renderEnv,
		semanticSearch: (q, opts) => memory.searchStructured(q, opts),
	});
}

// Read-only /knowledge-status command: active modules, L3 state, loaded
// records, index coverage + identity and actionable failures. Never writes or
// embeds (memory-server --status is read-only).
function registerKnowledgeStatus(pi: ExtensionAPI): void {
	const memory = createMemoryClient(pi.exec.bind(pi));
	pi.registerCommand("knowledge-status", {
		description: "Show mission-stack status: modules, L3 state, env records, index coverage/identity, failures (read-only)",
		handler: async (_args, ctx) => {
			const { records, errors } = loadEnvironmentRecords(environmentDir());
			const parsed = await memory.statusStructured();
			const server = parsed.ok
				? ({ ok: true as const, status: parsed.envelope.status! })
				: ({ ok: false as const, error: parsed.error });
			const modules: ModuleState[] = [
				{ name: "correction-detector", enabled: process.env.MS_CORRECTION_DISABLED !== "1" },
				{ name: "first-contact", enabled: process.env.MS_FIRST_CONTACT !== "off" },
				{ name: "memory-tools", enabled: process.env.MS_MEMORY_TOOLS_DISABLED !== "1" },
				{ name: "remember-gate", enabled: process.env.MS_REMEMBER_GATE_DISABLED !== "1" },
				{ name: "context-coordinator", enabled: process.env.MS_CONTEXT_COORDINATOR_DISABLED !== "1" },
			];
			const report = buildStatus({
				config: loadStackConfig(),
				l3Enabled: isL3Enabled(),
				modules,
				environment: { records: [...records.keys()], errors },
				server,
			});
			if (ctx.hasUI) ctx.ui.notify(renderStatus(report), report.failures.length > 0 ? "warning" : "info");
		},
	});
}

export default function (pi: ExtensionAPI): void {
	const coordinator = buildCoordinator(pi);
	registerCorrectionDetector(pi);
	registerFirstContact(pi, coordinator);
	registerFocusLand(pi, coordinator);
	registerNext(pi);
	registerMemoryGuard(pi, coordinator);
	registerMemoryTools(pi);
	registerMemoryPolicy(pi, coordinator);
	registerRememberGate(pi);
	registerKnowledgeStatus(pi);
}

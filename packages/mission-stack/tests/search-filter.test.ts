import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryClient, type ExecFn, type MemoryExecResult } from "../modules/missions/extensions/mission-stack/memory-client.ts";

// Capture the argv the memory-client hands to the binary. The client wraps
// invocation in `sh -c '<envScript>' sh <bin> <serverArgs...>`, so the server
// args are everything after the bin token (index 4).
function captureExec(stdout = "No relevant prior art found."): { exec: ExecFn; lastArgs: () => string[] } {
	let captured: string[] = [];
	const exec: ExecFn = async (_command, args): Promise<MemoryExecResult> => {
		captured = args;
		return { code: 0, stdout, stderr: "" };
	};
	return { exec, lastArgs: () => captured.slice(4) };
}

test("memory-client forwards the query to --search", async () => {
	const { exec, lastArgs } = captureExec();
	const client = createMemoryClient(exec);
	await client.search("taint rollout");
	const args = lastArgs();
	assert.ok(args.includes("--search"));
	assert.equal(args[args.indexOf("--search") + 1], "taint rollout");
});

// --- mission-927.8: domain / type filters forwarded end-to-end. ---

test("memory-client forwards --domain and --type filters", async () => {
	const { exec, lastArgs } = captureExec();
	const client = createMemoryClient(exec);
	await client.search("taint rollout", { domain: "eks", typeFilter: "finding" });
	const args = lastArgs();
	assert.equal(args[args.indexOf("--domain") + 1], "eks");
	assert.equal(args[args.indexOf("--type") + 1], "finding");
});

test("searchStructured requests JSON and forwards filters", async () => {
	const env = JSON.stringify({
		contract_version: "memory-v1", command: "search", model: "bge-base-en-v1.5",
		embed_dims: 768, schema_version: "2", hits: [], error: null,
	});
	const { exec, lastArgs } = captureExec(env);
	const client = createMemoryClient(exec);
	const r = await client.searchStructured("q", { domain: "terraform" });
	assert.ok(r.ok);
	const args = lastArgs();
	assert.ok(args.includes("--json"));
	assert.equal(args[args.indexOf("--domain") + 1], "terraform");
});

test("checkDuplicateStructured requests JSON and forwards the proposed key", async () => {
	const env = JSON.stringify({
		contract_version: "memory-v1", command: "check-dup", model: "bge-base-en-v1.5",
		embed_dims: 768, schema_version: "2",
		duplicate: { verdict: "none", top_score: 0, tiers: { merge: 0.96, likely: 0.93, related: 0.9 }, matches: [] },
		error: null,
	});
	const { exec, lastArgs } = captureExec(env);
	const client = createMemoryClient(exec);
	const r = await client.checkDuplicateStructured("some lesson text", { proposedKey: "eks-foo" });
	assert.ok(r.ok);
	const args = lastArgs();
	assert.ok(args.includes("--check-dup"));
	assert.ok(args.includes("--json"));
	assert.equal(args[args.indexOf("--key") + 1], "eks-foo");
});

// --- Structured error path surfaces server errors (no false success). ---

test("searchStructured surfaces a server error envelope", async () => {
	const errEnv = JSON.stringify({
		contract_version: "memory-v1", command: "search",
		error: { code: "embed", message: "model init failed" },
	});
	const { exec } = captureExec(errEnv);
	const client = createMemoryClient(exec);
	const r = await client.searchStructured("q");
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /embed.*model init failed/);
});

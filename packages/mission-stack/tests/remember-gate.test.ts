import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { parseMxWrite, registerRememberGate } from "../modules/missions/extensions/mission-stack/remember-gate.ts";
import { DUP_TIERS, type MemoryEnvelope } from "../modules/missions/extensions/mission-stack/memory-contract.ts";

const key = "envoy-nginx-header-buffer-annotations-inert";
const body = "Header annotations are inert.\nThe proxy's body limit is 50Mi; preserve its cap.";
const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const suffixes = [`--replace --key ${key}`, `--key ${key} --replace`, `--key ${key}`, `--key=${key}`];

for (const suffix of suffixes) {
	test(`escaped apostrophe and literal separators preserve the update key: ${suffix}`, () => {
		const text = body + " Literal && and || operators\nstay in the body.";
		assert.deepEqual(parseMxWrite(`mx remember ${shellQuote(text)} ${suffix}`), { kind: "remember", text, key });
	});
}

test("quoted separators and real compound command boundaries stay distinct", () => {
	const command = `printf 'before; && ||' && mx remember ${shellQuote(body)} --key ${key}; printf after`;
	assert.deepEqual(parseMxWrite(command), { kind: "remember", text: body, key });
});

test("double quotes, escaped quotes, and literal backslashes preserve the key", () => {
	const text = 'The proxy says "retain; && || limits". Path C:\\config.';
	const quoted = '"' + text.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
	assert.deepEqual(parseMxWrite(`mx remember ${quoted} --key ${key}`), { kind: "remember", text, key });
});

test("an escaped separator outside quotes is not a command boundary", () => {
	assert.deepEqual(parseMxWrite(`mx remember cap\\;retain --key ${key}`), { kind: "remember", text: "cap;retain", key });
});

// Run the registered hook with the real SDK loader/client. Only the external
// memory-server process is replaced by a deterministic contract response.
async function gateHarness() {
	const calls: string[][] = [];
	const extension = await loadExtensionFromFactory((pi) => {
		registerRememberGate({
			...pi,
			exec: async (_command, args) => {
				calls.push(args);
				const proposedKey = args.includes("--key") ? args[args.indexOf("--key") + 1] : undefined;
				const hit = { type: "lesson", key, score: 0.982, excerpt: "Header annotation lesson", provenance: "bd:lesson" } as const;
				const envelope = {
					contract_version: "memory-v1", command: "check-dup", model: "bge-base-en-v1.5",
					embed_dims: 768, schema_version: "2", error: null,
					duplicate: {
						proposed_key: proposedKey,
						verdict: proposedKey === key ? "existing_key" : "merge",
						top_score: proposedKey === key ? 1 : 0.982, tiers: DUP_TIERS,
						matches: proposedKey === key ? [] : [hit],
					},
				} satisfies MemoryEnvelope;
				return { code: 0, stdout: JSON.stringify(envelope), stderr: "", killed: false };
			},
		});
	}, process.cwd(), createEventBus(), createExtensionRuntime());
	const handler = extension.handlers.get("tool_call")?.[0];
	assert.ok(handler, "remember gate must register its tool_call hook");
	const resultHandler = extension.handlers.get("tool_result")?.[0];
	assert.ok(resultHandler, "remember gate must register its tool_result hook");
	return {
		calls,
		run: (command: string) => handler({ type: "tool_call", toolName: "bash", toolCallId: "regression", input: { command } }, { signal: undefined }),
		finish: async (command: string) => {
			await resultHandler(
				{ type: "tool_result", toolName: "bash", toolCallId: "regression", input: { command }, content: [], isError: false, details: undefined },
				{ hasUI: false },
			);
			await new Promise((r) => setTimeout(r, 10));
		},
	};
}

for (const suffix of suffixes) {
	test(`gate forwards the full lesson and self-exclusion key: ${suffix}`, async () => {
		const gate = await gateHarness();
		assert.equal(await gate.run(`mx remember ${shellQuote(body)} ${suffix}`), undefined);
		assert.equal(gate.calls.length, 1);
		const args = gate.calls[0];
		assert.equal(args[args.indexOf("--check-dup") + 1], body);
		assert.equal(args[args.indexOf("--key") + 1], key);
		assert.ok(args.includes("--json"));
	});
}

for (const suffix of ["", "--key new-header-lesson"]) {
	test(`gate still blocks a genuine new duplicate: ${suffix || "auto key"}`, async () => {
		const gate = await gateHarness();
		const result = await gate.run(`mx remember ${shellQuote(body)} ${suffix}`);
		assert.ok(result && typeof result === "object" && "block" in result && "reason" in result);
		assert.equal(result.block, true);
		assert.equal(typeof result.reason, "string");
		assert.match(String(result.reason), /merge candidate/);
	});
}

test("bd commands are no longer intercepted", () => {
	assert.equal(parseMxWrite(`bd remember ${shellQuote(body)} --key ${key}`), null);
	assert.equal(parseMxWrite(`bd create 'x' -d 'y'`), null);
});

test("an inline MX_DB is reported so the gate can skip indexing it", () => {
	assert.deepEqual(parseMxWrite(`MX_DB=/tmp/x mx remember ${shellQuote(body)} --key ${key}`), { kind: "remember", text: body, key, db: "/tmp/x" });
	assert.deepEqual(parseMxWrite(`export MX_DB=/tmp/y; mx remember ${shellQuote(body)} --key ${key}`), { kind: "remember", text: body, key, db: "/tmp/y" });
});

for (const kind of ["create", "note mission-ws2", "comment mission-ws2"]) {
	test(`secrets in mx ${kind} are left to mx (exit 3), not blocked here`, async () => {
		const gate = await gateHarness();
		// Synthetic PEM marker, no real credential material.
		const result = await gate.run(`mx ${kind} ${shellQuote(body + " -----BEGIN PRIVATE KEY-----")}`);
		assert.equal(result, undefined);
		assert.equal(gate.calls.length, 0, "only remember reaches the memory server");
	});
}

test("a successful mx remember is indexed into the graph", async () => {
	const gate = await gateHarness();
	await gate.finish(`mx remember ${shellQuote(body)} --key ${key}`);
	assert.equal(gate.calls.filter((a) => a.includes("--add-lesson")).length, 1);
});

test("mx remember against another MX_DB is not indexed", async () => {
	const gate = await gateHarness();
	await gate.finish(`MX_DB=/tmp/x mx remember ${shellQuote(body)} --key ${key}`);
	await gate.finish(`bd remember ${shellQuote(body)} --key ${key}`);
	assert.equal(gate.calls.length, 0);
});

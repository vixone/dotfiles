import test from "node:test";
import assert from "node:assert/strict";

import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import sessionsExtension from "../modules/sessions/extensions/sidebar/index.ts";

async function harness() {
	const runtime = createExtensionRuntime();
	const messages: Parameters<typeof runtime.sendUserMessage>[] = [];
	runtime.sendUserMessage = (...args) => { messages.push(args); };
	const extension = await loadExtensionFromFactory(
		sessionsExtension, process.cwd(), createEventBus(), runtime,
	);
	return { extension, messages };
}

test("/sessions registers with /sidebar as an alias to the same handler", async () => {
	const { extension } = await harness();
	const command = extension.commands.get("sessions");
	const alias = extension.commands.get("sidebar");
	assert.ok(command);
	assert.ok(alias);
	assert.equal(alias.handler, command.handler);
	assert.match(alias.description ?? "", /Alias for \/sessions/);
});

test("Ctrl+F dispatches /sessions as a command rather than a model prompt", async () => {
	const { extension, messages } = await harness();
	const shortcut = extension.shortcuts.get("ctrl+f");
	assert.ok(shortcut);
	assert.match(shortcut.description ?? "", /\/sessions/);
	// The shortcut needs no context: command dispatch supplies the richer
	// command context required for switching sessions.
	await Reflect.apply(shortcut.handler, undefined, []);
	assert.deepEqual(messages, [["/sessions", { expandPromptTemplates: true }]]);
});

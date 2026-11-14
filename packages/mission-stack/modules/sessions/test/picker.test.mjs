import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browseAndResume,
  formatPickerRow,
  pickerPrompt,
  pickerRows,
  savePickerState,
  loadPickerState,
  togglePickerState,
  pickSession,
  renderPickerRows,
} from "../src/picker.mjs";
import { formatPreview } from "../src/preview.mjs";

function session(overrides = {}) {
  return {
    key: "abc123",
    id: "01a09084-22c0-7785-96e1-5e2e354a9d4a",
    path: "/tmp/session.jsonl",
    cwd: "/Users/example/project",
    title: "Envoy\tdashboards\u001b[31m",
    model: "github-copilot/grok-4.6",
    missions: ["mission-2bj"],
    updated: "2026-09-14T07:10:55.901Z",
    messages: [
      { role: "user", text: "First prompt", timestamp: "2026-09-14T07:00:00.000Z" },
      { role: "assistant", text: "A normal answer", timestamp: "2026-09-14T07:01:00.000Z" },
      {
        role: "user",
        text: `${"far away text ".repeat(400)}late-preview-needle with useful context`,
        timestamp: "2026-09-14T07:02:00.000Z",
      },
      { role: "assistant", text: "Latest answer", timestamp: "2026-09-14T07:03:00.000Z" },
    ],
    subagent: false,
    warnings: [],
    ...overrides,
  };
}

test("renders clean metadata rows without conversation text", () => {
  const row = formatPickerRow(session(), new Date("2026-09-15T07:10:55.901Z"));
  assert.match(row, /^abc123\t/);
  assert.match(row, /Envoy dashboards/);
  assert.match(row, /mission-2bj/);
  assert.ok(!row.includes("First prompt"));
  assert.ok(!row.includes("late-preview-needle"));
  assert.ok(!row.includes("\u001b"));
  assert.equal(row.split("\t").length, 5);
});

test("preview contains a late matching excerpt and latest exchange", () => {
  const preview = formatPreview(session(), "late-preview-needle");
  assert.match(preview, /Matching excerpt/);
  assert.match(preview, /late-preview-needle with useful context/);
  assert.match(preview, /Latest conversation/);
  assert.match(preview, /Latest answer/);
  assert.ok(!preview.includes("far away text ".repeat(100)));
  assert.ok(!preview.includes("hidden tool output"));
});

test("picker prompt reflects scope, ordering and match mode", () => {
  assert.equal(pickerPrompt({ scope: "all", order: "recent" }), "All projects · Recent · Keywords > ");
  assert.equal(pickerPrompt({ scope: "project", order: "relevance", mode: "fuzzy" }), "Current project · Relevance · Fuzzy > ");
});

test("Ctrl-F search mode persists across order and scope toggles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-picker-mode-"));
  const statePath = path.join(directory, "state.json");
  try {
    await savePickerState(statePath, {
      rows: [session({ title: "Other", messages: [{ role: "user", text: "t a g s e s s i o n" }] })],
      mode: "keywords", order: "recent", scope: "all", includeAgents: true,
      projectPath: "/Users/example/project", fzfPath: "fzf",
    });
    assert.equal(await pickerRows(statePath, "tagsession"), "");
    assert.match(await togglePickerState(statePath, "mode"), /Fuzzy/);
    assert.match(await pickerRows(statePath, "tagsession"), /abc123/);
    await togglePickerState(statePath, "order");
    await togglePickerState(statePath, "scope");
    assert.equal((await loadPickerState(statePath)).mode, "fuzzy");
    assert.match(await togglePickerState(statePath, "mode"), /Keywords/);
    assert.equal(await pickerRows(statePath, "tagsession"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation returns null and removes private picker state", async () => {
  let statePath;
  const selected = await pickSession([session()], {
    helperPath: "/tmp/pi-sessions.mjs",
    run(_command, _args, options) {
      const firstKey = options.input.split("\t", 1)[0];
      assert.equal(firstKey, "abc123");
      statePath = options.statePath;
      return { status: 130, stdout: "", stderr: "" };
    },
  });

  assert.equal(selected, null);
  await assert.rejects(access(statePath));
});

test("browse cancellation never starts Pi", async () => {
  let resumed = false;
  const selected = await browseAndResume([session()], {
    pick: async () => null,
    resume: async () => {
      resumed = true;
    },
  });
  assert.equal(selected, null);
  assert.equal(resumed, false);
});

test("picker resolves the selected key without exposing hidden text", async () => {
  const rows = [session(), session({ key: "def456", title: "Second" })];
  const selected = await pickSession(rows, {
    helperPath: "/tmp/pi-sessions.mjs",
    run(command, args, options) {
      assert.equal(command, "fzf");
      assert.ok(args.includes("--disabled"));
      assert.ok(args.includes("2.."));
      assert.ok(args.some((arg) => arg.startsWith("ctrl-f:")));
      assert.match(args[args.indexOf("--header") + 1], /Ctrl-F/);
      assert.equal(renderPickerRows(rows), options.input);
      return { status: 0, stdout: "def456\n", stderr: "" };
    },
  });
  assert.equal(selected.key, "def456");
});

import assert from "node:assert/strict";
import test from "node:test";

import { parseSession, sanitizeText } from "../src/session.mjs";

function jsonl(entries, malformed = false) {
  const lines = entries.map((entry) => JSON.stringify(entry));
  if (malformed) lines.push('{"type":"message"');
  return `${lines.join("\n")}\n`;
}

const fixturePath = "/tmp/2026-09-11T12-49-33-889Z_01a09084-22c0-7785-96e1-5e2e354a9d4a.jsonl";

function conversationFixture() {
  return jsonl([
    {
      type: "session",
      version: 3,
      id: "01a09084-22c0-7785-96e1-5e2e354a9d4a",
      timestamp: "2026-09-11T12:49:33.889Z",
      cwd: "/Users/example/project",
    },
    {
      type: "model_change",
      timestamp: "2026-09-11T12:49:34.517Z",
      provider: "github-copilot",
      modelId: "grok-4.6",
    },
    {
      type: "message",
      timestamp: "2026-09-11T12:49:41.316Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: '<skill name="mission-execute" location="/tmp/SKILL.md">\nInjected skill instructions that must not be searchable.\n</skill>\n\nResume mission-2bj (Envoy dashboards) in ~/project. Load mission-execute.',
          },
          { type: "image", data: "large-image-payload" },
        ],
      },
    },
    {
      type: "message",
      timestamp: "2026-09-11T12:49:44.181Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden thinking" },
          { type: "text", text: "\u001b[31mVisible dashboard answer\u001b[0m" },
          { type: "toolCall", name: "bash", arguments: { command: "secret tool input" } },
        ],
      },
    },
    {
      type: "message",
      timestamp: "2026-09-11T12:49:45.000Z",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "hidden tool output" }],
      },
    },
    {
      type: "custom",
      customType: "land-focus",
      timestamp: "2026-09-11T12:49:46.000Z",
      data: { id: "mission-2bj" },
    },
    {
      type: "model_change",
      timestamp: "2026-09-11T13:28:30.552Z",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    },
  ]);
}

test("extracts clean conversation metadata and text", () => {
  const result = parseSession(conversationFixture(), fixturePath);

  assert.equal(result.id, "01a09084-22c0-7785-96e1-5e2e354a9d4a");
  assert.equal(result.path, fixturePath);
  assert.equal(result.cwd, "/Users/example/project");
  assert.equal(result.title, "Envoy dashboards");
  assert.equal(result.model, "anthropic/claude-sonnet-5");
  assert.deepEqual(result.missions, ["mission-2bj"]);
  assert.equal(result.updated, "2026-09-11T12:49:44.181Z");
  assert.deepEqual(result.messages, [
    {
      role: "user",
      text: "Resume mission-2bj (Envoy dashboards) in ~/project. Load mission-execute.",
      timestamp: "2026-09-11T12:49:41.316Z",
    },
    {
      role: "assistant",
      text: "Visible dashboard answer",
      timestamp: "2026-09-11T12:49:44.181Z",
    },
  ]);
  assert.equal(result.subagent, false);
  assert.deepEqual(result.warnings, []);
  assert.ok(!JSON.stringify(result.messages).includes("hidden thinking"));
  assert.ok(!JSON.stringify(result.messages).includes("hidden tool output"));
  assert.ok(!JSON.stringify(result.messages).includes("large-image-payload"));
  assert.ok(!JSON.stringify(result.messages).includes("Injected skill"));
});

test("uses the latest explicit session name and detects subagents", () => {
  const input = jsonl([
    {
      type: "session",
      id: "named-id",
      timestamp: "2026-01-01T10:00:00.000Z",
      cwd: "/tmp/project",
    },
    {
      type: "message",
      timestamp: "2026-01-01T10:01:00.000Z",
      message: { role: "user", content: "How should auth work?" },
    },
    {
      type: "session_info",
      timestamp: "2026-01-01T10:02:00.000Z",
      name: "Old name",
    },
    {
      type: "session_info",
      timestamp: "2026-01-01T10:03:00.000Z",
      name: "subagent-worker-auth review",
    },
  ]);

  const result = parseSession(input, "/tmp/named.jsonl");
  assert.equal(result.title, "subagent-worker-auth review");
  assert.equal(result.subagent, true);
  assert.equal(result.updated, "2026-01-01T10:01:00.000Z");
});

test("falls back to the first meaningful user prompt", () => {
  const input = jsonl([
    {
      type: "session",
      id: "prompt-id",
      timestamp: "2026-01-01T10:00:00.000Z",
      cwd: "/tmp/project",
    },
    {
      type: "message",
      timestamp: "2026-01-01T10:00:01.000Z",
      message: { role: "user", content: "continue" },
    },
    {
      type: "message",
      timestamp: "2026-01-01T10:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "# Repair the login redirect\nPlease inspect the callback." }],
      },
    },
  ]);

  assert.equal(parseSession(input, "/tmp/prompt.jsonl").title, "Repair the login redirect");
});

test("does not use an embedded resume template as the title", () => {
  const input = jsonl([
    {
      type: "session",
      id: "alerting-id",
      timestamp: "2026-01-01T10:00:00.000Z",
      cwd: "/tmp/project",
    },
    {
      type: "message",
      timestamp: "2026-01-01T10:00:01.000Z",
      message: { role: "user", content: "Plan ArgoCD alerting with Grafana." },
    },
    {
      type: "message",
      timestamp: "2026-01-01T10:00:02.000Z",
      message: {
        role: "user",
        content: "LAND THE PLANE.\n- Open with: Resume mission-il4 (<mission title>) in <working dir>.",
      },
    },
  ]);

  assert.equal(parseSession(input, "/tmp/alerting.jsonl").title, "Plan ArgoCD alerting with Grafana.");
});

test("keeps valid entries before a malformed trailing line", () => {
  const input = jsonl(
    [
      {
        type: "session",
        id: "partial-id",
        timestamp: "2026-01-01T10:00:00.000Z",
        cwd: "/tmp/project",
      },
      {
        type: "message",
        timestamp: "2026-01-01T10:00:01.000Z",
        message: { role: "user", content: "Keep this message" },
      },
    ],
    true,
  );

  const result = parseSession(input, "/tmp/partial.jsonl");
  assert.equal(result.messages[0].text, "Keep this message");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /line 3/i);
});

test("derived titles skip leading image and PDF attachment paths", () => {
  for (const prompt of [
    String.raw`/Users/example/Downloads/Restricting\ access\ to\ human.pdf  Update IAM role trust policies`,
    '"/Users/example/Downloads/image (1).png" /tmp/second.pdf Update IAM role trust policies',
    "~/Downloads/image.png\nUpdate IAM role trust policies",
    "/var/folders/tmp/pi-clipboard-test.png Update IAM role trust policies",
  ]) {
    const input = jsonl([{ type: "message", message: { role: "user", content: prompt } }]);
    const result = parseSession(input, fixturePath);
    assert.equal(result.title, "Update IAM role trust policies");
    assert.equal(result.messages[0].text, prompt);
  }
});

test("attachment-only prompts are skipped but source-code paths remain useful titles", () => {
  const input = jsonl([
    { type: "message", message: { role: "user", content: "/tmp/image.png" } },
    { type: "message", message: { role: "user", content: "Investigate IAM roles" } },
  ]);
  assert.equal(parseSession(input, fixturePath).title, "Investigate IAM roles");
  const source = jsonl([{ type: "message", message: { role: "user", content: "/tmp/main.ts review this file" } }]);
  assert.equal(parseSession(source, fixturePath).title, "/tmp/main.ts review this file");
});

test("sanitizes terminal controls while preserving line structure", () => {
  assert.equal(
    sanitizeText("one\u001b]0;bad title\u0007\n\u001b[32mtwo\u001b[0m\u0000"),
    "one\ntwo",
  );
});

function userMessage(text, timestamp = "2026-10-30T09:00:00.000Z") {
  return { type: "message", timestamp, message: { role: "user", content: [{ type: "text", text }] } };
}

test("accepts mission ids longer than three characters from focus entries", () => {
  const result = parseSession(jsonl([
    { type: "session", id: "s1", timestamp: "2026-10-30T08:00:00.000Z", cwd: "/tmp" },
    { type: "custom", customType: "land-focus", data: { id: "mission-xmu4" } },
    userMessage("check the logs"),
  ]), "/tmp/a_s1.jsonl");

  assert.deepEqual(result.missions, ["mission-xmu4"]);
  assert.equal(result.focus, "mission-xmu4");
});

test("reads long mission ids from a leading resume heading", () => {
  const result = parseSession(jsonl([
    { type: "session", id: "s2", timestamp: "2026-10-30T08:00:00.000Z", cwd: "/tmp" },
    userMessage("Resume mission-41vx.3 (Envoy switch) in /tmp. Handover follows."),
  ]), "/tmp/a_s2.jsonl");

  assert.deepEqual(result.missions, ["mission-41vx"]);
  assert.deepEqual(result.linked, ["mission-41vx"]);
  assert.equal(result.focus, null);
});

test("ignores long mission-like words in free text", () => {
  const result = parseSession(jsonl([
    { type: "session", id: "s3", timestamp: "2026-10-30T08:00:00.000Z", cwd: "/tmp" },
    userMessage("Load mission-execute from mission-stack, see mission-a1b2 template and mission-u27."),
  ]), "/tmp/a_s3.jsonl");

  assert.deepEqual(result.missions, ["mission-u27"]);
  assert.deepEqual(result.linked, []);
});

test("focus follows the last land-focus entry and clears on null", () => {
  const entries = [
    { type: "session", id: "s4", timestamp: "2026-10-30T08:00:00.000Z", cwd: "/tmp" },
    { type: "custom", customType: "land-focus", data: { id: "mission-z5r" } },
    { type: "custom", customType: "land-focus", data: { id: "mission-6paa" } },
  ];
  const focused = parseSession(jsonl(entries), "/tmp/a_s4.jsonl");
  assert.equal(focused.focus, "mission-6paa");
  assert.deepEqual(focused.missions.sort(), ["mission-6paa", "mission-z5r"]);

  const cleared = parseSession(jsonl([...entries, { type: "custom", customType: "land-focus", data: null }]), "/tmp/a_s4.jsonl");
  assert.equal(cleared.focus, null);
});

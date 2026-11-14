import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionIndex } from "../src/index.mjs";

const cleanup = [];
test.after(async () => Promise.all(cleanup.map((entry) => rm(entry, { recursive: true, force: true }))));

async function workspace() {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-sessions-index-"));
  cleanup.push(base);
  const root = path.join(base, "sessions");
  const cache = path.join(base, "cache");
  await mkdir(root);
  return { base, root, cache };
}

function entryLines({ id, cwd, title, prompt, reply, updated = "2026-09-01T10:01:00.000Z" }) {
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-09-01T10:00:00.000Z",
      cwd,
    },
  ];
  if (prompt) {
    entries.push({
      type: "message",
      timestamp: "2026-09-01T10:00:10.000Z",
      message: { role: "user", content: prompt },
    });
  }
  if (reply) {
    entries.push({
      type: "message",
      timestamp: updated,
      message: { role: "assistant", content: [{ type: "text", text: reply }] },
    });
  }
  if (title) {
    entries.push({ type: "session_info", timestamp: "2026-09-01T10:02:00.000Z", name: title });
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function sessionFile(root, projectName, filename, options) {
  const projectDir = path.join(root, projectName);
  await mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, filename);
  await writeFile(file, entryLines(options));
  return file;
}

test("refresh caches unchanged sessions, updates appends, and removes deleted files", async () => {
  const { root, cache } = await workspace();
  const project = "/tmp/project one";
  const visible = await sessionFile(root, "--project-one--", "one_same-id.jsonl", {
    id: "same-id",
    cwd: project,
    title: "Visible session",
    prompt: "Initial prompt",
    reply: "Initial answer",
  });
  const agent = await sessionFile(root, "--project-one--", "two_agent-id.jsonl", {
    id: "agent-id",
    cwd: project,
    title: "subagent-worker-123",
    prompt: "Agent prompt",
    reply: "Agent answer",
  });
  await sessionFile(root, "--project-one--", "three_empty-id.jsonl", {
    id: "empty-id",
    cwd: project,
    title: "Empty session",
  });
  const nested = path.join(root, "--project-one--", "same-id", "forks");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "nested.jsonl"), entryLines({
    id: "nested-id",
    cwd: project,
    prompt: "Must not be indexed",
  }));

  const index = new SessionIndex(cache);
  const first = await index.refresh(root);
  assert.deepEqual(
    { discovered: first.discovered, parsed: first.parsed, unchanged: first.unchanged, removed: first.removed },
    { discovered: 3, parsed: 3, unchanged: 0, removed: 0 },
  );
  assert.deepEqual(index.list().map((row) => row.title), ["Visible session"]);
  assert.deepEqual(
    index.list({ includeAgents: true }).map((row) => row.title),
    ["subagent-worker-123", "Visible session"],
  );

  const second = await index.refresh(root);
  assert.deepEqual(
    { parsed: second.parsed, unchanged: second.unchanged, removed: second.removed },
    { parsed: 0, unchanged: 3, removed: 0 },
  );

  await appendFile(visible, `${JSON.stringify({
    type: "message",
    timestamp: "2026-09-02T12:34:56.000Z",
    message: { role: "assistant", content: "Appended answer" },
  })}\n`);
  const third = await index.refresh(root);
  assert.equal(third.parsed, 1);
  assert.equal(third.unchanged, 2);
  assert.equal(index.list()[0].updated, "2026-09-02T12:34:56.000Z");
  assert.equal(index.list()[0].messages.at(-1).text, "Appended answer");

  await unlink(agent);
  const fourth = await index.refresh(root);
  assert.equal(fourth.removed, 1);
  assert.equal(index.list({ includeAgents: true }).length, 1);

  assert.equal((await stat(cache)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(cache, "sessions.sqlite"))).mode & 0o777, 0o600);
  index.close();
});

test("keeps duplicate session IDs distinct and filters by project", async () => {
  const { root, cache } = await workspace();
  await sessionFile(root, "--one--", "one_duplicate.jsonl", {
    id: "duplicate",
    cwd: "/tmp/one",
    title: "Project one",
    prompt: "one",
  });
  await sessionFile(root, "--two--", "two_duplicate.jsonl", {
    id: "duplicate",
    cwd: "/tmp/two",
    title: "Project two",
    prompt: "two",
  });

  const index = new SessionIndex(cache);
  await index.refresh(root);
  const all = index.list();
  assert.equal(all.length, 2);
  assert.equal(new Set(all.map((row) => row.key)).size, 2);
  assert.deepEqual(index.list({ project: "/tmp/two" }).map((row) => row.title), ["Project two"]);
  assert.equal(index.get(all[0].key).path, all[0].path);
  index.close();
});

test("separate cache overrides do not share indexed roots", async () => {
  const one = await workspace();
  const two = await workspace();
  await sessionFile(one.root, "--one--", "one_a.jsonl", {
    id: "a",
    cwd: "/tmp/a",
    title: "Only cache A",
    prompt: "alpha",
  });
  await sessionFile(two.root, "--two--", "two_b.jsonl", {
    id: "b",
    cwd: "/tmp/b",
    title: "Only cache B",
    prompt: "beta",
  });

  const indexA = new SessionIndex(one.cache);
  const indexB = new SessionIndex(two.cache);
  await indexA.refresh(one.root);
  await indexB.refresh(two.root);
  assert.deepEqual(indexA.list().map((row) => row.title), ["Only cache A"]);
  assert.deepEqual(indexB.list().map((row) => row.title), ["Only cache B"]);
  indexA.close();
  indexB.close();
});

test("parser revision rebuilds cached titles without editing session files", async () => {
  const { root, cache } = await workspace();
  const file = await sessionFile(root, "--project--", "session_id.jsonl", {
    id: "id", cwd: "/tmp/project", prompt: "/tmp/image.png Update IAM roles",
  });
  const before = await readFile(file, "utf8");
  const index = new SessionIndex(cache);
  await index.refresh(root);
  const cached = index.list()[0];
  index.database.prepare("UPDATE sessions SET data = ? WHERE key = ?")
    .run(JSON.stringify({ ...cached, title: "/tmp/image.png Update IAM roles" }), cached.key);
  index.database.exec("PRAGMA user_version = 1");
  index.close();

  const reopened = new SessionIndex(cache);
  try {
    assert.equal((await reopened.refresh(root)).parsed, 1);
    assert.equal(reopened.list()[0].title, "Update IAM roles");
    assert.equal((await reopened.refresh(root)).parsed, 0);
    assert.equal(await readFile(file, "utf8"), before);
  } finally {
    reopened.close();
  }
});

test("retains valid messages when a session ends with malformed JSON", async () => {
  const { root, cache } = await workspace();
  const file = await sessionFile(root, "--partial--", "partial_id.jsonl", {
    id: "id",
    cwd: "/tmp/partial",
    title: "Partial session",
    prompt: "Valid before malformed",
  });
  await appendFile(file, '{"type":"message"\n');

  const index = new SessionIndex(cache);
  const result = await index.refresh(root);
  assert.equal(result.warnings, 1);
  assert.equal(index.list()[0].messages[0].text, "Valid before malformed");
  const bytes = await readFile(path.join(cache, "sessions.sqlite"));
  assert.ok(bytes.length > 0);
  index.close();
});

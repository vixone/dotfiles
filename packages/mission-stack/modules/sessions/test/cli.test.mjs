import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repository, "bin", "pi-sessions.mjs");
const cleanup = [];
test.after(async () => Promise.all(cleanup.map((entry) => rm(entry, { recursive: true, force: true }))));

async function workspace() {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-sessions-cli-"));
  cleanup.push(base);
  const root = path.join(base, "sessions");
  const cache = path.join(base, "cache");
  const project = path.join(base, "project with spaces");
  await mkdir(root);
  await mkdir(project);
  return { base, root, cache, project };
}

async function addSession(root, project, { id = "session-id", title = "Searchable session" } = {}) {
  const directory = path.join(root, "--project--");
  await mkdir(directory, { recursive: true });
  const sessionPath = path.join(directory, `2026-09-15_${id}.jsonl`);
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-09-15T10:00:00.000Z",
      cwd: project,
    },
    {
      type: "message",
      timestamp: "2026-09-15T10:00:01.000Z",
      message: { role: "user", content: "Conversation search text" },
    },
    {
      type: "session_info",
      timestamp: "2026-09-15T10:00:02.000Z",
      name: title,
    },
  ];
  await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return sessionPath;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("prints help without creating a cache", async () => {
  const { base } = await workspace();
  const cache = path.join(base, "must-not-exist");
  const result = runCli(["--help"], { PI_SESSIONS_CACHE: cache });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pi-sessions/);
  assert.match(result.stdout, /Ctrl-Y/);
  await assert.rejects(lstat(cache));
});

test("handles an empty session root without opening fzf", async () => {
  const { root, cache } = await workspace();
  const result = runCli(["--root", root, "--cache", cache]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "No Pi sessions found.\n");
  assert.equal(result.stderr, "");
});

test("rejects unknown options", () => {
  const result = runCli(["--not-a-real-option"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option/);
});

test("reports a missing fzf executable", async () => {
  const { root, cache, project } = await workspace();
  await addSession(root, project);
  const result = runCli(["--root", root, "--cache", cache], {
    PI_SESSIONS_FZF: path.join(cache, "missing-fzf"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not start fzf/i);
});

test("JSON listing honors root and cache overrides without launching Pi", async () => {
  const { base, root, cache, project } = await workspace();
  const sessionPath = await addSession(root, project, { id: "json-id", title: "JSON result" });
  const marker = path.join(base, "pi-was-started");
  const fakePi = path.join(base, "fake-pi");
  const fakePbcopy = path.join(base, "fake-pbcopy");
  await writeFile(fakePi, `#!/bin/sh\ntouch '${marker}'\n`);
  await writeFile(fakePbcopy, `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(fakePi, 0o755);
  await chmod(fakePbcopy, 0o755);

  const result = runCli(["--root", root, "--cache", cache, "--json"], {
    PI_SESSIONS_PI: fakePi,
    PI_SESSIONS_PBCOPY: fakePbcopy,
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "json-id");
  assert.equal(rows[0].title, "JSON result");
  assert.equal(rows[0].path, sessionPath);
  assert.equal(rows[0].messageCount, 1);
  assert.equal("messages" in rows[0], false);
  assert.equal((await lstat(path.join(cache, "sessions.sqlite"))).isFile(), true);
  await assert.rejects(lstat(marker));
});

test("plain list mode does not launch Pi or pbcopy", async () => {
  const { base, root, cache, project } = await workspace();
  await addSession(root, project, { title: "Plain result" });
  const marker = path.join(base, "side-effect");
  const fake = path.join(base, "must-not-run");
  await writeFile(fake, `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(fake, 0o755);

  const result = runCli(["--root", root, "--cache", cache, "--list"], {
    PI_SESSIONS_PI: fake,
    PI_SESSIONS_PBCOPY: fake,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plain result/);
  await assert.rejects(lstat(marker));
});

test("CLI defaults to keywords and accepts --fuzzy without launching Pi", async () => {
  const { root, cache, project } = await workspace();
  await addSession(root, project, { id: "literal", title: "TagSession rollout" });
  await addSession(root, project, { id: "noise", title: "T a g S e s s i o n" });
  const common = ["--root", root, "--cache", cache, "--json"];
  const literal = runCli([...common, "tagsession"]);
  assert.equal(literal.status, 0, literal.stderr);
  assert.deepEqual(JSON.parse(literal.stdout).map((r) => r.id), ["literal"]);
  const fuzzy = runCli([...common, "--fuzzy", "tagsession"]);
  assert.equal(fuzzy.status, 0, fuzzy.stderr);
  assert.equal(JSON.parse(fuzzy.stdout).length, 2);
  const help = runCli(["--help"]);
  assert.match(help.stdout, /--fuzzy/);
  assert.match(help.stdout, /Ctrl-F/);
});

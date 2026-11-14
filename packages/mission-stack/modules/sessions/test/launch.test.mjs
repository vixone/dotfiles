import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyResumeCommand,
  launchSpec,
  resumeCommand,
  resumeSession,
  shellQuote,
} from "../src/launch.mjs";

const cleanup = [];
test.after(async () => Promise.all(cleanup.map((entry) => rm(entry, { recursive: true, force: true }))));

async function validSession() {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-sessions-launch-"));
  cleanup.push(base);
  const cwd = path.join(base, "project's files");
  const sessionPath = path.join(base, "session's file.jsonl");
  await mkdir(cwd);
  await writeFile(sessionPath, "{}\n");
  return { cwd, path: sessionPath };
}

test("quotes copyable resume commands for a POSIX shell", async () => {
  const session = await validSession();
  assert.equal(shellQuote("plain-value"), "'plain-value'");
  assert.equal(shellQuote("it's here"), "'it'\"'\"'s here'");
  assert.equal(
    resumeCommand(session),
    `cd ${shellQuote(session.cwd)} && pi --session ${shellQuote(session.path)}`,
  );
});

test("builds a safe Pi argument array for paths with spaces and quotes", async () => {
  const session = await validSession();
  const spec = launchSpec(session);
  assert.equal(spec.command, "pi");
  assert.deepEqual(spec.args, ["--session", session.path]);
  assert.equal(spec.cwd, session.cwd);
  assert.equal(spec.shell, false);
});

test("rejects missing working directories and session files", async () => {
  const session = await validSession();
  assert.throws(
    () => launchSpec({ ...session, cwd: path.join(session.cwd, "missing") }),
    /working directory does not exist/i,
  );
  assert.throws(
    () => launchSpec({ ...session, path: path.join(session.path, "missing") }),
    /session file does not exist/i,
  );
});

test("passes resume arguments without a shell", async () => {
  const session = await validSession();
  let invocation;
  const status = await resumeSession(session, {
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return Promise.resolve({ code: 0, signal: null });
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(invocation.args, ["--session", session.path]);
  assert.equal(invocation.options.cwd, session.cwd);
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.options.shell, false);
});

test("copies the command through pbcopy stdin", async () => {
  const session = await validSession();
  let invocation;
  copyResumeCommand(session, {
    run(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: "" };
    },
  });

  assert.equal(invocation.command, "pbcopy");
  assert.deepEqual(invocation.args, []);
  assert.equal(invocation.options.input, resumeCommand(session));
  assert.equal(invocation.options.shell, false);
});

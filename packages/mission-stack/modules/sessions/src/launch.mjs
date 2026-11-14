import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function checkedSession(session) {
  if (!session?.cwd) throw new Error("Session has no recorded working directory.");
  if (!session?.path) throw new Error("Session has no recorded file path.");

  let cwdDetails;
  try {
    cwdDetails = statSync(session.cwd);
  } catch {
    throw new Error(`Working directory does not exist: ${session.cwd}`);
  }
  if (!cwdDetails.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${session.cwd}`);
  }

  let fileDetails;
  try {
    fileDetails = statSync(session.path);
  } catch {
    throw new Error(`Session file does not exist: ${session.path}`);
  }
  if (!fileDetails.isFile()) throw new Error(`Session path is not a file: ${session.path}`);
  return session;
}

export function launchSpec(session, { piPath = "pi" } = {}) {
  checkedSession(session);
  return {
    command: piPath,
    args: ["--session", session.path],
    cwd: session.cwd,
    shell: false,
  };
}

export function resumeCommand(session) {
  checkedSession(session);
  return `cd ${shellQuote(session.cwd)} && pi --session ${shellQuote(session.path)}`;
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export async function resumeSession(session, { piPath = "pi", spawnImpl = spawnAndWait } = {}) {
  const spec = launchSpec(session, { piPath });
  let result;
  try {
    result = await spawnImpl(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: "inherit",
      shell: false,
    });
  } catch (error) {
    throw new Error(`Could not start Pi: ${error.message}`, { cause: error });
  }

  if (result.signal) throw new Error(`Pi stopped after signal ${result.signal}.`);
  return result.code ?? 1;
}

export function copyResumeCommand(session, { pbcopyPath = "pbcopy", run = spawnSync } = {}) {
  const command = resumeCommand(session);
  const result = run(pbcopyPath, [], {
    input: command,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw new Error(`Could not start pbcopy: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) {
    throw new Error(`pbcopy failed: ${result.stderr?.trim() || `exit status ${result.status}`}`);
  }
  return command;
}

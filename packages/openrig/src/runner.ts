import { spawn } from "node:child_process";

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

/** Every external process goes through this. Tests replace it with a fake; there is never a shell. */
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

export const spawnRunner: CommandRunner = (request) =>
  new Promise((resolvePromise) => {
    const max = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      signal: request.signal,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes + chunk.length > max) {
        truncated = true;
        out.push(chunk.subarray(0, Math.max(0, max - outBytes)));
        outBytes = max;
        return;
      }
      outBytes += chunk.length;
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes < max) {
        err.push(chunk.subarray(0, max - errBytes));
        errBytes += chunk.length;
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request.stdin ?? "");
    const finish = (code: number, extraErr = ""): void => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + extraErr,
        timedOut,
        truncated,
      });
    };
    child.on("error", (error) => finish(127, `\n${error.message}`));
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });

/** Minimal, explicit environment for child processes. Nothing from the agent process env leaks through. */
export function childEnv(options: { readonly home: string; readonly path: string; readonly extra?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = {
    HOME: options.home,
    PATH: options.path,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    AWS_PAGER: "",
    AWS_SDK_LOAD_CONFIG: "1",
    GIT_TERMINAL_PROMPT: "0",
    KUBECTL_EXTERNAL_DIFF: "",
  };
  const user = process.env.USER;
  if (user) env.USER = user;
  const tmp = process.env.TMPDIR;
  if (tmp) env.TMPDIR = tmp;
  return { ...env, ...(options.extra ?? {}) };
}

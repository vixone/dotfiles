import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { prepareScratch, sandboxEnv, sandboxProfile, SANDBOX_EXEC, SHELL, shellEnvFile, WRAPPED_COMMAND } from "../src/sandbox.ts";
import { makeEnv, RIG_ROOT, type TestEnv } from "./helpers.ts";

/**
 * Real sandbox-exec, invoked exactly as Pi's bash tool does after our spawnHook: SHELL -c WRAPPED_COMMAND
 * with the hook's env. Every denial has a control run without the profile, so a broken probe cannot pass.
 */
describe("sandboxed bash", { skip: existsSync(SANDBOX_EXEC) ? false : "no sandbox-exec" }, () => {
  let env: TestEnv;
  let profile: string;
  let scratchHome: string;
  let scratchTmp: string;
  let repo: string;
  let http: Server;
  let httpPort: number;
  let sock: NetServer;
  let sockPath: string;

  before(async () => {
    env = makeEnv();
    const h = env.home;
    for (const d of [".aws", "Library/Keys", "sandbox/other", ".devrig/control", ".missions"]) mkdirSync(join(h, d), { recursive: true });
    writeFileSync(join(h, ".aws", "credentials"), "aws_secret_access_key = SHOULD-NOT-LEAK\n");
    writeFileSync(join(h, "Library", "Keys", "k"), "keychain-ish\n");
    writeFileSync(join(h, ".zshrc.local"), "export TOKEN=x\n");
    writeFileSync(join(h, ".missions", "mx.db"), "db\n");
    repo = env.policy.repos.sample ?? "";
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "values.yaml"), "a: 1\n");
    const s = prepareScratch(join(env.dir, "scratch"), { name: "Op", email: "op@example.com" });
    scratchHome = s.home;
    scratchTmp = s.tmp;
    profile = sandboxProfile(env.policy, { home: h, scratch: s.scratch, workspace: env.policy.workspace, writableRepos: env.policy.bash.writableRepos, denyPaths: [env.policy.controlRoot] });

    http = createHttpServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    httpPort = (http.address() as AddressInfo).port;
    sockPath = join(env.dir, "s.sock");
    sock = createNetServer((c) => c.end("hello\n"));
    await new Promise<void>((r) => sock.listen(sockPath, r));
  });

  after(async () => {
    await new Promise<void>((r) => http.close(() => r()));
    await new Promise<void>((r) => sock.close(() => r()));
    env.cleanup();
  });

  function run(args: string[], cmd: string): Promise<{ code: number | null; out: string }> {
    return new Promise((done) => {
      const child = spawn(SHELL, args, { cwd: env.policy.workspace, env: sandboxEnv(env.policy, scratchHome, scratchTmp, profile, cmd), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      const t = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (code) => {
        clearTimeout(t);
        done({ code, out });
      });
    });
  }
  const sandboxed = (cmd: string) => run(["-c", WRAPPED_COMMAND], cmd);
  const control = (cmd: string) => run(["-c", cmd], cmd);
  async function deniedWithControl(cmd: string): Promise<void> {
    const c = await control(cmd);
    assert.equal(c.code, 0, `control failed, probe is broken: ${c.out}`);
    const s = await sandboxed(cmd);
    assert.notEqual(s.code, 0, `sandbox allowed: ${s.out}`);
  }

  it("runs ordinary commands with the scratch HOME and a clean env", async () => {
    process.env.DEVRIG_TEST_SECRET = "leak-me";
    try {
      const r = await sandboxed('echo "$HOME"; pwd; env');
      assert.equal(r.code, 0, r.out);
      assert.ok(r.out.startsWith(`${scratchHome}\n${env.policy.workspace}\n`), r.out);
      assert.ok(!r.out.includes("leak-me"));
      assert.match(r.out, /KUBECONFIG=\/dev\/null/);
    } finally {
      delete process.env.DEVRIG_TEST_SECRET;
    }
  });

  it("passes the command through unchanged, quotes and all", async () => {
    const r = await sandboxed(`printf '%s|' "a b" 'c"d' "$(echo e\\$f)"`);
    assert.equal(r.out, 'a b|c"d|e$f|');
  });

  it("denies credential reads", async () => {
    await deniedWithControl(`cat ${env.home}/.aws/credentials`);
    await deniedWithControl(`cat ${env.home}/.zshrc.local`);
    await deniedWithControl(`cat ${env.home}/Library/Keys/k`);
    await deniedWithControl(`ls ${env.home}/.devrig/control`);
  });

  it("allows writes to the workspace, scratch and repos, nowhere else", async () => {
    assert.equal((await sandboxed("echo x > out.txt && cat out.txt")).out, "x\n");
    assert.equal((await sandboxed(`echo y > "$TMPDIR/t" && echo z > ~/h && cat "$TMPDIR/t" ~/h`)).out, "y\nz\n");
    assert.equal((await sandboxed(`echo "a: 2" > ${repo}/values.yaml && cat ${repo}/values.yaml`)).out, "a: 2\n");
    await deniedWithControl(`echo x > ${env.home}/sandbox/other/f`);
    await deniedWithControl(`echo x > ${repo}/.git/f`);
    await deniedWithControl(`echo x > ${env.home}/.devrig/control/approval.json`);
    await deniedWithControl(`echo x >> ${env.home}/.missions/mx.db`);
    await deniedWithControl(`echo x > ${env.policy.rigRoot}/policy-tamper`);
    assert.equal(readFileSync(join(env.home, ".missions", "mx.db"), "utf8"), "db\n".concat("x\n"));
  });

  it("lets /usr/bin/diff spool its temp files and keeps the rest of /tmp read-only", async () => {
    const r = await sandboxed("diff <(printf 'a\\nb\\n') <(printf 'a\\nc\\n'); echo x | diff - <(echo x) && echo same");
    assert.match(r.out, /^2c2\n< b\n---\n> c\nsame\n$/, r.out);
    const probes = [`/tmp/devrig-sbx-${process.pid}`, "/tmp/diff.abc", "/tmp/diff.abcdefghi"];
    try {
      for (const p of probes) await deniedWithControl(`echo x > ${p}`);
    } finally {
      for (const p of probes) rmSync(p, { force: true });
    }
  });

  it("can read the mx db and repos", async () => {
    assert.equal((await sandboxed(`head -c 2 ${env.home}/.missions/mx.db`)).out, "db");
  });

  it("denies localhost and unix sockets", async () => {
    await deniedWithControl(`/usr/bin/curl -sf -m 3 http://127.0.0.1:${httpPort}/`);
    await deniedWithControl(`/usr/bin/nc -U ${sockPath} < /dev/null | grep -q hello`);
  });

  it("opens a writable dir prefix for the seat shell and nothing beside it", async () => {
    const base = profile;
    const other = join(env.dir, "other");
    const bm = join(env.dir, "powerline-bash-mode-ab.c");
    for (const d of [other, bm, join(env.dir, "powerline-bash-mode-")]) mkdirSync(d, { recursive: true });
    try {
      profile = sandboxProfile(env.policy, { home: env.home, scratch: join(env.dir, "scratch"), workspace: env.policy.workspace, writableRepos: [], denyPaths: [env.policy.controlRoot], writableDirPrefixes: [join(env.dir, "powerline-bash-mode-")] });
      assert.equal((await sandboxed(`echo x > ${bm}/cmd-1.sh && rm ${bm}/cmd-1.sh && echo ok`)).out, "ok\n");
      await deniedWithControl(`echo x > ${other}/f`);
      await deniedWithControl(`echo x > ${env.dir}/powerline-bash-mode-/f`);
      await deniedWithControl(`echo x > ${env.dir}/powerline-bash-modeX`);
      assert.throws(() => sandboxProfile(env.policy, { home: env.home, scratch: env.dir, workspace: env.policy.workspace, writableRepos: [], denyPaths: [], writableDirPrefixes: ['/tmp/a"b'] }), /quote/);
    } finally {
      profile = base;
    }
  });

  it("denies looking at other processes", async () => {
    await deniedWithControl(`/bin/ps -o pid= -p ${process.pid}`);
  });

  it("cleans up the scratch git identity", async () => {
    assert.equal((await sandboxed("git config --global user.email")).out, "op@example.com\n");
    rmSync(join(scratchHome, ".gitconfig"));
  });
});

describe("shellEnvFile", () => {
  it("drops the command and profile variables and refuses line breaks", () => {
    assert.equal(shellEnvFile({ HOME: "/h", DEVRIG_SB_PROFILE: "(version 1)", DEVRIG_SB_CMD: "ls", KUBECONFIG: "/k" }), "HOME=/h\nKUBECONFIG=/k\n");
    assert.throws(() => shellEnvFile({ HOME: "/h\nX=1" }), /line break/);
    assert.throws(() => shellEnvFile({ "bad-name": "x" }), /plain name/);
  });
});

/**
 * bin/seat-shell/bash, the SHELL a locked seat exports for interactive shells (powerline bash-mode). Driven like
 * bash-mode drives it: no args, commands on stdin.
 */
describe("seat shell wrapper", { skip: existsSync(SANDBOX_EXEC) ? false : "no sandbox-exec" }, () => {
  const wrapper = join(RIG_ROOT, "bin", "seat-shell", "bash");
  let env: TestEnv;
  let shellDir: string;
  let scratchHome: string;

  before(() => {
    env = makeEnv();
    const h = env.home;
    mkdirSync(join(h, ".aws"), { recursive: true });
    writeFileSync(join(h, ".aws", "credentials"), "aws_secret_access_key = SHOULD-NOT-LEAK\n");
    shellDir = join(h, ".devrig", "openrig-home", "state", "pi-tui", "dev-x@rig", "agent", "shell");
    mkdirSync(shellDir, { recursive: true });
    const s = prepareScratch(join(env.dir, "scratch"), {});
    scratchHome = s.home;
    const profile = sandboxProfile(env.policy, { home: h, scratch: s.scratch, workspace: env.policy.workspace, writableRepos: [], denyPaths: [env.policy.controlRoot] });
    writeFileSync(join(shellDir, "profile.sb"), profile);
    writeFileSync(join(shellDir, "env"), shellEnvFile(sandboxEnv(env.policy, s.home, s.tmp, profile, "")));
  });

  after(() => env.cleanup());

  function shell(dir: string, stdin: string): Promise<{ code: number | null; out: string }> {
    return new Promise((done) => {
      const child = spawn(wrapper, [], { cwd: env.policy.workspace, env: { ...process.env, DEVRIG_SEAT_SHELL_DIR: dir, DEVRIG_TEST_SECRET: "leak-me" }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      const t = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (code) => {
        clearTimeout(t);
        done({ code, out });
      });
      child.stdin.end(stdin);
    });
  }

  it("runs bash in the seat sandbox with the seat env only", async () => {
    const r = await shell(shellDir, 'echo "home=$HOME kube=$KUBECONFIG shell=$SHELL"\nenv\n');
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.startsWith(`home=${scratchHome} kube=/dev/null shell=/bin/bash\n`), r.out);
    assert.ok(!r.out.includes("leak-me"), r.out);
    assert.ok(!r.out.includes("DEVRIG_SEAT_SHELL_DIR"), r.out);
  });

  it("cannot read credentials or its own profile and env", async () => {
    const r = await shell(shellDir, `cat ${env.home}/.aws/credentials; echo "aws=$?"; cat ${shellDir}/env; echo "env=$?"; echo x > ${shellDir}/profile.sb; echo "write=$?"\n`);
    assert.ok(!r.out.includes("SHOULD-NOT-LEAK"), r.out);
    assert.match(r.out, /aws=1\n/);
    assert.match(r.out, /env=1\n/);
    assert.match(r.out, /write=1\n/);
  });

  it("refuses a dir that is not a seat shell dir", async () => {
    for (const dir of ["", "/tmp/x", join(env.dir, "shell"), `${shellDir}/../shell`]) {
      const r = await shell(dir, "echo ran\n");
      assert.equal(r.code, 2, `${dir}: ${r.out}`);
      assert.ok(!r.out.includes("ran"), r.out);
    }
  });
});

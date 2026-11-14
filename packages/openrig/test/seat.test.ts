import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSeatFiles, checkLayout, compactionOverrides, DISABLED_BUILTINS, parseSeatArgs, SeatError, seatUiArgs, writeUiArgs } from "../src/seat.ts";

const PROVIDER = "example-provider";
const HOME = "/Users/operator";
const NAME = "dev-expert1@devrig";
const SEAT = join(HOME, ".devrig", "openrig-home", "state", "pi", NAME);
const SESSIONS = join(SEAT, "sessions");
const base = ["--mode", "rpc", "--session-dir", SESSIONS, "--name", NAME, "--no-approve"];

describe("seat argument and path validation", () => {
  it("accepts qualified models from any configured provider", () => {
    for (const model of ["example-provider/coding-model", "other/model-v2:high"]) {
      assert.equal(parseSeatArgs([...base, "--model", model]).model, model);
    }
  });

  it("refuses unsafe or unexpected arguments", () => {
    for (const argv of [
      [...base, "--approve"], [...base, "-a"], base.filter((v) => v !== "--no-approve"),
      [...base, "--no-approve"], [...base, "--extension", "x.ts"], [...base, "--name", NAME],
      [...base, "--model", ""], [...base, "--model", "unqualified"], [...base, "--model", "p/x\ny"],
      [...base, "--thinking", "huge"], [...base, "--model"], [...base, "--session", "a", "--fork", "b"],
      ["--mode", "json", ...base.slice(2)], ["--mode", "rpc", "--session-dir", "--no-approve"],
    ]) assert.throws(() => parseSeatArgs(argv), SeatError);
  });

  it("confines sessions and forks to the seat's own state directory", () => {
    const args = parseSeatArgs(base);
    const env = { PI_CODING_AGENT_DIR: join(SEAT, "agent"), PI_CODING_AGENT_SESSION_DIR: SESSIONS };
    assert.deepEqual(checkLayout(args, env, HOME), { agentDir: join(SEAT, "agent"), sessionsDir: SESSIONS });
    checkLayout({ ...args, session: join(SESSIONS, "a.jsonl") }, env, HOME);
    checkLayout({ ...args, fork: "0193-abc" }, env, HOME);
    for (const agent of [undefined, "relative/agent", join(HOME, ".pi", "agent"), `${SEAT}/../x/agent`]) {
      assert.throws(() => checkLayout(args, { ...env, PI_CODING_AGENT_DIR: agent }, HOME), SeatError);
    }
    for (const file of [SESSIONS, "/etc/passwd", join(SEAT, "agent", "auth.json")]) {
      assert.throws(() => checkLayout({ ...args, session: file }, env, HOME), SeatError);
      assert.throws(() => checkLayout({ ...args, fork: file }, env, HOME), SeatError);
    }
    assert.throws(() => checkLayout({ ...args, name: "other" }, env, HOME), /does not match/);
    assert.throws(() => checkLayout(args, { ...env, PI_CODING_AGENT_SESSION_DIR: "/tmp" }, HOME), /sessions/);
  });
});

const budget = { hardCompactTokens: 200_000, keepRecentTokens: 40_000 };
const catalog = { models: [
  { id: "coding-model", contextWindow: 400_000 }, { id: "small", contextWindow: 128_000 },
  { id: "tight", contextWindow: 210_000 }, { id: "fits", contextWindow: 216_384 }, { id: "broken" }, "junk",
] };

describe("seat provider configuration", () => {
  const cred = { type: "oauth", refresh: "test-refresh", access: "test-access", expires: 1000 };
  const operator = {
    settings: { defaultProvider: PROVIDER, defaultModel: "coding-model", defaultThinkingLevel: "medium", retry: { maxRetries: 3 }, packages: ["npm:unwanted"] },
    models: { providers: { [PROVIDER]: { models: [] }, unused: { apiKey: "not-copied" } } },
    modelsStore: { [PROVIDER]: catalog, unused: { models: [] } },
    auth: { [PROVIDER]: cred, unused: { key: "not-copied" } },
  };
  const tools = ["fs_read", "git"];

  it("pins compaction only for models with sufficient headroom", () => {
    assert.deepEqual(compactionOverrides(catalog, budget, PROVIDER), {
      [`${PROVIDER}/coding-model`]: { reserveTokens: 200_000 }, [`${PROVIDER}/fits`]: { reserveTokens: 16_384 },
    });
    assert.deepEqual(compactionOverrides({}, budget, PROVIDER), {});
  });

  it("copies only the selected provider and locks down resource loading", () => {
    const f = buildSeatFiles(operator, {}, tools, budget);
    assert.deepEqual(Object.keys(f.models.providers as object), [PROVIDER]);
    assert.deepEqual(Object.keys(f.modelsStore), [PROVIDER]);
    assert.deepEqual(f.auth, { [PROVIDER]: cred });
    assert.equal(f.settings.defaultProvider, PROVIDER);
    assert.equal(f.settings.defaultModel, "coding-model");
    assert.equal(f.settings.defaultThinkingLevel, "medium");
    assert.deepEqual(f.settings.retry, { maxRetries: 3 });
    assert.deepEqual(f.settings.defaultTools, tools);
    assert.deepEqual(f.settings.extensions, [...DISABLED_BUILTINS]);
    for (const key of ["packages", "skills", "prompts", "themes"]) assert.deepEqual(f.settings[key], []);
    assert.equal(f.settings.defaultProjectTrust, "never");
    assert.equal(f.settings.enableSkillCommands, false);
    assert.ok(!JSON.stringify(f).includes("not-copied"));
  });

  it("requires an explicit provider, model and stored login", () => {
    for (const settings of [{}, { defaultProvider: PROVIDER }, { defaultProvider: "bad provider", defaultModel: "x" }]) {
      assert.throws(() => buildSeatFiles({ ...operator, settings }, {}, tools, budget), /default provider and model/);
    }
    assert.throws(() => buildSeatFiles({ ...operator, auth: {} }, {}, tools, budget), /no example-provider login/);
  });

  it("supports stored API keys and never reuses a seat key from another login", () => {
    const auth = { [PROVIDER]: { type: "api_key", key: "test-key" } };
    assert.deepEqual(buildSeatFiles({ ...operator, auth }, {}, tools, budget).auth, auth);
    const newer = { ...cred, access: "new-test-access", expires: 2000 };
    assert.deepEqual(buildSeatFiles(operator, { [PROVIDER]: newer }, tools, budget).auth, { [PROVIDER]: newer });
    for (const seatCred of [{ ...cred, expires: 500 }, { ...newer, refresh: "different-login" }]) {
      assert.deepEqual(buildSeatFiles(operator, { [PROVIDER]: seatCred }, tools, budget).auth, { [PROVIDER]: cred });
    }
  });

  it("copies requested UI settings without overriding locked settings", () => {
    const settings = { ...operator.settings, hideThinkingBlock: false };
    const f = buildSeatFiles({ ...operator, settings }, {}, tools, budget, ["hideThinkingBlock", "packages", "missing"]);
    assert.equal(f.settings.hideThinkingBlock, false);
    assert.deepEqual(f.settings.packages, []);
    assert.ok(!("missing" in f.settings));
  });
});

describe("seat UI arguments", () => {
  it("uses explicit paths and refuses missing or malformed paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "devrig-ui-"));
    try {
      const ext = join(dir, "ext.ts");
      writeFileSync(ext, "");
      const ui = { extensions: [ext], skills: [dir], themes: [], settings: [] };
      assert.deepEqual(seatUiArgs(ui), ["-e", ext, "--skill", dir]);
      assert.equal(readFileSync(writeUiArgs(dir, ui), "utf8"), `-e\n${ext}\n--skill\n${dir}\n`);
      assert.throws(() => writeUiArgs(dir, { ...ui, extensions: [join(dir, "gone.ts")] }), /missing/);
      assert.throws(() => writeUiArgs(dir, { ...ui, extensions: ["relative.ts"] }), /absolute/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

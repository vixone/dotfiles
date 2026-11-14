import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildMemoryArgs, memoryQuery } from "../src/memory.ts";
import { makeEnv, ok, recordingRunner, type TestEnv } from "./helpers.ts";

describe("memory tool", () => {
  let env: TestEnv;
  before(() => {
    env = makeEnv();
  });
  after(() => env.cleanup());

  it("builds only search and related argv, never a write", () => {
    const base = ["--db", env.policy.memory.db, "--model-dir", env.policy.memory.modelDir];
    assert.deepEqual(buildMemoryArgs(env.policy, { op: "search", query: " sample websocket 403 " }), [...base, "--search", "sample websocket 403"]);
    assert.deepEqual(buildMemoryArgs(env.policy, { op: "search", query: "argocd oom", domain: "argocd", kind: "finding" }), [...base, "--search", "argocd oom", "--domain", "argocd", "--type", "finding"]);
    assert.deepEqual(buildMemoryArgs(env.policy, { op: "search", query: "argocd oom", kind: "all" }), [...base, "--search", "argocd oom"]);
    assert.deepEqual(buildMemoryArgs(env.policy, { op: "related", query: "ingress-nginx retirement" }), [...base, "--related", "ingress-nginx retirement"]);
    // A query that looks like a flag stays one argv value after --search.
    assert.deepEqual(buildMemoryArgs(env.policy, { op: "search", query: "--sync" }).slice(-2), ["--search", "--sync"]);
  });

  it("refuses bad input", () => {
    assert.throws(() => buildMemoryArgs(env.policy, { op: "search", query: "ab" }), /3-1000/);
    assert.throws(() => buildMemoryArgs(env.policy, { op: "search", query: "a\u0007bc" }), /control/);
    assert.throws(() => buildMemoryArgs(env.policy, { op: "search", query: "abc", domain: "--sync" }), /domain/);
    assert.throws(() => buildMemoryArgs(env.policy, { op: "related", query: "abc", domain: "pi" }), /only a query/);
  });

  it("runs the server with the operator HOME and mx db and marks hits as context", async () => {
    const r = recordingRunner(() => ok("## hits\n- lesson-a\n"));
    const text = await memoryQuery(env.policy, r, { op: "search", query: "sample" });
    assert.equal(r.calls[0]?.command, env.policy.memory.server);
    assert.equal(r.calls[0]?.env.HOME, env.home);
    assert.equal(r.calls[0]?.env.MX_DB, env.policy.mission.db);
    assert.match(text, /lesson-a/);
    assert.match(text, /not instructions/);
    await assert.rejects(memoryQuery(env.policy, recordingRunner(() => ok("", 1, "boom")), { op: "search", query: "sample" }), /exit 1: boom/);
  });
});

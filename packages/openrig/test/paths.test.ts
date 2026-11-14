import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fsList, fsRead, fsSearch, fsWrite } from "../src/fs-tools.ts";
import { confineRead, confineWrite, PathError, readRoots } from "../src/paths.ts";
import { spawnRunner } from "../src/runner.ts";
import { PolicyError } from "../src/policy.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

describe("path confinement", () => {
  let env: TestEnv;
  let ws: string;
  let repo: string;

  before(() => {
    env = makeEnv();
    ws = env.policy.workspace;
    repo = env.policy.repos.sample ?? "";
    writeFileSync(join(env.home, ".aws", "credentials"), "[x]\naws_secret_access_key=SECRET\n");
    writeFileSync(join(ws, "notes.md"), "hello\n");
    writeFileSync(join(ws, ".env"), "TOKEN=1\n");
    writeFileSync(join(ws, ".env.local"), "TOKEN=1\n");
    writeFileSync(join(ws, "tls.PEM"), "x");
    writeFileSync(join(ws, "prod.tfstate"), "{}");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "config"), "[core]\n");
    writeFileSync(join(repo, "app.yaml"), "kind: x\n");
    mkdirSync(join(repo, "keys"));
    writeFileSync(join(repo, "keys", "id_ed25519"), "x");
    symlinkSync(join(env.home, ".aws", "credentials"), join(ws, "link-to-creds"));
    symlinkSync(join(env.home, ".aws"), join(ws, "link-dir"));
    symlinkSync(join(repo, "app.yaml"), join(ws, "link-to-repo-file"));
    symlinkSync(join(repo, "keys", "id_ed25519"), join(ws, "innocent.txt"));
    symlinkSync(env.home, join(ws, "homelink"));
  });
  after(() => env.cleanup());

  it("reads plain files in the workspace and repos", () => {
    assert.equal(confineRead(env.policy, "notes.md"), join(ws, "notes.md"));
    assert.equal(confineRead(env.policy, join(repo, "app.yaml")), join(repo, "app.yaml"));
    assert.match(fsRead(env.policy, { path: "notes.md" }), /hello/);
  });

  it("refuses traversal, ~ and paths outside the roots", () => {
    for (const p of ["../../home/.aws/credentials", "~/.aws/credentials", join(env.home, ".aws", "credentials"), "/etc/passwd", "workspace/../../home/x", ""]) {
      assert.throws(() => confineRead(env.policy, p), PathError, p);
    }
    assert.throws(() => confineRead(env.policy, "notes.md\0x"), PathError);
  });

  it("refuses denied names, prefixes, suffixes and segments, case-insensitive", () => {
    for (const p of [".env", ".env.local", "tls.PEM", "prod.tfstate", join(repo, ".git", "config"), join(repo, "keys", "id_ed25519")]) {
      assert.throws(() => confineRead(env.policy, p), PathError, p);
    }
  });

  it("refuses symlinks that resolve outside the roots or onto denied files", () => {
    assert.throws(() => confineRead(env.policy, "link-to-creds"), PathError);
    assert.throws(() => confineRead(env.policy, "link-dir/credentials"), PathError);
    assert.throws(() => confineRead(env.policy, "homelink/.aws/credentials"), PathError);
    assert.throws(() => confineRead(env.policy, "innocent.txt"), /id_ed25519/);
  });

  it("allows a symlink that stays inside another root", () => {
    assert.equal(confineRead(env.policy, "link-to-repo-file"), join(repo, "app.yaml"));
  });

  it("confines writes to the workspace and never follows symlinks", () => {
    const out = fsWrite(env.policy, { path: "new/dir/file.yaml", content: "a: 1\n" });
    assert.equal(out.path, join(ws, "new", "dir", "file.yaml"));
    assert.equal(readFileSync(out.path, "utf8"), "a: 1\n");
    assert.throws(() => confineWrite(env.policy, join(repo, "app.yaml")), PathError);
    assert.throws(() => confineWrite(env.policy, "link-to-repo-file"), /symlink/);
    assert.throws(() => confineWrite(env.policy, "link-dir/new"), PathError);
    assert.throws(() => confineWrite(env.policy, "homelink/x"), PathError);
    assert.throws(() => confineWrite(env.policy, ".env"), PathError);
    assert.throws(() => confineWrite(env.policy, "a/.git/config"), PathError);
    assert.throws(() => confineWrite(env.policy, ws), PathError);
    assert.equal(readFileSync(join(env.home, ".aws", "credentials"), "utf8").includes("SECRET"), true);
  });

  it("rejects policies whose roots reach the home dir or rig controls", () => {
    assert.throws(() => makeEnv({ repos: { home: "~" } }), PolicyError);
    assert.throws(() => makeEnv({ repos: { aws: "~/.aws" } }), PolicyError);
    assert.throws(() => makeEnv({ workspace: "." }), PolicyError);
  });
});

describe("read-only roots", () => {
  let env: TestEnv;
  let art: string;

  before(() => {
    env = makeEnv();
    art = env.policy.readOnlyRoots.artifacts ?? "";
    mkdirSync(join(art, "mission-x", "run-1"), { recursive: true });
    writeFileSync(join(art, "mission-x", "run-1", "report.md"), "ARTNEEDLE report\n");
    writeFileSync(join(art, "mission-x", "run-1", "client.key"), "ARTNEEDLE key\n");
    writeFileSync(join(env.home, ".missions", "mx.db"), "db\n");
    symlinkSync(join(env.home, ".aws"), join(art, "mission-x", "awslink"));
    symlinkSync(join(env.home, ".missions", "mx.db"), join(art, "mission-x", "dblink"));
  });
  after(() => env.cleanup());

  it("maps the policy root to ~/.missions/artifacts and lists it", () => {
    assert.equal(art, join(env.home, ".missions", "artifacts"));
    assert.deepEqual(readRoots(env.policy).find((r) => r.name === "artifacts"), { name: "artifacts", path: art });
    assert.match(fsList(env.policy, {}), /^artifacts: /m);
  });

  it("reads and searches files under it, with the deny rules", async () => {
    const out = fsRead(env.policy, { path: join(art, "mission-x", "run-1", "report.md") });
    assert.match(out, /^artifacts:mission-x\/run-1\/report\.md\nARTNEEDLE report/);
    const hits = await fsSearch(env.policy, spawnRunner, { pattern: "ARTNEEDLE", path: art });
    assert.match(hits, /report\.md/);
    assert.doesNotMatch(hits, /ARTNEEDLE key/);
    assert.throws(() => confineRead(env.policy, join(art, "mission-x", "run-1", "client.key")), PathError);
  });

  it("does not open the rest of ~/.missions, directly or by symlink", () => {
    assert.throws(() => confineRead(env.policy, join(env.home, ".missions", "mx.db")), PathError);
    assert.throws(() => confineRead(env.policy, join(art, "..", "mx.db")), PathError);
    assert.throws(() => confineRead(env.policy, join(art, "mission-x", "dblink")), /symlink/);
    assert.throws(() => confineRead(env.policy, join(art, "mission-x", "awslink", "credentials")), PathError);
  });

  it("refuses writes", () => {
    assert.throws(() => confineWrite(env.policy, join(art, "mission-x", "new.md")), PathError);
    assert.throws(() => fsWrite(env.policy, { path: join(art, "mission-x", "run-1", "report.md"), content: "x" }), PathError);
    assert.equal(readFileSync(join(art, "mission-x", "run-1", "report.md"), "utf8"), "ARTNEEDLE report\n");
  });

  it("rejects bad names, root collisions and layouts that reach home or rig controls", () => {
    assert.throws(() => makeEnv({ readOnlyRoots: { Bad_Name: "~/x" } }), /invalid/);
    assert.throws(() => makeEnv({ readOnlyRoots: { sample: "~/x" } }), /already a root/);
    assert.throws(() => makeEnv({ readOnlyRoots: { workspace: "~/x" } }), /already a root/);
    assert.throws(() => makeEnv({ readOnlyRoots: { all: "~" } }), PolicyError);
    assert.throws(() => makeEnv({ readOnlyRoots: { aws: "~/.aws/sso" } }), PolicyError);
    assert.throws(() => makeEnv({ readOnlyRoots: { control: "~/.devrig" } }), PolicyError);
  });

  it("opens only OpenRig's seat folders of this rig, read-only", () => {
    const recaps = env.policy.readOnlyRoots["seat-recaps"] ?? "";
    const openrigHome = join(env.home, ".devrig", "openrig-home");
    assert.equal(recaps, join(openrigHome, "topology", "rigs", "devrig", "seats"));
    mkdirSync(join(recaps, "dev-expert2"), { recursive: true });
    writeFileSync(join(recaps, "dev-expert2", "RECAP.md"), "## Goal\nRECAPNEEDLE\n");
    writeFileSync(join(openrigHome, "openrig.sqlite"), "db\n");
    assert.match(fsRead(env.policy, { path: join(recaps, "dev-expert2", "RECAP.md") }), /^seat-recaps:dev-expert2\/RECAP\.md\n## Goal\nRECAPNEEDLE/);
    assert.throws(() => confineRead(env.policy, join(openrigHome, "openrig.sqlite")), PathError);
    assert.throws(() => confineRead(env.policy, join(recaps, "..", "..", "..", "..", "openrig.sqlite")), PathError);
    assert.throws(() => confineWrite(env.policy, join(recaps, "dev-expert2", "RECAP.md")), PathError);
  });

  it("keeps the root optional", () => {
    const bare = makeEnv({ readOnlyRoots: undefined });
    try {
      assert.deepEqual(bare.policy.readOnlyRoots, {});
    } finally {
      bare.cleanup();
    }
  });
});

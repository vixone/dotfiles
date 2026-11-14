import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { contextStatusPath, freshHint, freshRequest, writeContextStatus } from "../src/autofresh.ts";
import { seatSessionsDir } from "../src/pace.ts";
import { isWithin, loadPolicy, PolicyError, rigOfSession, seatRole } from "../src/policy.ts";
import { rigBusy } from "../src/rig-busy.ts";
import { renderSpec, renderSpecFile, rigEnvLines, rigLayout, scaffoldRig } from "../src/rig-env.ts";
import { teammates } from "../src/team.ts";
import { RIG_ROOT } from "./helpers.ts";

const BASE = "devrig";
const REVIEW = "review";
const overlay = () => ({
  rig: { name: REVIEW, seats: { "dev-lead": "architect", "dev-expert1": "expert", "dev-expert2": "expert" } },
  roles: { expert: { prompt: "context/expert.md", tools: ["fs_read", "team", "mission", "scope"] } },
  readOnlyRoots: { notes: "~/notes" },
});
function makeCatalog() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "devrig-catalog-")));
  const rigRoot = join(dir, "rig");
  const home = join(dir, "home");
  for (const d of ["policy", "context", "rig"]) cpSync(join(RIG_ROOT, d), join(rigRoot, d), { recursive: true });
  mkdirSync(join(rigRoot, "workspace", "project"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const catalog = join(rigRoot, "rigs", REVIEW);
  mkdirSync(join(catalog, "context"), { recursive: true });
  writeFileSync(join(catalog, "context", "expert.md"), "Review code.\n");
  writeFileSync(join(catalog, "overlay.json"), JSON.stringify(overlay()));
  writeFileSync(join(catalog, "rig.yaml"), `name: ${REVIEW}\ncwd: "@@WORKSPACE@@"\n`);
  return { rigRoot, home, catalog, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("personal base rig and overlays", () => {
  const c = makeCatalog();
  after(() => c.cleanup());
  const base = loadPolicy({ rigRoot: c.rigRoot, home: c.home });
  const review = loadPolicy({ rigRoot: c.rigRoot, home: c.home, rig: REVIEW });

  it("ships a personal coding-only policy with no repository grants", () => {
    assert.equal(base.rig.name, BASE);
    assert.deepEqual(base.repos, {});
    assert.deepEqual(base.bash.writableRepos, []);
    assert.deepEqual(base.github, { host: "github.com", owner: "vixone" });
    assert.ok(base.git.remotePattern.test("git@github.com:vixone/sample"));
    assert.ok(!base.git.remotePattern.test("git@github.com:someone-else/sample"));
    assert.equal(seatRole(base, `dev-lead@${BASE}`).posture, "operator");
    assert.equal(seatRole(base, `dev-expert1@${BASE}`).posture, "locked");
  });

  it("isolates workspaces, control paths and recaps by rig", () => {
    const l = rigLayout(review);
    assert.equal(l.spec, join(c.home, ".devrig", "rigs", REVIEW, "rig.yaml"));
    assert.equal(l.control, join(c.home, ".devrig", "rigs", REVIEW, "control"));
    assert.equal(l.projectGit, join(c.home, ".devrig", "rigs", REVIEW, "project.git"));
    assert.equal(l.workspace, join(c.rigRoot, "workspaces", REVIEW));
    assert.equal(l.project, join(l.workspace, "project"));
    assert.equal(l.recaps, join(c.home, ".devrig", "openrig-home", "topology", "rigs", REVIEW, "seats"));
    for (const root of [base.workspace, ...Object.values(base.readOnlyRoots)]) assert.ok(!isWithin(root, review.workspace));
    assert.equal(rigLayout(base).spec, join(c.home, ".devrig", "rig.yaml"));
    assert.deepEqual(teammates(review, `dev-lead@${REVIEW}`), [`dev-expert1@${REVIEW}`, `dev-expert2@${REVIEW}`]);
    assert.throws(() => seatRole(review, `dev-lead@${BASE}`), PolicyError);
  });

  it("preserves base safety settings and resolves role references in the overlay", () => {
    for (const key of ["tools", "repos", "github", "mission", "binaries", "bash", "context", "memory"] as const) assert.deepEqual(review[key], base[key]);
    const expert = seatRole(review, `dev-expert1@${REVIEW}`);
    assert.equal(expert.prompt, join(c.catalog, "context", "expert.md"));
    assert.equal(expert.ui, true);
    assert.deepEqual(expert.tools, overlay().roles.expert.tools);
    assert.deepEqual(seatRole(review, `dev-lead@${REVIEW}`).autoFresh?.seats, [`dev-expert1@${REVIEW}`, `dev-expert2@${REVIEW}`]);
    assert.deepEqual(freshRequest(review, `dev-expert1@${REVIEW}`, "blank", {}).args, ["--rig", REVIEW, "fresh", "expert1", "--blank"]);
    assert.equal(freshHint(review, `dev-expert2@${REVIEW}`), `devrig --rig ${REVIEW} fresh expert2`);
    assert.ok(rigEnvLines(rigLayout(review)).includes(`rig_name='${REVIEW}'`));
    assert.throws(() => rigEnvLines({ ...rigLayout(base), workspace: "/tmp/it's" }), /quote/);
  });

  it("rejects unsafe overlay changes", () => {
    const bad = makeCatalog();
    try {
      const load = (value: unknown) => {
        writeFileSync(join(bad.catalog, "overlay.json"), JSON.stringify(value));
        return () => loadPolicy({ rigRoot: bad.rigRoot, home: bad.home, rig: REVIEW });
      };
      for (const key of ["repos", "tools", "github", "bash", "workspace", "scope"]) assert.throws(load({ ...overlay(), [key]: {} }), /overlay key/);
      assert.throws(load({ ...overlay(), roles: { expert: { posture: "operator" } } }), /overlay key roles.expert.posture/);
      assert.throws(load({ ...overlay(), roles: { expert: { tools: ["unregistered"] } } }), /unknown unregistered/);
      assert.throws(load({ ...overlay(), roles: { expert: { prompt: "../../context/expert-brief.md" } } }), /prompt must be/);
      assert.throws(load({ ...overlay(), readOnlyRoots: { artifacts: "~/other" } }), /replaces a base root/);
      assert.throws(() => loadPolicy({ rigRoot: bad.rigRoot, home: bad.home, rig: "../escape" }), /rig name/);
      assert.throws(() => loadPolicy({ rigRoot: bad.rigRoot, home: bad.home, rig: "missing" }), /unknown rig/);
    } finally { bad.cleanup(); }
  });

  it("validates session suffixes and reads busy state from the selected seat", () => {
    assert.equal(rigOfSession(`dev-lead@${REVIEW}`), REVIEW);
    for (const name of [undefined, "", "dev-lead", "a@b@c", "dev-lead@../x"]) assert.equal(rigOfSession(name), undefined);
    writeContextStatus(contextStatusPath(seatSessionsDir(base, `dev-expert1@${BASE}`)), { tokens: 1, running: true, at: "2026-11-10T11:58:00Z" });
    assert.deepEqual(rigBusy(base, new Date("2026-11-10T12:00:00Z")), [`dev-expert1@${BASE} is mid-turn (since 11:58Z)`]);
  });

  it("renders portable specs without baked-in models", () => {
    const template = readFileSync(join(RIG_ROOT, "rig", "rig.template.yaml"), "utf8");
    const spec = renderSpec(template, BASE, { root: "/r", state: "/s", workspace: "/w" });
    assert.match(spec, /^name: devrig$/m);
    assert.match(spec, /id: dev/);
    assert.ok(!/^\s+model:/m.test(spec));
    assert.ok(!spec.includes("@@"));
    assert.throws(() => renderSpec(template, REVIEW, { root: "/r", state: "/s", workspace: "/w" }), /top-level/);
    assert.throws(() => renderSpec(`name: ${REVIEW}\nx: "@@UNKNOWN@@"`, REVIEW, { root: "/r", state: "/s", workspace: "/w" }), /placeholder/);
    assert.equal(readFileSync(renderSpecFile(review), "utf8"), `name: ${REVIEW}\ncwd: "${review.workspace}"\n`);
  });

  it("scaffolds rigs from the base or an overlay and refuses unsafe names", () => {
    const dir = scaffoldRig(base, "coding-next", base, c.home);
    const next = loadPolicy({ rigRoot: c.rigRoot, home: c.home, rig: "coding-next" });
    const spec = renderSpec(readFileSync(join(dir, "rig.yaml"), "utf8"), next.rig.name, { root: "/r", state: "/s", workspace: next.workspace });
    assert.ok(spec.includes(`cwd: "${next.workspace}"`));
    scaffoldRig(base, "review-next", review, c.home);
    const cloned = loadPolicy({ rigRoot: c.rigRoot, home: c.home, rig: "review-next" });
    assert.equal(seatRole(cloned, "dev-expert1@review-next").prompt, join(c.rigRoot, "rigs", "review-next", "context", "expert.md"));
    for (const name of [BASE, REVIEW, "../escape"]) assert.throws(() => scaffoldRig(base, name, base, c.home), PolicyError);
    assert.ok(!existsSync(join(c.rigRoot, "escape")));
  });
});

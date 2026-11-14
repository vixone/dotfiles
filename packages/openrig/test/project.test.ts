import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadPolicy } from "../src/policy.ts";
import { rigLayout } from "../src/rig-env.ts";
import { GOLDEN_HOME, RIG_ROOT } from "./helpers.ts";

// `devrig project` runs the operator's git on a tree the seats write. It is safe only while the git dir sits where
// seat bash cannot reach and git runs no hooks.
describe("devrig project", () => {
  const script = readFileSync(join(RIG_ROOT, "bin", "devrig"), "utf8");
  const policy = JSON.parse(readFileSync(join(RIG_ROOT, "policy", "safety.json"), "utf8"));

  it("keeps the git dir under ~/.devrig, which seat bash denies", () => {
    assert.match(script, /gitdir=\$rig_project_git\n/);
    assert.match(script, /state="\$acct_home\/\.devrig"/);
    assert.ok(policy.bash.denyHomePaths.includes(".devrig"));
    const layout = rigLayout(loadPolicy({ rigRoot: RIG_ROOT, home: GOLDEN_HOME }));
    assert.equal(layout.projectGit, join(GOLDEN_HOME, ".devrig", "project.git"));
  });

  it("runs git with hooks and fsmonitor off", () => {
    assert.match(script, /pgit\(\) \{\n\s+\/usr\/bin\/git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false/);
  });
});

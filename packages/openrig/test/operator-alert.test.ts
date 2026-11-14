import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { alertMessage, alertStep, applyAlertStep, findPane, INITIAL_ALERT, paneLabel, QUESTION_KEY, type Wait } from "../src/operator-alert.ts";
import { seatRole } from "../src/policy.ts";
import { makeEnv, ok, recordingRunner, RIG_ROOT } from "./helpers.ts";

const LEAD = "dev-lead@devrig";
const E1 = "dev-expert1@devrig";
const RIG = "devrig";

describe("operator question alerts", () => {
  it("sets alerts on the lead and refuses them on locked seats", () => {
    const env = makeEnv();
    try {
      assert.deepEqual(seatRole(env.policy, LEAD).operatorAlert, { pollSeconds: 15, repeatSeconds: 600 });
      assert.equal(seatRole(env.policy, E1).operatorAlert, undefined);
    } finally { env.cleanup(); }
    const raw = JSON.parse(readFileSync(join(RIG_ROOT, "policy", "safety.json"), "utf8"));
    raw.roles.expert.operatorAlert = { pollSeconds: 15, repeatSeconds: 600 };
    assert.throws(() => makeEnv({ roles: raw.roles }), /operatorAlert is for operator seats/);
  });

  it("finds the tile in the selected rig only", () => {
    assert.equal(paneLabel(LEAD), "dev.lead");
    const workspaces = { result: { workspaces: [{ label: RIG, workspace_id: "w1" }, { label: "review", workspace_id: "w2" }] } };
    const panes = { result: { panes: [{ label: "dev.lead", pane_id: "p1", workspace_id: "w1" }, { label: "dev.lead", pane_id: "p2", workspace_id: "w2" }] } };
    assert.equal(findPane(panes, workspaces, "review", "dev.lead"), "p2");
    assert.equal(findPane(panes, workspaces, RIG, "dev.expert1"), undefined);
    assert.equal(findPane({}, workspaces, RIG, "dev.lead"), undefined);
  });

  it("sounds on new questions, repeats after the interval and releases once", () => {
    const q: Wait = { key: QUESTION_KEY, text: "dev.lead asks you a question" };
    const repeat = 600_000;
    let r = alertStep(INITIAL_ALERT, [], 0, repeat, RIG);
    assert.deepEqual(r.step, { release: true });
    r = alertStep(r.next, [], 1000, repeat, RIG);
    assert.deepEqual(r.step, {});
    r = alertStep(r.next, [q], 2000, repeat, RIG);
    const report = { report: q.text, sound: { title: "devrig: question waiting", body: q.text } };
    assert.deepEqual(r.step, report);
    r = alertStep(r.next, [q], 3000, repeat, RIG);
    assert.deepEqual(r.step, {});
    r = alertStep(r.next, [q], 2000 + repeat, repeat, RIG);
    assert.deepEqual(r.step, report);
    r = alertStep(r.next, [], 3000 + repeat, repeat, RIG);
    assert.deepEqual(r.step, { release: true });
    assert.ok(alertMessage([{ key: QUESTION_KEY, text: "x".repeat(300) }]).length <= 160);
  });

  it("uses the private Herdr socket and question notification", async () => {
    const env = makeEnv();
    try {
      const panes = JSON.stringify({ result: { panes: [{ label: "dev.lead", pane_id: "p1", workspace_id: "w1" }] } });
      const workspaces = JSON.stringify({ result: { workspaces: [{ label: RIG, workspace_id: "w1" }] } });
      const runner = recordingRunner((req) => ok(req.args[0] === "pane" && req.args[1] === "list" ? panes : req.args[0] === "workspace" ? workspaces : "{}"));
      await applyAlertStep(env.policy, runner, RIG, "dev.lead", { report: "question", sound: { title: "t", body: "b" } });
      await applyAlertStep(env.policy, runner, RIG, "dev.lead", { release: true });
      await applyAlertStep(env.policy, runner, RIG, "dev.lead", {});
      assert.deepEqual(runner.calls.map((c) => c.args.join(" ")), [
        "pane list", "workspace list", "pane report-agent p1 --source devrig --agent pi --state blocked --message question",
        "notification show t --body b --sound request", "pane list", "workspace list", "pane release-agent p1 --source devrig --agent pi",
      ]);
      assert.match(runner.calls[0]?.env.HERDR_SOCKET_PATH ?? "", /\.devrig\/daemon-home\/\.config\/herdr\/herdr\.sock$/);
      await assert.rejects(applyAlertStep(env.policy, runner, "absent", "dev.lead", { report: "x" }), /no Herdr pane dev\.lead/);
    } finally { env.cleanup(); }
  });
});

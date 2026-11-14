import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { missionCalls, renderBrief, runMission, MissionError } from "../src/mission.ts";
import { PolicyError, seatRole } from "../src/policy.ts";
import { runScope, scopeCall, ScopeError } from "../src/scope.ts";
import { runTeam, teamCall, TeamError, teamUrl, type TeamSeat } from "../src/team.ts";
import { makeEnv, ok, recordingRunner, RIG_ROOT } from "./helpers.ts";

const env = makeEnv();
after(() => env.cleanup());
const { policy } = env;
const LEAD = "dev-lead@devrig";
const E1 = "dev-expert1@devrig";
const E2 = "dev-expert2@devrig";
const SUP = "dev-supervisor@devrig";
const URL = "http://127.0.0.1:7433";
const lead: TeamSeat = { name: LEAD, role: seatRole(policy, LEAD), url: URL };
const expert: TeamSeat = { name: E1, role: seatRole(policy, E1), url: URL };

const raw = (): Record<string, unknown> => JSON.parse(readFileSync(join(RIG_ROOT, "policy", "safety.json"), "utf8")) as Record<string, unknown>;
const rolesWith = (patch: (roles: Record<string, Record<string, unknown>>) => void): Record<string, unknown> => {
  const roles = structuredClone(raw().roles) as Record<string, Record<string, unknown>>;
  patch(roles);
  return { roles };
};

describe("roles", () => {
  it("maps each seat to its role", () => {
    assert.equal(seatRole(policy, LEAD).name, "architect");
    assert.equal(seatRole(policy, E2).name, "expert");
    assert.ok(seatRole(policy, LEAD).prompt.endsWith(join("context", "lead-brief.md")));
  });

  it("refuses unknown and inherited seat names", () => {
    for (const name of [undefined, "dev-unknown@devrig", "dev-lead@other", "constructor", "__proto__"]) {
      assert.throws(() => seatRole(policy, name), PolicyError);
    }
  });

  it("rejects a role tool the rig does not have", () => {
    assert.throws(() => makeEnv(rolesWith((r) => ((r.expert as { tools: string[] }).tools = ["fs_read", "terminal"]))), /unknown terminal/);
  });

  it("needs ops exactly when the role has the tool", () => {
    assert.throws(() => makeEnv(rolesWith((r) => ((r.expert as Record<string, unknown>).teamOps = []))), /teamOps must be set/);
    assert.throws(() => makeEnv(rolesWith((r) => ((r.expert as Record<string, unknown>).missionOps = ["brief", "rm"]))), /unknown rm/);
  });

  it("runs the lead as an operator seat and the experts locked", () => {
    assert.equal(seatRole(policy, LEAD).posture, "operator");
    assert.equal(seatRole(policy, E1).posture, "locked");
    assert.ok(!seatRole(policy, LEAD).tools.includes("bash"));
  });

  it("refuses an operator role that lists Pi's own tools, and unknown postures", () => {
    assert.throws(() => makeEnv(rolesWith((r) => (r.architect as { tools: string[] }).tools.unshift("bash"))), /Pi's own bash/);
    assert.throws(() => makeEnv(rolesWith((r) => ((r.expert as Record<string, unknown>).posture = "free"))), /posture must be one of/);
  });

  it("does not grant tools outside the coding policy", () => {
    assert.throws(() => makeEnv(rolesWith((r) => (r.expert as { tools: string[] }).tools.push("unregistered_tool"))), /unknown unregistered_tool/);
    assert.deepEqual(seatRole(policy, LEAD).tools, ["team", "mission", "scope"]);
  });

  it("gives the experts the seat UI and keeps it to locked roles", () => {
    assert.equal(seatRole(policy, E1).ui, true);
    assert.equal(seatRole(policy, LEAD).ui, false);
    assert.throws(() => makeEnv(rolesWith((r) => ((r.architect as Record<string, unknown>).ui = true))), /ui is for locked seats/);
    assert.throws(() => makeEnv(rolesWith((r) => ((r.expert as Record<string, unknown>).ui = "yes"))), /ui must be a boolean/);
  });

  it("refuses seat UI paths the agent can write, and settings the rig owns", () => {
    const ui = { extensions: [], skills: [], themes: [], settings: ["theme"] };
    assert.throws(() => makeEnv({ seatUi: { ...ui, extensions: ["workspace/evil.ts"] } }), /inside agent-reachable root/);
    assert.throws(() => makeEnv({ seatUi: { ...ui, skills: ["~/sandbox/sample/skills"] } }), /inside agent-reachable root/);
    for (const key of ["packages", "extensions", "defaultTools", "compaction", "shellPath"]) {
      assert.throws(() => makeEnv({ seatUi: { ...ui, settings: [key] } }), /may not copy/);
    }
    assert.throws(() => makeEnv({ seatUi: { ...ui, settings: ["a.b"] } }), /is invalid/);
    assert.deepEqual(makeEnv({ seatUi: ui }).policy.seatUi.settings, ["theme"]);
  });

  it("rejects a role prompt outside context/", () => {
    assert.throws(() => makeEnv(rolesWith((r) => ((r.expert as Record<string, unknown>).prompt = "policy/operating-policy.md"))), /under context/);
  });

  it("rejects a seat mapped to a missing or inherited role", () => {
    assert.throws(() => makeEnv({ rig: { name: "devrig", seats: { "dev-lead": "toString", "dev-expert1": "expert", "dev-expert2": "expert" } } }), /unknown role/);
  });

  it("removes the supervisor and gives the lead a two-minute idle alarm", () => {
    assert.throws(() => seatRole(policy, SUP), PolicyError);
    assert.deepEqual(seatRole(policy, LEAD).idleAlarm, { seats: [E1, E2], idleSeconds: 120, repeatSeconds: 120, pollSeconds: 10 });
  });
  it("validates idle alarm seats, posture and timings", () => {
    assert.throws(() => makeEnv(rolesWith((r) => { assert.ok(r.expert && r.architect); r.expert.idleAlarm = r.architect.idleAlarm; })), /idleAlarm is for operator seats/);
    for (const seats of [["dev-boss"], ["dev-lead"], [], ["dev-expert1", "dev-expert1"]]) {
      assert.throws(() => makeEnv(rolesWith((r) => { assert.ok(r.architect); r.architect.idleAlarm = { seats, idleSeconds: 120, repeatSeconds: 120, pollSeconds: 10 }; })), PolicyError);
    }
    for (const key of ["idleSeconds", "repeatSeconds", "pollSeconds"]) {
      assert.throws(() => makeEnv(rolesWith((r) => { assert.ok(r.architect); r.architect.idleAlarm = { seats: ["dev-expert1"], idleSeconds: 120, repeatSeconds: 120, pollSeconds: 10, [key]: 0 }; })), /must be an integer/);
    }
  });
  it("still validates teamTo", () => {
    assert.throws(() => makeEnv(rolesWith((r) => { assert.ok(r.expert); r.expert.teamTo = ["dev-boss"]; })), /not a seat/);
    assert.throws(() => makeEnv(rolesWith((r) => { assert.ok(r.expert); r.expert.teamTo = []; })), /teamTo is empty/);
  });
});

describe("team", () => {
  it("builds a send towards a teammate with the text after --", () => {
    assert.deepEqual(teamCall(policy, lead, { op: "send", to: E1, text: "--rig x" }).args, ["send", "--json", "--", E1, "--rig x"]);
  });

  it("only addresses other seats of this rig", () => {
    assert.throws(() => teamCall(policy, lead, { op: "send", to: LEAD, text: "hi" }), /not another seat/);
    assert.throws(() => teamCall(policy, lead, { op: "send", to: "dev-impl@other", text: "hi" }), /not another seat/);
  });

  it("keeps ops to the role", () => {
    assert.throws(() => teamCall(policy, expert, { op: "queue_create", to: LEAD, summary: "s", body: "b" }), /may not use team queue_create/);
  });

  it("refuses control characters that could act as keystrokes", () => {
    assert.throws(() => teamCall(policy, lead, { op: "send", to: E1, text: "hi\u001b[A" }), /control characters/);
    assert.throws(() => teamCall(policy, lead, { op: "send", to: E1, text: "hi\r" }), /control characters/);
    assert.doesNotThrow(() => teamCall(policy, lead, { op: "send", to: E1, text: "line 1\nline 2\ttab" }));
  });

  it("passes queue bodies on stdin and values as --flag=value", () => {
    const c = teamCall(policy, lead, { op: "queue_create", to: E2, task: "ask", summary: "-x leading dash", body: "do it", mission: "sample-refactor" });
    assert.deepEqual(c.args, ["queue", "create", `--destination=${E2}`, "--summary=[ask] -x leading dash", "--body-file=-", "--json", "--mission=sample-refactor"]);
    assert.equal(c.stdin, "do it");
    assert.throws(() => teamCall(policy, lead, { op: "queue_create", to: E2, task: "ask", summary: "a\nb", body: "x" }), /one line/);
  });

  it("stamps the work-unit task on lead rows for auto-managed experts", () => {
    const summary = (task: string, s = "Review code"): string | undefined =>
      teamCall(policy, lead, { op: "queue_create", to: E1, task, summary: s, body: "b" }).args.find((a) => a.startsWith("--summary="));
    assert.equal(summary("mission-xmu4.3"), "--summary=[mission-xmu4.3] Review code");
    assert.equal(summary("sample-test-slice"), "--summary=[sample-test-slice] Review code");
    assert.equal(summary("mission-xmu4.3", "[mission-xmu4.3] Review code"), "--summary=[mission-xmu4.3] Review code", "no double prefix");
    assert.throws(() => teamCall(policy, lead, { op: "queue_create", to: E1, summary: "s", body: "b" }), /needs task/);
    for (const bad of ["Mission X", "a]b", "x y", "mission-1."]) {
      assert.throws(() => teamCall(policy, lead, { op: "queue_create", to: E1, task: bad, summary: "s", body: "b" }), /not a task id/, bad);
    }
    assert.throws(() => teamCall(policy, lead, { op: "queue_create", to: E1, task: "ask", summary: "x".repeat(299), body: "b" }), /longer than 300/);
  });

  it("takes the handoff summary from the note's first line when summary is missing", () => {
    const id = "qitem-20261104130000-0123456789abcdef";
    const c = teamCall(policy, expert, { op: "queue_handoff_complete", id, to: LEAD, note: "\n  Parity proof saved: 3/3 routes match  \nsha256 abc" });
    assert.ok(c.args.includes("--summary=Parity proof saved: 3/3 routes match"), c.args.join(" "));
    const long = teamCall(policy, expert, { op: "queue_handoff_complete", id, to: LEAD, note: "\u00e9".repeat(400) });
    const summary = long.args.find((a) => a.startsWith("--summary="))?.slice("--summary=".length) ?? "";
    assert.equal(Buffer.byteLength(summary), 300);
    assert.ok(teamCall(policy, expert, { op: "queue_handoff_complete", id, to: LEAD, summary: "s", note: "n" }).args.includes("--summary=s"));
    assert.throws(() => teamCall(policy, expert, { op: "queue_handoff_complete", id, to: LEAD }), /needs summary or note/);
  });

  it("checks queue update states and closure reasons", () => {
    const id = "qitem-20261104130000-0123456789abcdef";
    assert.throws(() => teamCall(policy, expert, { op: "queue_update", id, state: "done" }), /closureReason/);
    assert.throws(() => teamCall(policy, expert, { op: "queue_update", id }), /note or a state/);
    assert.throws(() => teamCall(policy, expert, { op: "queue_update", id: "--all", note: "x" }), /not a qitem id/);
    assert.deepEqual(teamCall(policy, expert, { op: "queue_update", id, state: "done", closureReason: "no-follow-on", resolution: "ok" }).args, [
      "queue",
      "update",
      id,
      "--state=done",
      "--closure-reason=no-follow-on",
      "--resolution=ok",
      "--json",
    ]);
  });

  it("ignores fields an op does not use, as models fill every field", () => {
    const filled = { to: "", text: "", urgent: false, id: "", summary: "", body: "", state: "in-progress", closureReason: "no-follow-on", all: false, mine: true } as const;
    assert.deepEqual(teamCall(policy, expert, { op: "whoami", ...filled }).args, ["queue", "whoami", "--json"]);
    const id = "qitem-20261104130000-0123456789abcdef";
    assert.deepEqual(teamCall(policy, expert, { op: "queue_update", id, note: "n", state: "unchanged", closureReason: "none" }).args, ["queue", "update", id, "--note=n", "--json"]);
  });

  it("runs the repo-local CLI with the rig env and this seat's identity", async () => {
    const runner = recordingRunner(() => ok('{"ok":true}\n'));
    assert.equal(await runTeam(policy, runner, expert, { op: "whoami" }), '{"ok":true}');
    const req = runner.calls[0];
    assert.ok(req);
    assert.equal(req.command, join(policy.rigRoot, ".runtime", "node", "node_modules", "node", "bin", "node"));
    assert.ok(req.args[0]?.endsWith(join("@openrig", "cli", "dist", "bin-wrapper.js")));
    assert.equal(req.env.HOME, join(env.home, ".devrig", "daemon-home"));
    assert.equal(req.env.OPENRIG_HOME, join(env.home, ".devrig", "openrig-home"));
    assert.equal(req.env.OPENRIG_SESSION_NAME, E1);
    assert.equal(req.env.OPENRIG_URL, URL);
  });

  it("reports a failed CLI call", async () => {
    const runner = recordingRunner(() => ok("", 1, "daemon not running"));
    await assert.rejects(runTeam(policy, runner, expert, { op: "whoami" }), (e: unknown) => e instanceof TeamError && /daemon not running/.test(e.message));
  });

  it("explains a send to a seat that waits on the operator", async () => {
    const busy = '{"ok":false,"reason":"target_needs_input","activity":{"state":"needs_input","reason":"selection_prompt"}}';
    const runner = recordingRunner(() => ok(busy, 1));
    await assert.rejects(runTeam(policy, runner, expert, { op: "send", to: LEAD, text: "done" }), (e: unknown) => e instanceof TeamError && /not delivered.*do not resend/.test(e.message));
    const other = recordingRunner(() => ok(busy, 1));
    await assert.rejects(runTeam(policy, other, expert, { op: "whoami" }), /failed \(exit 1\)/);
  });

  it("only talks to the loopback daemon", () => {
    assert.equal(teamUrl({}), URL);
    assert.throws(() => teamUrl({ OPENRIG_URL: "http://10.0.0.5:7433" }), TeamError);
    assert.throws(() => teamUrl({ OPENRIG_URL: "http://127.0.0.1:7433/x" }), TeamError);
  });
});

describe("mission", () => {
  it("gives writes to the lead only", () => {
    assert.throws(() => missionCalls(expert.role, { op: "note", id: "mission-1tc", text: "x" }), MissionError);
    assert.deepEqual(missionCalls(lead.role, { op: "note", id: "mission-1tc", text: "x" }), [{ args: ["note", "mission-1tc", "--stdin"], stdin: "x" }]);
  });

  it("builds create and close with text on stdin", () => {
    assert.deepEqual(missionCalls(lead.role, { op: "create", id: "mission-1tc", title: "[finding] x", type: "task", text: "body" }), [
      { args: ["create", "--parent=mission-1tc", "--title=[finding] x", "--type=task", "--priority=2", "--stdin", "--silent"], stdin: "body" },
    ]);
    assert.deepEqual(missionCalls(lead.role, { op: "close", id: "mission-1tc.66", text: "batch b-1 verified" }), [
      { args: ["close", "mission-1tc.66", "--reason-file=-"], stdin: "batch b-1 verified" },
    ]);
    assert.throws(() => missionCalls(lead.role, { op: "close", id: "mission-1tc.66" }), /needs text/);
    assert.throws(() => missionCalls(lead.role, { op: "show", id: "--force" }), /not an mx id/);
  });

  it("renders a brief with the latest snapshot and only open children", () => {
    const show = JSON.stringify([{ id: "m-1", title: "T", status: "open", issue_type: "epic", priority: 1, description: "D", notes: "## Context Snapshot A\nold\n## Context Snapshot B\nnew" }]);
    const children = JSON.stringify([
      { id: "m-1.1", status: "open", title: "a" },
      { id: "m-1.2", status: "closed", title: "b" },
    ]);
    const out = renderBrief(show, children, "[]", 10_000);
    assert.match(out, /## Context Snapshot B\nnew/);
    assert.doesNotMatch(out, /old/);
    assert.match(out, /m-1\.1 \[open\] a/);
    assert.doesNotMatch(out, /m-1\.2/);
  });

  it("runs mx against the policy store", async () => {
    const runner = recordingRunner(() => ok("shown\n"));
    assert.equal(await runMission(policy, runner, expert.role, { op: "show", id: "mission-1tc" }), "shown");
    assert.equal(runner.calls[0]?.command, "/fake/mx");
    assert.equal(runner.calls[0]?.env.MX_DB, join(env.home, ".missions", "mx.db"));
  });
});

describe("scope", () => {
  it("pins every call to the project root", () => {
    const c = scopeCall(policy, expert, { op: "slice_ls", mission: "sample-refactor" });
    assert.deepEqual(c.args, ["scope", `--workspace=${policy.scope.root}`, "slice", "ls", "--mission=sample-refactor", "--json"]);
    assert.equal(c.cwd, policy.scope.root);
  });

  it("fills the project's only mission into slice ops that omit it", async () => {
    const missions = join(policy.scope.root, "missions");
    const runner = recordingRunner(() => ok("{}"));
    const call = (p: Parameters<typeof runScope>[3]) => runScope(policy, runner, expert, p);
    try {
      await assert.rejects(call({ op: "slice_show", slice: "01-x" }), /pass mission: the project has no missions/);
      mkdirSync(join(missions, "sample-refactor"), { recursive: true });
      await call({ op: "slice_progress", slice: "02-parser-tests", set: "parity", status: "done" });
      assert.ok(runner.calls[0]?.args.includes("--mission=sample-refactor"), runner.calls[0]?.args.join(" "));
      await call({ op: "slice_ls" });
      await call({ op: "slice_show", slice: "sample-refactor/01-x" });
      for (const c of runner.calls.slice(1)) assert.ok(!c.args.some((a) => a.startsWith("--mission")), c.args.join(" "));
      mkdirSync(join(missions, "other"));
      await assert.rejects(call({ op: "slice_show", slice: "01-x" }), /several missions \(other, sample-refactor\)/);
      await call({ op: "slice_show", slice: "01-x", mission: "other" });
      assert.ok(runner.calls.at(-1)?.args.includes("--mission=other"));
      await assert.rejects(call({ op: "slice_close", slice: "01-x", reason: "stale" }), /may not use scope slice_close/);
    } finally {
      rmSync(missions, { recursive: true, force: true });
    }
  });

  it("plan-locks with scope spec only, and only for the lead", () => {
    const c = scopeCall(policy, lead, { op: "slice_approve_spec", slice: "01-parser", mission: "sample-refactor", lockedArtifacts: ["SPEC.md"] });
    assert.ok(c.args.includes("--scope=spec"));
    assert.ok(c.args.includes("--locked-artifacts=SPEC.md"));
    assert.throws(() => scopeCall(policy, expert, { op: "slice_approve_spec", slice: "01-x" }), ScopeError);
  });

  it("re-approves a SPEC stamp only with a reason", () => {
    const first = scopeCall(policy, lead, { op: "slice_approve_spec", slice: "01-x", mission: "sample-refactor", reApprove: false });
    assert.deepEqual(first.args.slice(2), ["slice", "approve", "01-x", "--mission=sample-refactor", "--scope=spec", "--json"]);
    const again = scopeCall(policy, lead, { op: "slice_approve_spec", slice: "01-x", mission: "sample-refactor", reApprove: true, reApproveReason: "  SPEC amended for the inactive class  " });
    assert.deepEqual(again.args.slice(2), ["slice", "approve", "01-x", "--mission=sample-refactor", "--scope=spec", "--re-approve", "--reason=SPEC amended for the inactive class", "--json"]);
    const mission = scopeCall(policy, lead, { op: "mission_approve_spec", mission: "sample-refactor", reApprove: true, reApproveReason: "intent widened" });
    assert.deepEqual(mission.args.slice(2), ["mission", "approve", "sample-refactor", "--scope=spec", "--re-approve", "--reason=intent widened", "--json"]);
    for (const reApproveReason of [undefined, "", "   "]) {
      assert.throws(() => scopeCall(policy, lead, { op: "slice_approve_spec", slice: "01-x", reApprove: true, reApproveReason }), /reApprove needs reApproveReason/);
    }
    assert.throws(() => scopeCall(policy, lead, { op: "slice_approve_spec", slice: "01-x", reApproveReason: "why" }), /needs reApprove true/);
    assert.throws(() => scopeCall(policy, lead, { op: "slice_approve_spec", slice: "01-x", reApprove: true, reApproveReason: "a\nb" }), /one line/);
    assert.throws(() => scopeCall(policy, expert, { op: "slice_approve_spec", slice: "01-x", reApprove: true, reApproveReason: "why" }), /may not use scope/);
    // Other ops ignore the fields, since models fill every field of the schema.
    assert.ok(!scopeCall(policy, expert, { op: "slice_show", slice: "01-x", reApprove: true }).args.includes("--re-approve"));
  });

  it("passes the mission hint to slice show, so NN-slug resolves", () => {
    assert.deepEqual(scopeCall(policy, expert, { op: "slice_show", slice: "01-probe", mission: "zz-tooltest" }).args.slice(2), [
      "slice",
      "show",
      "01-probe",
      "--mission=zz-tooltest",
      "--json",
    ]);
  });

  it("refuses paths that leave the tree", () => {
    for (const slice of ["../x", "/abs/x", "-x", "a/../b"]) assert.throws(() => scopeCall(policy, expert, { op: "slice_show", slice }), ScopeError);
    assert.throws(() => scopeCall(policy, lead, { op: "slice_approve_spec", slice: "01-x", lockedArtifacts: ["../SPEC.md"] }), ScopeError);
  });

  it("needs exactly one of add and set on a progress rail", () => {
    assert.throws(() => scopeCall(policy, expert, { op: "slice_progress", slice: "01-x" }), /exactly one/);
    const filled = scopeCall(policy, expert, { op: "slice_progress", slice: "01-x", set: "parity", status: "done", section: "Current state" });
    assert.ok(!filled.args.some((a) => a.startsWith("--section")), "section is ignored with set");
    assert.ok(scopeCall(policy, expert, { op: "slice_progress", slice: "01-x", add: "row", section: "Current state" }).args.includes("--section=Current state"));
    assert.deepEqual(scopeCall(policy, expert, { op: "slice_progress", slice: "01-x", set: "parity", status: "done" }).args.slice(2), [
      "slice",
      "progress",
      "01-x",
      "--set=parity",
      "--status=done",
      "--json",
    ]);
  });

  it("closes a slice only with an OpenRig reason, never as completed", () => {
    assert.deepEqual(scopeCall(policy, lead, { op: "slice_close", slice: "01-x", reason: "superseded", note: "merged into 02" }).args.slice(2), [
      "slice",
      "close",
      "01-x",
      "--reason=superseded",
      "--note=merged into 02",
      "--json",
    ]);
    assert.throws(() => scopeCall(policy, lead, { op: "slice_close", slice: "01-x" }), /needs reason.*delivered slice is not closed/);
    assert.throws(() => scopeCall(policy, lead, { op: "slice_close", slice: "01-x", reason: "completed" as never }), /not allowed/);
    assert.throws(() => scopeCall(policy, expert, { op: "slice_close", slice: "01-x", reason: "stale" }), /may not use scope slice_close/);
  });

  it("keeps creation with the lead", () => {
    assert.throws(() => scopeCall(policy, expert, { op: "slice_create", mission: "m", name: "s", intent: "i" }), /may not use scope slice_create/);
    assert.deepEqual(scopeCall(policy, lead, { op: "mission_create", name: "sample-refactor", intent: "Move off nginx" }).args.slice(2), [
      "mission",
      "create",
      "sample-refactor",
      "--intent=Move off nginx",
      "--json",
    ]);
  });
});

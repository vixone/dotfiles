import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { steerDue, steerText } from "../src/autofresh.ts";
import { fsRead } from "../src/fs-tools.ts";
import { capResult, cutText, pruneSpill, SPILL_DIR, type TextPart } from "../src/results.ts";
import { compactQueueList, QUEUE_LIST_ALL, runTeam, type TeamSeat } from "../src/team.ts";
import { seatRole } from "../src/policy.ts";
import { makeEnv, ok, recordingRunner } from "./helpers.ts";

const env = makeEnv();
after(() => env.cleanup());
const { policy } = env;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const numbered = (n: number, width = 60): string => Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(5, "0")} ${"x".repeat(width)}`).join("\n");

describe("result cap policy", () => {
  it("caps all tools at 12 KB by default and keeps fs_read under the cap", () => {
    assert.equal(policy.results.capBytes, 12_288);
    assert.equal(policy.results.leadCapBytes, 32_768);
    assert.deepEqual(policy.results.uncapped, []);
    assert.ok(policy.limits.readBytes <= policy.results.capBytes - 1024);
  });
  it("refuses an unknown uncapped tool and a cap that fs_read would trip", () => {
    assert.throws(() => makeEnv({ results: { capBytes: 12_288, leadCapBytes: 32_768, uncapped: ["nope"] } }), /unknown tool nope/);
    assert.throws(() => makeEnv({ results: { capBytes: 11_800, leadCapBytes: 32_768, uncapped: [] } }), /1024 above limits.readBytes/);
    assert.throws(() => makeEnv({ results: { capBytes: 12_288, leadCapBytes: 8_192, uncapped: [] } }), /leadCapBytes must be at least/);
  });
});

describe("cutText", () => {
  it("leaves text under the cap alone", () => {
    assert.equal(cutText("short", 12_288), undefined);
  });
  it("keeps head and tail on whole lines and names the cut lines", () => {
    const text = numbered(1000);
    const cut = cutText(text, 12_288);
    assert.ok(cut);
    assert.ok(cut.head.endsWith("\n"));
    assert.ok(Buffer.byteLength(cut.head) + Buffer.byteLength(cut.tail) <= 12_288 - 400);
    const lines = text.split("\n");
    assert.equal(cut.totalLines, 1000);
    assert.equal(cut.head, `${lines.slice(0, cut.firstCut - 1).join("\n")}\n`);
    assert.equal(cut.tail, lines.slice(cut.lastCut).join("\n"));
    assert.ok(cut.firstCut > 100 && cut.lastCut < 1000 && cut.firstCut < cut.lastCut);
  });
  it("cuts one long line by bytes", () => {
    const cut = cutText("y".repeat(50_000), 12_288);
    assert.ok(cut);
    assert.equal(cut.totalLines, 1);
    assert.equal(cut.firstCut, 1);
    assert.equal(cut.lastCut, 1);
  });
});

describe("capResult", () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  it("spills the full text and returns head, marker and tail", () => {
    const text = numbered(1000);
    const out = capResult(policy, "expert1", "bash", "toolu_01ABCdef/9", [{ type: "text", text }, image], NOW);
    assert.ok(out);
    assert.deepEqual(out[1], image);
    const shown = (out[0] as TextPart).text;
    assert.ok(Buffer.byteLength(shown) <= 12_288);
    const m = /Full text: (\.spill\/expert1\/20261109T120000Z-bash-[A-Za-z0-9]+\.txt)\. Read on with fs_read offset=(\d+)/.exec(shown);
    assert.ok(m, shown.slice(0, 200));
    const file = join(policy.workspace, m[1] as string);
    assert.equal(readFileSync(file, "utf8"), text);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // The offset in the marker reads the first line the excerpt left out, through fs_read.
    const next = fsRead(policy, { path: m[1] as string, offset: Number(m[2]), limit: 1 });
    assert.match(next, new RegExp(`line ${String(Number(m[2])).padStart(5, "0")} `));
    assert.doesNotMatch(shown, new RegExp(`line ${String(Number(m[2])).padStart(5, "0")} `));
  });
  it("passes small and image-only results, with uncapped exceptions only when configured", () => {
    assert.equal(capResult(policy, "expert1", "bash", "c1", [{ type: "text", text: "ok" }], NOW), undefined);
    assert.equal(capResult(policy, "expert1", "bash", "c3", [image], NOW), undefined);
    const exception = makeEnv({ results: { capBytes: 12_288, leadCapBytes: 32_768, uncapped: ["git"] } });
    try {
      const content = [{ type: "text", text: numbered(1000) }];
      assert.equal(capResult(exception.policy, "expert1", "git", "c2", content, NOW), undefined);
      assert.ok(capResult(policy, "expert1", "git", "c2", content, NOW));
    } finally {
      exception.cleanup();
    }
  });
  it("cuts at the lead cap and points Pi's read at the absolute spill path", () => {
    const text = numbered(1000);
    const lead = { capBytes: policy.results.leadCapBytes, reader: "read" } as const;
    assert.equal(capResult(policy, "lead", "es_read", "c5", [{ type: "text", text: numbered(300) }], NOW, lead), undefined);
    const out = capResult(policy, "lead", "es_read", "toolu_01LEADcap", [{ type: "text", text }], NOW, lead);
    assert.ok(out);
    const shown = (out[0] as TextPart).text;
    assert.ok(Buffer.byteLength(shown) <= 32_768 && Buffer.byteLength(shown) > 12_288);
    const m = /Full text: (\/\S+\.txt)\. Read on with read offset=(\d+) limit=150, or rg it,/.exec(shown);
    assert.ok(m, shown.slice(0, 200));
    assert.ok((m[1] as string).startsWith(join(policy.workspace, SPILL_DIR, "lead")));
    assert.equal(readFileSync(m[1] as string, "utf8"), text);
  });
  it("says so when the spill cannot be written", () => {
    const blocked = makeEnv();
    try {
      writeFileSync(join(blocked.policy.workspace, SPILL_DIR), "not a dir");
      const out = capResult(blocked.policy, "expert1", "bash", "c4", [{ type: "text", text: numbered(1000) }], NOW);
      assert.match((out?.[0] as TextPart).text, /Full text: not saved \(/);
    } finally {
      blocked.cleanup();
    }
  });
  it("prunes spill files older than a day", () => {
    const dir = join(policy.workspace, SPILL_DIR, "expert2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.txt"), "x");
    writeFileSync(join(dir, "new.txt"), "x");
    const old = new Date(NOW.getTime() - 25 * 3600 * 1000);
    utimesSync(join(dir, "old.txt"), old, old);
    utimesSync(join(dir, "new.txt"), NOW, NOW);
    pruneSpill(policy, "expert2", NOW);
    assert.deepEqual(readdirSync(dir), ["new.txt"]);
    assert.doesNotThrow(() => pruneSpill(policy, "nobody", NOW));
  });
});

describe("fs_read byte cut", () => {
  it("ends on a whole line and continues from the next one", () => {
    writeFileSync(join(policy.workspace, "long.txt"), numbered(400));
    const out = fsRead(policy, { path: "long.txt" });
    assert.ok(Buffer.byteLength(out) <= policy.limits.readBytes + 200);
    const m = /\[lines 1-(\d+) of 400; continue with offset=(\d+)\]$/.exec(out);
    assert.ok(m, out.slice(-200));
    const last = Number(m[1]);
    assert.equal(Number(m[2]), last + 1);
    assert.match(out, new RegExp(`line ${String(last).padStart(5, "0")} x+\\n\\[lines`));
  });
  it("flags one line longer than readBytes", () => {
    writeFileSync(join(policy.workspace, "wide.txt"), `${"z".repeat(20_000)}\nsecond`);
    assert.match(fsRead(policy, { path: "wide.txt" }), /\[line 1 cut at 11264 bytes; use fs_search for it\]\n\[lines 1-1 of 2; continue with offset=2\]$/);
  });
});

describe("queue_list rows", () => {
  const row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    qitemId: id,
    tsCreated: "2026-11-09T10:58:12.103Z",
    tsUpdated: "2026-11-09T10:58:14.958Z",
    sourceSession: "dev-lead@devrig",
    destinationSession: "dev-expert2@devrig",
    state: "in-progress",
    summary: ".649 cip: next delete",
    blockedOn: null,
    handedOffTo: null,
    closureReason: null,
    lastNudgeAttempt: "2026-11-09T10:58:12.905Z",
    fieldsElided: ["body"],
    ...over,
  });
  it("prints one line per item with the set extras", () => {
    const out = compactQueueList(JSON.stringify([row("qitem-1"), row("qitem-2", { state: "done", closureReason: "no-follow-on", handedOffTo: "qitem-3" })]), false);
    assert.equal(
      out,
      [
        "2 item(s). id | state | from -> to | updated | summary. queue_show id for the body.",
        "qitem-1 | in-progress | dev-lead@devrig -> dev-expert2@devrig | 11-09 10:58Z | .649 cip: next delete",
        "qitem-2 | done | dev-lead@devrig -> dev-expert2@devrig | 11-09 10:58Z | .649 cip: next delete | handed to: qitem-3 | closure: no-follow-on",
      ].join("\n"),
    );
    assert.match(compactQueueList(JSON.stringify({ items: [row("qitem-1")] }), true), /^1 item\(s\), newest 30 at most\./);
    assert.equal(compactQueueList("[]", false), "no open queue items");
  });
  it("returns output it cannot read unchanged", () => {
    assert.equal(compactQueueList('[{"qitemId":', false), '[{"qitemId":');
    assert.equal(compactQueueList('{"error":"x"}', false), '{"error":"x"}');
  });
  it("asks the CLI for the newest items with all and compacts the reply", async () => {
    const seat: TeamSeat = { name: "dev-expert1@devrig", role: seatRole(policy, "dev-expert1@devrig"), url: "http://127.0.0.1:1" };
    const runner = recordingRunner(() => ok(JSON.stringify([row("qitem-9")])));
    const out = await runTeam(policy, runner, seat, { op: "queue_list", all: true, mine: true });
    assert.deepEqual(runner.calls[0]?.args.slice(-5), ["list", "--json", "--all", `--limit=${QUEUE_LIST_ALL}`, "--mine"]);
    assert.ok((runner.calls[0]?.maxOutputBytes ?? 0) > policy.limits.outputBytes);
    assert.match(out, /^1 item\(s\)/);
  });
});

describe("wrap-up steer", () => {
  const p = policy.context;
  it("steers once past warnTokens and once more past steerAgainTokens", () => {
    assert.equal(steerDue(null, 0, p), 0);
    assert.equal(steerDue(150_000, 0, p), 0);
    assert.equal(steerDue(150_001, 0, p), 1);
    assert.equal(steerDue(180_000, 1, p), 0);
    assert.equal(steerDue(200_001, 1, p), 2);
    assert.equal(steerDue(230_000, 2, p), 0);
    assert.equal(steerDue(210_000, 0, p), 2);
  });
  it("tells the seat to note progress and end its turn", () => {
    assert.match(steerText(1, 152_400, p), /^\[rig\] Your context is at 152k, past the 150k budget\. .*queue_update note.*end your turn/);
    assert.match(steerText(2, 201_000, p), /Pi compacts it at 250k.*Stop now/);
  });
});

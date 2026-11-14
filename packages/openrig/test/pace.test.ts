import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { join } from "node:path";
import { parseQueueList, seatSessionsDir } from "../src/pace.ts";
import { makeEnv } from "./helpers.ts";

const env = makeEnv();
after(() => env.cleanup());
const LEAD = "dev-lead@devrig";
const E1 = "dev-expert1@devrig";

describe("rig queue inputs", () => {
  it("parses compact rows and drops malformed data and unused fields", () => {
    const row = { qitemId: "qitem-1", tsCreated: "t1", tsUpdated: "t2", sourceSession: LEAD, destinationSession: E1, state: "done", summary: "s" };
    assert.deepEqual(parseQueueList(JSON.stringify([{ ...row, body: "not retained" }, { qitemId: "qitem-2" }, "junk"])), [row]);
    assert.deepEqual(parseQueueList('{"items":[]}'), []);
  });

  it("keeps sessions under the private rig state", () => {
    assert.equal(seatSessionsDir(env.policy, E1), join(env.home, ".devrig", "openrig-home", "state", "pi-tui", E1, "sessions"));
  });
});

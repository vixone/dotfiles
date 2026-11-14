import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { swapPlan, wantedOrder } from "../src/herdr-arrange.ts";

describe("herdr-arrange", () => {
  const tiles = [
    { paneId: "p2", label: "dev.lead" },
    { paneId: "p4", label: "dev.expert1" },
    { paneId: "p3", label: "dev.expert2" },
  ];

  it("wants the experts first and the lead last", () => {
    assert.deepEqual(wantedOrder(tiles), ["p4", "p3", "p2"]);
  });

  it("plans the swaps that reach that order", () => {
    const apply = (cur: string[], swaps: [string, string][]): string[] => {
      const at = [...cur];
      for (const [a, b] of swaps) {
        const i = at.indexOf(a);
        const j = at.indexOf(b);
        [at[i], at[j]] = [at[j]!, at[i]!];
      }
      return at;
    };
    for (const cur of [["p2", "p4", "p3"], ["p4", "p3", "p2"], ["p3", "p2", "p4"], ["p4", "p2", "p3"]]) {
      assert.deepEqual(apply(cur, swapPlan(cur, ["p4", "p3", "p2"])), ["p4", "p3", "p2"], cur.join());
    }
    assert.deepEqual(swapPlan(["p4", "p3", "p2"], ["p4", "p3", "p2"]), []);
  });
});

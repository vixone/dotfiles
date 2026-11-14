import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { onFileChange } from "../src/reload.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "devrig-reload-")));
after(() => rmSync(dir, { recursive: true, force: true }));

// mtime is set explicitly: two writes inside one clock tick would otherwise look unchanged.
function put(file: string, text: string, at: number): void {
  writeFileSync(file, text);
  utimesSync(file, at, at);
}

describe("onFileChange", () => {
  it("rebuilds only after the file changes", () => {
    const file = join(dir, "a.json");
    put(file, '{"pods":["es-0"]}', 1000);
    let builds = 0;
    const get = onFileChange(file, () => {
      builds++;
      return JSON.parse(readFileSync(file, "utf8")) as { pods: string[] };
    }, () => assert.fail("no error expected"));
    assert.deepEqual(get().pods, ["es-0"]);
    assert.deepEqual(get().pods, ["es-0"]);
    assert.equal(builds, 1);
    put(file, '{"pods":["es-0","es-3"]}', 2000);
    assert.deepEqual(get().pods, ["es-0", "es-3"]);
    assert.equal(builds, 2);
  });

  it("keeps the last good value when a rebuild throws, and reports once per change", () => {
    const file = join(dir, "b.json");
    put(file, "1", 1000);
    const errors: string[] = [];
    const get = onFileChange(file, () => {
      const n = Number(readFileSync(file, "utf8"));
      if (Number.isNaN(n)) throw new Error("not a number");
      return n;
    }, (e) => errors.push(e.message));
    put(file, "x", 2000);
    assert.equal(get(), 1);
    assert.equal(get(), 1);
    assert.deepEqual(errors, ["not a number"]);
    put(file, "2", 3000);
    assert.equal(get(), 2);
  });

  it("throws at the first build when the policy is invalid", () => {
    const file = join(dir, "c.json");
    put(file, "x", 1000);
    assert.throws(() => onFileChange(file, () => { throw new Error("broken"); }, () => {}), /broken/);
  });
});

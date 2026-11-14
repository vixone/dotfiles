import assert from "node:assert/strict";
import test from "node:test";

import { searchSessions, sessionSearchText } from "../src/search.mjs";

function row({ key, title, updated, text }) {
  return {
    key,
    id: `${key}-id`,
    path: `/tmp/${key}.jsonl`,
    cwd: "/tmp/project",
    title,
    model: "provider/model",
    missions: [],
    updated,
    messages: [{ role: "user", text, timestamp: updated }],
    subagent: false,
    warnings: [],
  };
}

test("fzf searches content beyond a short preview and returns only matched rows", () => {
  const lateNeedle = "late-session-needle";
  const rows = [
    row({
      key: "newer",
      title: "Unrelated title",
      updated: "2026-09-02T00:00:00.000Z",
      text: `${"padding ".repeat(800)}${lateNeedle}`,
    }),
    row({
      key: "older",
      title: "Another session",
      updated: "2026-09-01T00:00:00.000Z",
      text: "No matching content",
    }),
  ];

  assert.ok(sessionSearchText(rows[0]).indexOf(lateNeedle) > 4_000);
  const result = searchSessions(rows, lateNeedle, "recent");
  assert.deepEqual(result.map((match) => match.key), ["newer"]);
  assert.equal(result[0].title, "Unrelated title");
});

test("recent mode preserves activity order for keyword matches", () => {
  const rows = [
    row({ key: "newest", title: "Alpha notes", updated: "2026-09-03T00:00:00.000Z", text: "sharedterm" }),
    row({ key: "middle", title: "Sharedterm exact", updated: "2026-09-02T00:00:00.000Z", text: "other" }),
    row({ key: "oldest", title: "Old notes", updated: "2026-09-01T00:00:00.000Z", text: "sharedterm" }),
  ];

  assert.deepEqual(
    searchSessions(rows, "sharedterm", "recent").map((match) => match.key),
    ["newest", "middle", "oldest"],
  );
});

test("prefix queries anchor to the session title rather than the cache key", () => {
  const rows = [
    row({ key: "not-a-title-prefix", title: "Resume dashboard work", updated: "2026-09-01T00:00:00.000Z", text: "notes" }),
  ];

  assert.deepEqual(
    searchSessions(rows, "^Resume", "recent").map((match) => match.key),
    ["not-a-title-prefix"],
  );
});

test("an empty query returns newest sessions without starting fzf", () => {
  const rows = [
    row({ key: "older", title: "Older", updated: "2026-09-01T00:00:00.000Z", text: "" }),
    row({ key: "newer", title: "Newer", updated: "2026-09-02T00:00:00.000Z", text: "" }),
  ];

  assert.deepEqual(
    searchSessions(rows, "", "relevance", { fzfPath: "/missing/fzf" }).map((match) => match.key),
    ["newer", "older"],
  );
});

test("keywords reject scattered-letter matches but fuzzy mode remains available", () => {
  const rows = [
    row({ key: "literal", title: "IAM roles", updated: "2026-09-03T00:00:00.000Z", text: "sts:TagSession CCOE trust policy update" }),
    row({ key: "noise", title: "Other work", updated: "2026-09-02T00:00:00.000Z", text: "I am reviewing logs, exports and services. Cats Can Order Eggs. " + "a b c d e f g h i j k l m n o p q r s t u v w x y z ".repeat(500) }),
  ];
  for (const query of ["iam roles", "sts:TagSession", "CCOE", "trust policy update"]) {
    assert.deepEqual(searchSessions(rows, query).map((r) => r.key), ["literal"]);
  }
  assert.equal(searchSessions(rows, "iam roles", "recent", { mode: "fuzzy" }).length, 2);
});

test("exact apostrophes and extended operators work in keyword mode", () => {
  const rows = [
    row({ key: "one", title: "Resume Envoy gateway", updated: "2026-09-03T00:00:00.000Z", text: "TagSession trust policy" }),
    row({ key: "two", title: "Kong notes", updated: "2026-09-02T00:00:00.000Z", text: "no tags here" }),
    row({ key: "noise", title: "Other", updated: "2026-09-01T00:00:00.000Z", text: "T a g S e s s i o n" }),
  ];
  assert.deepEqual(searchSessions(rows, "'TagSession").map((r) => r.key), ["one"]);
  assert.deepEqual(searchSessions(rows, "'TagSession", "recent", { mode: "fuzzy" }).map((r) => r.key), ["one"]);
  assert.deepEqual(searchSessions(rows, "^Resume !kong").map((r) => r.key), ["one"]);
  assert.deepEqual(searchSessions(rows, "kong | envoy").map((r) => r.key), ["one", "two"]);
  assert.deepEqual(searchSessions(rows, String.raw`envoy\ gateway`).map((r) => r.key), ["one"]);
});

test("Recent explicitly restores activity order while relevance preserves fzf order", () => {
  const rows = [
    row({ key: "oldest", title: "Needle", updated: "2026-09-01T00:00:00.000Z", text: "needle" }),
    row({ key: "newest", title: "Needle", updated: "2026-09-03T00:00:00.000Z", text: "needle" }),
    row({ key: "middle", title: "Needle", updated: "2026-09-02T00:00:00.000Z", text: "needle" }),
  ];
  const run = () => ({ status: 0, stdout: "middle\noldest\nnewest\n", stderr: "" });
  assert.deepEqual(searchSessions(rows, "needle", "recent", { run }).map((r) => r.key), ["newest", "middle", "oldest"]);
  assert.deepEqual(searchSessions(rows, "needle", "relevance", { run }).map((r) => r.key), ["middle", "oldest", "newest"]);
});

test("hidden cache keys are not searchable", () => {
  const rows = [{ ...row({ key: "hidden-cache-key", title: "Visible", updated: "2026-09-01T00:00:00.000Z", text: "notes" }), id: "public-session-id" }];
  assert.deepEqual(searchSessions(rows, "hidden-cache-key"), []);
});

test("reports a missing fzf executable", () => {
  const rows = [row({ key: "one", title: "One", updated: "2026-09-01T00:00:00.000Z", text: "needle" })];
  assert.throws(
    () => searchSessions(rows, "needle", "recent", { fzfPath: "/missing/fzf" }),
    /could not start fzf/i,
  );
});

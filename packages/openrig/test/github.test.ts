import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGithubParams, runGithub } from "../src/github.ts";
import { makeEnv, ok, recordingRunner } from "./helpers.ts";
import type { CommandRequest } from "../src/runner.ts";

const repo = "devrig-cloud-kubernetes-gitdev-argocd";
const root = `/repos/vixone/${repo}`;
const json = (value: unknown) => ok(JSON.stringify(value));
const endpoint = (request: CommandRequest): string => {
  const value = request.args[request.args.indexOf("--method") + 2];
  assert.ok(value);
  return value;
};
const method = (request: CommandRequest) => request.args[request.args.indexOf("--method") + 1];
const payload = (request: CommandRequest): unknown => JSON.parse(request.stdin ?? "null");

// Writes use a fake runner only. Nothing here creates or edits a real PR.
test("github confines all requests to the configured GitHub host and a personal repo", async () => {
  const env = makeEnv();
  try {
    const runner = recordingRunner(() => json([]));
    await runGithub(env.policy, runner, { op: "list", repo });
    const call = runner.calls[0]!;
    assert.equal(call.command, "/fake/gh");
    assert.deepEqual(call.args.slice(0, 5), ["api", "--hostname", "github.com", "--method", "GET"]);
    assert.equal(endpoint(call), `${root}/pulls?state=open&per_page=100&page=1`);
    for (const bad of ["vixone/repo", "../repo", "https://evil/repo", "repo?x=y", "repo%2fother", "-repo", ".", "..", "repo\nother"]) {
      assert.throws(() => parseGithubParams({ op: "list", repo: bad }), /repo/i);
    }
    for (const extra of [{ hostname: "evil.test" }, { org: "OTHER" }, { endpoint: "/user" }, { method: "DELETE" }, { args: ["--insecure"] }]) {
      assert.throws(() => parseGithubParams({ op: "list", repo, ...extra }), /unexpected|unsupported/i);
    }
    assert.equal(runner.calls.length, 1);
  } finally { env.cleanup(); }
});

test("github rejects every forbidden operation and hidden write field before spawning", async () => {
  const env = makeEnv();
  try {
    const runner = recordingRunner(() => json({}));
    for (const op of ["merge", "approve", "review", "request_changes", "close", "reopen", "workflow_dispatch", "rerun", "cancel", "auth", "api"]) {
      await assert.rejects(runGithub(env.policy, runner, { op, repo, number: 7 }), /unsupported|unexpected/i);
    }
    for (const extra of [{ state: "closed" }, { base: "main" }, { draft: false }, { merge_method: "squash" }]) {
      await assert.rejects(runGithub(env.policy, runner, { op: "edit", repo, number: 7, title: "A title", ...extra }), /unexpected|unsupported/i);
    }
    assert.equal(runner.calls.length, 0);
  } finally { env.cleanup(); }
});

test("github validates numbers, content, arrays and operation-specific fields", () => {
  for (const number of [0, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseGithubParams({ op: "view", repo, number }), /number/i);
  }
  for (const input of [null, [], "view", { op: "view", repo }, { op: "edit", repo, number: 7 },
    { op: "comment", repo, number: 7, body: " " },
    { op: "labels", repo, number: 7, action: "replace", label: "test" },
    { op: "labels", repo, number: 7, action: "remove", label: ".." },
    { op: "assignees", repo, number: 7, action: "add", assignees: [] },
    { op: "reviewers", repo, number: 7, action: "add", reviewers: [], teamReviewers: [] },
    { op: "assignees", repo, number: 7, action: "add", assignees: ["../someone"] },
    { op: "view", repo, number: 7, body: "not a read field" }]) {
    assert.throws(() => parseGithubParams(input));
  }
  assert.deepEqual(parseGithubParams({ op: "edit", repo, number: 7, title: "New title", body: "" }), { op: "edit", repo, number: 7, title: "New title" });
  assert.deepEqual(parseGithubParams({ op: "create", repo, head: "feature/test", base: "main", title: "PR", body: "", draft: false }),
    { op: "create", repo, head: "feature/test", base: "main", title: "PR", draft: false });
});

test("github searches cannot inject qualifiers, Boolean operators or escape the repo", async () => {
  const env = makeEnv();
  try {
    const runner = recordingRunner(() => json({ total_count: 1, incomplete_results: false, items: [{ number: 7 }] }));
    const text = await runGithub(env.policy, runner, { op: "search", repo, query: "sample refactor", state: "open" });
    const url = new URL(endpoint(runner.calls[0]!), "https://github.com");
    assert.equal(url.pathname, "/search/issues");
    assert.equal(url.searchParams.get("q"), `repo:vixone/${repo} is:pr state:open "sample" "refactor"`);
    assert.match(text, /"number": 7/);
    for (const query of ["repo:OTHER/repo", "org:OTHER", "is:issue", "x OR y", "x NOT y", 'x" OR "y', "x\\y", "(x)", "-repo:vixone/repo", " "]) {
      assert.throws(() => parseGithubParams({ op: "search", repo, query }), /query/i);
    }
  } finally { env.cleanup(); }
});

test("github reads PR detail, files, commits, discussion, inline comments and reviews with fixed GET endpoints", async () => {
  const env = makeEnv();
  try {
    const paths = { view: "/pulls/7", files: "/pulls/7/files", commits: "/pulls/7/commits", comments: "/issues/7/comments", review_comments: "/pulls/7/comments", reviews: "/pulls/7/reviews" } as const;
    for (const [op, path] of Object.entries(paths)) {
      const runner = recordingRunner((r) => json(endpoint(r) === `${root}/pulls/7` ? { number: 7, changed_files: 0, commits: 0 } : []));
      await runGithub(env.policy, runner, { op, repo, number: 7 });
      assert.equal(method(runner.calls[0]!), "GET");
      assert.equal(endpoint(runner.calls.at(-1)!), `${root}${path}${op === "view" ? "" : "?per_page=100&page=1"}`);
    }
  } finally { env.cleanup(); }
});

test("github checks resolve the PR head and read both check runs and commit statuses", async () => {
  const env = makeEnv();
  try {
    const sha = "a".repeat(40);
    const runner = recordingRunner((r) => {
      if (endpoint(r) === `${root}/pulls/7`) return json({ head: { sha } });
      if (endpoint(r).includes("/check-runs")) return json({ total_count: 1, check_runs: [{ name: "CI" }] });
      return json([{ context: "build" }]);
    });
    const text = await runGithub(env.policy, runner, { op: "checks", repo, number: 7 });
    assert.deepEqual(runner.calls.map(endpoint), [`${root}/pulls/7`, `${root}/commits/${sha}/check-runs?per_page=100&page=1`, `${root}/commits/${sha}/statuses?per_page=100&page=1`]);
    assert.ok(runner.calls.every((r) => method(r) === "GET"));
    assert.match(text, /CI/);
    assert.match(text, /build/);
    const malicious = recordingRunner(() => json({ head: { sha: "../../actions/runs" } }));
    await assert.rejects(runGithub(env.policy, malicious, { op: "checks", repo, number: 7 }), /sha|head/i);
    assert.equal(malicious.calls.length, 1);
  } finally { env.cleanup(); }
});

test("github create requires an already-pushed same-repo feature or bugfix head and never invokes git", async () => {
  const env = makeEnv();
  try {
    const runner = recordingRunner((r) => json(method(r) === "GET" ? { ref: "refs/heads/feature/test", object: { type: "commit", sha: "a".repeat(40) } } : { number: 8 }));
    await runGithub(env.policy, runner, { op: "create", repo, head: "feature/test", base: "main", title: "PR", body: "Details", draft: false });
    assert.deepEqual(runner.calls.map(method), ["GET", "POST"]);
    assert.equal(endpoint(runner.calls[0]!), `${root}/git/ref/heads/feature%2Ftest`);
    assert.equal(endpoint(runner.calls[1]!), `${root}/pulls`);
    assert.deepEqual(payload(runner.calls[1]!), { head: "feature/test", base: "main", title: "PR", body: "Details", draft: false });
    assert.ok(runner.calls.every((r) => r.args[0] === "api"));
    for (const head of ["main", "master", "fix/test", "other:feature/test", "feature/../main", "feature/a//b", "feature/a.lock", "feature/a?x", "feature/.hidden", "feature/a/", "feature/a."]) {
      assert.throws(() => parseGithubParams({ op: "create", repo, head, base: "main", title: "PR" }), /head|branch/i);
    }
    const missing = recordingRunner(() => ok("", 1, "HTTP 404: Not Found"));
    await assert.rejects(runGithub(env.policy, missing, { op: "create", repo, head: "bugfix/test", base: "main", title: "PR" }), /404/);
    assert.equal(missing.calls.length, 1);
    for (const response of [{}, { ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } }, { ref: "refs/heads/feature/test", object: { type: "tag", sha: "a".repeat(40) } }]) {
      const invalid = recordingRunner(() => json(response));
      await assert.rejects(runGithub(env.policy, invalid, { op: "create", repo, head: "feature/test", base: "main", title: "PR" }), /branch|ref|head|object/i);
      assert.equal(invalid.calls.length, 1);
    }
  } finally { env.cleanup(); }
});

test("github does not submit a write after cancellation during its preflight", async () => {
  const env = makeEnv();
  try {
    const controller = new AbortController();
    const runner = recordingRunner(() => {
      controller.abort();
      return json({ number: 7 });
    });
    await assert.rejects(runGithub(env.policy, runner, { op: "comment", repo, number: 7, body: "Hi" }, controller.signal), /abort/i);
    assert.equal(runner.calls.length, 1);
    const cancelled = recordingRunner(() => json([]));
    await assert.rejects(runGithub(env.policy, cancelled, { op: "list", repo }, controller.signal), /abort/i);
    assert.equal(cancelled.calls.length, 0);
  } finally { env.cleanup(); }
});

test("github allowed edits use fixed methods and JSON stdin, never shell interpolation", async () => {
  const env = makeEnv();
  try {
    const cases = [
      { params: { op: "edit", title: "$(touch /tmp/nope)", body: "New body" }, verb: "PATCH", path: "/pulls/7", body: { title: "$(touch /tmp/nope)", body: "New body" } },
      { params: { op: "comment", body: "A comment\nwith `code`" }, verb: "POST", path: "/issues/7/comments", body: { body: "A comment\nwith `code`" } },
      { params: { op: "labels", action: "add", label: "needs review" }, verb: "POST", path: "/issues/7/labels", body: { labels: ["needs review"] } },
      { params: { op: "labels", action: "remove", label: "needs review" }, verb: "DELETE", path: "/issues/7/labels/needs%20review", body: undefined },
      { params: { op: "assignees", action: "add", assignees: ["reviewer-one"] }, verb: "POST", path: "/issues/7/assignees", body: { assignees: ["reviewer-one"] } },
      { params: { op: "assignees", action: "remove", assignees: ["reviewer-one"] }, verb: "DELETE", path: "/issues/7/assignees", body: { assignees: ["reviewer-one"] } },
      { params: { op: "reviewers", action: "add", reviewers: ["reviewer-one"], teamReviewers: ["cloud-team"] }, verb: "POST", path: "/pulls/7/requested_reviewers", body: { reviewers: ["reviewer-one"], team_reviewers: ["cloud-team"] } },
      { params: { op: "reviewers", action: "remove", reviewers: ["reviewer-one"] }, verb: "DELETE", path: "/pulls/7/requested_reviewers", body: { reviewers: ["reviewer-one"] } },
    ];
    for (const c of cases) {
      // Issue-backed PR operations must verify that the number is a PR, not an ordinary issue.
      const runner = recordingRunner(() => json({ number: 7 }));
      await runGithub(env.policy, runner, { repo, number: 7, ...c.params });
      const call = runner.calls.at(-1)!;
      assert.equal(method(call), c.verb);
      assert.equal(endpoint(call), `${root}${c.path}`);
      assert.deepEqual(call.stdin === undefined ? undefined : payload(call), c.body);
      if (c.body !== undefined) assert.ok(call.args.includes("--input"));
      assert.ok(!call.args.some((arg) => arg.includes("touch") || arg.includes("New body")));
      if (["labels", "assignees", "comment"].includes(c.params.op)) {
        assert.equal(endpoint(runner.calls[0]!), `${root}/pulls/7`);
        assert.equal(method(runner.calls[0]!), "GET");
      }
    }
  } finally { env.cleanup(); }
});

test("github issue-backed reads and writes fail closed if the target is not a PR", async () => {
  const env = makeEnv();
  try {
    for (const params of [{ op: "comment", body: "Hi" }, { op: "labels", action: "remove", label: "test" }, { op: "assignees", action: "add", assignees: ["someone"] }]) {
      const runner = recordingRunner(() => ok("", 1, "HTTP 404"));
      await assert.rejects(runGithub(env.policy, runner, { repo, number: 7, ...params }), /404/);
      assert.equal(runner.calls.length, 1);
    }
  } finally { env.cleanup(); }
});

test("github uses only the credential-owning parent HOME and a clean explicit environment", async () => {
  const env = makeEnv();
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { GH_TOKEN: "injected-token", GITHUB_TOKEN: "injected-token", GH_ENTERPRISE_TOKEN: "injected-token", GITHUB_ENTERPRISE_TOKEN: "injected-token", GH_CONFIG_DIR: "/evil", GH_HOST: "evil", GH_DEBUG: "api", GH_PAGER: "evil", HTTPS_PROXY: "evil", NODE_EXTRA_CA_CERTS: "/evil", SSH_AUTH_SOCK: "/evil", AWS_PROFILE: "evil" });
    const runner = recordingRunner(() => json([]));
    const controller = new AbortController();
    await runGithub(env.policy, runner, { op: "list", repo }, controller.signal);
    const call = runner.calls[0]!;
    assert.equal(call.env.HOME, env.policy.home);
    assert.equal(call.env.PATH, env.policy.childPath);
    assert.equal(call.env.GH_PROMPT_DISABLED, "1");
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR", "GH_HOST", "GH_DEBUG", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "SSH_AUTH_SOCK", "AWS_PROFILE"]) assert.equal(call.env[key], undefined, key);
    assert.equal(call.signal, controller.signal);
    assert.equal(call.cwd, env.policy.home);
    assert.ok(call.timeoutMs > 0);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    env.cleanup();
  }
});

test("github preserves authentication, TLS, timeout, malformed JSON and truncation failures instead of reporting no PRs", async () => {
  const env = makeEnv();
  try {
    const cases = [
      { result: ok("", 1, "HTTP 401: Bad credentials"), error: /401/ },
      { result: ok("", 1, "tls: failed to verify certificate"), error: /tls/ },
      { result: { ...ok("[]"), timedOut: true }, error: /timed out|timeout/i },
      { result: { ...ok("[]"), truncated: true }, error: /truncat/i },
      { result: ok("not JSON"), error: /JSON/i },
      { result: json({ message: "not an array" }), error: /array|response/i },
    ];
    for (const { result, error } of cases) await assert.rejects(runGithub(env.policy, recordingRunner(() => result), { op: "list", repo }), error);
  } finally { env.cleanup(); }
});

test("github consumes every list page and rejects partial later-page failures", async () => {
  const env = makeEnv();
  try {
    const first = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
    const runner = recordingRunner((r) => json(endpoint(r).endsWith("page=1") ? first : [{ number: 101 }]));
    const text = await runGithub(env.policy, runner, { op: "list", repo });
    assert.equal(runner.calls.length, 2);
    assert.match(text, /"number": 101/);
    const failed = recordingRunner((r) => endpoint(r).endsWith("page=1") ? json(first) : ok("", 1, "HTTP 503"));
    await assert.rejects(runGithub(env.policy, failed, { op: "list", repo }), /503/);
    const tooLarge = recordingRunner(() => json(first));
    await assert.rejects(runGithub(env.policy, tooLarge, { op: "list", repo }), /limit|complete/i);
    assert.ok(tooLarge.calls.length <= 100);
  } finally { env.cleanup(); }
});

test("github search and checks pagination use total_count and reject incomplete or capped results", async () => {
  const env = makeEnv();
  try {
    const first = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
    const runner = recordingRunner((r) => json({ total_count: 101, incomplete_results: false, items: endpoint(r).endsWith("page=1") ? first : [{ number: 101 }] }));
    assert.match(await runGithub(env.policy, runner, { op: "search", repo, query: "sample" }), /"number": 101/);
    assert.equal(runner.calls.length, 2);
    for (const response of [
      { total_count: 1001, incomplete_results: false, items: first },
      { total_count: 1, incomplete_results: true, items: [{ number: 1 }] },
      { total_count: 2, incomplete_results: false, items: [{ number: 1 }] },
      { items: [] },
    ]) await assert.rejects(runGithub(env.policy, recordingRunner(() => json(response)), { op: "search", repo, query: "sample" }), /incomplete|limit|count|response/i);
  } finally { env.cleanup(); }
});


test("github refuses REST file and commit caps rather than claiming complete PR evidence", async () => {
  const env = makeEnv();
  try {
    for (const [op, field, cap] of [["files", "changed_files", 3000], ["commits", "commits", 250]] as const) {
      const runner = recordingRunner(() => json({ [field]: cap + 1 }));
      await assert.rejects(runGithub(env.policy, runner, { op, repo, number: 7 }), /limit|cap|complete/i);
      assert.equal(runner.calls.length, 1);
      const short = recordingRunner((r) => endpoint(r) === `${root}/pulls/7` ? json({ [field]: 2 }) : json([{ sha: "one" }]));
      await assert.rejects(runGithub(env.policy, short, { op, repo, number: 7 }), /incomplete|count/i);
    }
  } finally { env.cleanup(); }
});

test("github paginates check runs and commit statuses independently", async () => {
  const env = makeEnv();
  try {
    const sha = "b".repeat(40);
    const hundred = Array.from({ length: 100 }, (_, id) => ({ id }));
    const runner = recordingRunner((r) => {
      const path = endpoint(r);
      if (path === `${root}/pulls/7`) return json({ head: { sha } });
      const items = path.endsWith("page=1") ? hundred : [{ id: 101 }];
      return json(path.includes("check-runs") ? { total_count: 101, check_runs: items } : items);
    });
    const result = await runGithub(env.policy, runner, { op: "checks", repo, number: 7 });
    assert.equal(runner.calls.length, 5);
    assert.equal((result.match(/"id": 101/g) ?? []).length, 2);
  } finally { env.cleanup(); }
});

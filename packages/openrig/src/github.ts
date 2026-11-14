import type { Policy } from "./policy.ts";
import { childEnv, type CommandRunner } from "./runner.ts";

export class GithubError extends Error {
  override name = "GithubError";
}

export const GITHUB_LIMITS = { repo: 100, query: 300, title: 256, body: 60_000, label: 50, people: 30, pages: 100, bytes: 8 * 1024 * 1024 } as const;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PERSON = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

type State = "open" | "closed" | "all";
type Action = "add" | "remove";
type PrRead = "view" | "files" | "commits" | "comments" | "review_comments" | "reviews" | "checks";
type RepoParams = { readonly repo: string };
type PrParams = RepoParams & { readonly number: number };
export type GithubParams =
  | (RepoParams & { readonly op: "list"; readonly state?: State })
  | (RepoParams & { readonly op: "search"; readonly query: string; readonly state?: State })
  | (PrParams & { readonly op: PrRead })
  | (RepoParams & { readonly op: "create"; readonly head: string; readonly base: string; readonly title: string; readonly body?: string; readonly draft?: boolean })
  | (PrParams & { readonly op: "edit"; readonly title?: string; readonly body?: string })
  | (PrParams & { readonly op: "comment"; readonly body: string })
  | (PrParams & { readonly op: "labels"; readonly action: Action; readonly label: string })
  | (PrParams & { readonly op: "assignees"; readonly action: Action; readonly assignees: readonly string[] })
  | (PrParams & { readonly op: "reviewers"; readonly action: Action; readonly reviewers?: readonly string[]; readonly teamReviewers?: readonly string[] });

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GithubError("expected a JSON object");
  return Object.fromEntries(Object.entries(value));
}

function text(p: Record<string, unknown>, key: string, max: number, optional: true): string | undefined;
function text(p: Record<string, unknown>, key: string, max: number, optional?: false): string;
function text(p: Record<string, unknown>, key: string, max: number, optional = false): string | undefined {
  const value = p[key];
  if (optional && (value === undefined || (typeof value === "string" && value.trim() === ""))) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new GithubError(`invalid ${key}: expected nonblank text up to ${max} characters`);
  return value;
}

function keys(p: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(p)) if (!["op", "repo", ...allowed].includes(key)) throw new GithubError(`unexpected field '${key}' for ${String(p.op)}`);
}

function prNumber(p: Record<string, unknown>): number {
  const n = p.number;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new GithubError("number must be a positive safe integer");
  return n;
}

function state(p: Record<string, unknown>): { state?: State } {
  if (p.state === undefined || p.state === "") return {};
  if (p.state !== "open" && p.state !== "closed" && p.state !== "all") throw new GithubError("state must be open, closed or all");
  return { state: p.state };
}

function action(p: Record<string, unknown>): Action {
  if (p.action !== "add" && p.action !== "remove") throw new GithubError("action must be add or remove");
  return p.action;
}

function people(p: Record<string, unknown>, key: string): string[] {
  const values = p[key];
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > GITHUB_LIMITS.people) throw new GithubError(`invalid ${key} array`);
  return values.map((value: unknown) => {
    if (typeof value !== "string" || !PERSON.test(value)) throw new GithubError(`invalid ${key} login or team slug`);
    return value;
  });
}

function branch(p: Record<string, unknown>, key: "head" | "base"): string {
  const value = text(p, key, 200);
  if (!BRANCH.test(value) || value.includes("..") || value.includes("//") || value.split("/").some((s) => s.startsWith(".") || s.endsWith(".lock")) || /[/.]$/.test(value)) throw new GithubError(`invalid ${key} branch`);
  if (key === "head" && !/^(feature|bugfix)\//.test(value)) throw new GithubError("head must be an already-pushed feature/ or bugfix/ branch in the selected repo");
  return value;
}

/** Parse once at the trusted-tool boundary. Unknown operations and unrelated fields fail closed. */
export function parseGithubParams(value: unknown): GithubParams {
  const p = object(value);
  const repo = text(p, "repo", GITHUB_LIMITS.repo);
  if (!REPO.test(repo)) throw new GithubError("repo must be a bare repository name of the configured owner, not a URL or owner/repo");
  switch (p.op) {
    case "list":
      keys(p, ["state"]);
      return { op: p.op, repo, ...state(p) };
    case "search": {
      keys(p, ["query", "state"]);
      const query = text(p, "query", GITHUB_LIMITS.query).trim();
      const terms = query.split(/\s+/);
      if (terms.some((term) => !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(term) || /^(AND|OR|NOT)$/i.test(term))) throw new GithubError("query must contain plain search words, not qualifiers, quotes or Boolean operators");
      return { op: p.op, repo, query, ...state(p) };
    }
    case "view": case "files": case "commits": case "comments": case "review_comments": case "reviews": case "checks":
      keys(p, ["number"]);
      return { op: p.op, repo, number: prNumber(p) };
    case "create": {
      keys(p, ["head", "base", "title", "body", "draft"]);
      if (p.draft !== undefined && typeof p.draft !== "boolean") throw new GithubError("draft must be a boolean");
      const body = text(p, "body", GITHUB_LIMITS.body, true);
      return { op: p.op, repo, head: branch(p, "head"), base: branch(p, "base"), title: text(p, "title", GITHUB_LIMITS.title), ...(body === undefined ? {} : { body }), ...(p.draft === undefined ? {} : { draft: p.draft }) };
    }
    case "edit": {
      keys(p, ["number", "title", "body"]);
      const title = text(p, "title", GITHUB_LIMITS.title, true);
      const body = text(p, "body", GITHUB_LIMITS.body, true);
      if (title === undefined && body === undefined) throw new GithubError("edit needs a nonblank title or body");
      return { op: p.op, repo, number: prNumber(p), ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }) };
    }
    case "comment":
      keys(p, ["number", "body"]);
      return { op: p.op, repo, number: prNumber(p), body: text(p, "body", GITHUB_LIMITS.body) };
    case "labels": {
      keys(p, ["number", "action", "label"]);
      const label = text(p, "label", GITHUB_LIMITS.label);
      if (/[\r\n\x00-\x1f\x7f/\\]/.test(label) || label === "." || label === "..") throw new GithubError("invalid label");
      return { op: p.op, repo, number: prNumber(p), action: action(p), label };
    }
    case "assignees": {
      keys(p, ["number", "action", "assignees"]);
      const assignees = people(p, "assignees");
      if (!assignees.length) throw new GithubError("assignees must not be empty");
      return { op: p.op, repo, number: prNumber(p), action: action(p), assignees };
    }
    case "reviewers": {
      keys(p, ["number", "action", "reviewers", "teamReviewers"]);
      const reviewers = people(p, "reviewers");
      const teamReviewers = people(p, "teamReviewers");
      if (!reviewers.length && !teamReviewers.length) throw new GithubError("reviewers or teamReviewers must not be empty");
      return { op: p.op, repo, number: prNumber(p), action: action(p), ...(reviewers.length ? { reviewers } : {}), ...(teamReviewers.length ? { teamReviewers } : {}) };
    }
    default: throw new GithubError(`unsupported github operation '${String(p.op)}'`);
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** No shell, arbitrary endpoints, credential output, implicit pushes or CI-control requests. */
export async function runGithub(policy: Policy, runner: CommandRunner, input: unknown, signal?: AbortSignal): Promise<string> {
  const p = parseGithubParams(input);
  const { host, owner } = policy.github;
  const root = `/repos/${owner}/${p.repo}`;
  const env = childEnv({ home: policy.home, path: policy.childPath, extra: { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" } });
  let responseBytes = 0;
  const request = async (method: Method, endpoint: string, body?: unknown): Promise<unknown> => {
    signal?.throwIfAborted();
    const result = await runner({
      command: policy.binaries.gh,
      args: ["api", "--hostname", host, "--method", method, endpoint, "--header", "Accept: application/vnd.github+json", ...(body === undefined ? [] : ["--input", "-"])],
      cwd: policy.home, env, stdin: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: policy.limits.commandTimeoutSeconds * 1000, maxOutputBytes: GITHUB_LIMITS.bytes, signal,
    });
    const hint = method === "GET" ? "" : "\nA write may have reached GitHub. Inspect the PR before retrying.";
    if (result.timedOut) throw new GithubError(`github ${method} ${endpoint}: timed out${hint}`);
    if (result.truncated) throw new GithubError(`github ${method} ${endpoint}: response truncated; cannot claim complete results${hint}`);
    if (result.code !== 0) throw new GithubError(`github ${method} ${endpoint}: exit ${result.code}\n${result.stderr || result.stdout}${hint}`);
    responseBytes += Buffer.byteLength(result.stdout);
    if (responseBytes > GITHUB_LIMITS.bytes) throw new GithubError(`github response size limit exceeded; cannot claim complete results${hint}`);
    if (result.stdout.trim() === "" && method === "DELETE") return { deleted: true };
    try { return JSON.parse(result.stdout); }
    catch { throw new GithubError(`github ${method} ${endpoint}: invalid JSON response${hint}`); }
  };
  const get = (endpoint: string) => request("GET", endpoint);

  const pages = async (endpoint: string, field?: "items" | "check_runs", expected?: number): Promise<unknown[]> => {
    const all: unknown[] = [];
    let total = expected;
    const maxPages = field === "items" ? 10 : GITHUB_LIMITS.pages;
    for (let page = 1; page <= maxPages; page++) {
      const data = await get(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      let items: unknown = data;
      if (field) {
        const envelope = object(data);
        const count = envelope.total_count;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new GithubError("invalid total_count in github response");
        if (field === "items" && envelope.incomplete_results !== false) throw new GithubError("github search returned incomplete results");
        if (count > maxPages * 100) throw new GithubError("github result count exceeds pagination limit; narrow the search");
        if (total !== undefined && total !== count) throw new GithubError("github result count changed during pagination; cannot claim complete results");
        total = count;
        items = envelope[field];
      }
      if (!Array.isArray(items) || items.length > 100) throw new GithubError("invalid array in github response");
      all.push(...items);
      if (total !== undefined) {
        if (all.length === total) return all;
        if (all.length > total || items.length < 100) throw new GithubError("incomplete github result count");
      } else if (items.length < 100) return all;
    }
    throw new GithubError("github pagination limit reached; cannot claim complete results");
  };

  let result: unknown;
  switch (p.op) {
    case "list": result = await pages(`${root}/pulls?state=${p.state ?? "open"}`); break;
    case "search": {
      const query = [`repo:${owner}/${p.repo}`, "is:pr", ...(p.state && p.state !== "all" ? [`state:${p.state}`] : []), ...p.query.split(/\s+/).map((term) => `"${term}"`)].join(" ");
      result = await pages(`/search/issues?q=${encodeURIComponent(query)}`, "items"); break;
    }
    case "view": result = await get(`${root}/pulls/${p.number}`); break;
    case "files": case "commits": {
      const pr = object(await get(`${root}/pulls/${p.number}`));
      const count = pr[p.op === "files" ? "changed_files" : "commits"];
      // These REST endpoints cap the returned data even when more pages were requested.
      const cap = p.op === "files" ? 3000 : 250;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new GithubError("invalid PR file or commit count in github response");
      if (count > cap) throw new GithubError(`github ${p.op} count exceeds the REST cap of ${cap}; cannot claim complete results`);
      result = await pages(`${root}/pulls/${p.number}/${p.op}`, undefined, count); break;
    }
    case "review_comments": case "reviews":
      result = await pages(`${root}/pulls/${p.number}/${p.op === "review_comments" ? "comments" : p.op}`); break;
    case "comments":
      await get(`${root}/pulls/${p.number}`);
      result = await pages(`${root}/issues/${p.number}/comments`); break;
    case "checks": {
      const pr = object(await get(`${root}/pulls/${p.number}`));
      const sha = object(pr.head).sha;
      if (typeof sha !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(sha)) throw new GithubError("invalid PR head sha in github response");
      result = { check_runs: await pages(`${root}/commits/${sha}/check-runs`, "check_runs"), statuses: await pages(`${root}/commits/${sha}/statuses`) }; break;
    }
    case "create": {
      const ref = object(await get(`${root}/git/ref/heads/${encodeURIComponent(p.head)}`));
      const target = object(ref.object);
      if (ref.ref !== `refs/heads/${p.head}` || target.type !== "commit" || typeof target.sha !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(target.sha)) throw new GithubError("invalid remote head branch ref; no PR created");
      const { op: _op, repo: _repo, ...body } = p;
      result = await request("POST", `${root}/pulls`, body); break;
    }
    case "edit": {
      const { op: _op, repo: _repo, number: _number, ...body } = p;
      result = await request("PATCH", `${root}/pulls/${p.number}`, body); break;
    }
    case "comment":
      await get(`${root}/pulls/${p.number}`);
      result = await request("POST", `${root}/issues/${p.number}/comments`, { body: p.body }); break;
    case "labels":
      await get(`${root}/pulls/${p.number}`);
      result = p.action === "add" ? await request("POST", `${root}/issues/${p.number}/labels`, { labels: [p.label] }) : await request("DELETE", `${root}/issues/${p.number}/labels/${encodeURIComponent(p.label)}`); break;
    case "assignees":
      await get(`${root}/pulls/${p.number}`);
      result = await request(p.action === "add" ? "POST" : "DELETE", `${root}/issues/${p.number}/assignees`, { assignees: p.assignees }); break;
    case "reviewers":
      result = await request(p.action === "add" ? "POST" : "DELETE", `${root}/pulls/${p.number}/requested_reviewers`, { ...(p.reviewers ? { reviewers: p.reviewers } : {}), ...(p.teamReviewers ? { team_reviewers: p.teamReviewers } : {}) }); break;
    default: {
      const exhaustive: never = p;
      throw new GithubError(`unsupported github request ${String(exhaustive)}`);
    }
  }
  return `github ${p.op} ${owner}/${p.repo}${"number" in p ? `#${p.number}` : ""}\n${JSON.stringify(result, null, 2)}`;
}

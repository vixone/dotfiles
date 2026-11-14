import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Parsed and path-resolved rig safety policy. Every path is absolute. */
export interface Policy {
  readonly rigRoot: string;
  readonly home: string;
  readonly tools: readonly string[];
  readonly workspace: string;
  readonly repos: Readonly<Record<string, string>>;
  /** Extra roots the fs tools may read but nothing writes (no git, no bash writes), e.g. mission artifacts. */
  readonly readOnlyRoots: Readonly<Record<string, string>>;
  readonly controlRoot: string;
  readonly binaries: Readonly<Record<BinaryName, string>>;
  readonly childPath: string;
  readonly deny: DenyRules;
  readonly limits: Limits;
  readonly git: GitPolicy;
  /** The one GitHub host and owner the github tool talks to through `gh api`. */
  readonly github: { readonly host: string; readonly owner: string };
  readonly context: ContextPolicy;
  /** Model-visible tool result size for locked seats (src/results.ts). */
  readonly results: ResultsPolicy;
  readonly bash: BashPolicy;
  readonly rig: RigPolicy;
  readonly roles: Readonly<Record<string, Role>>;
  readonly mission: { readonly db: string };
  /** OpenRig project workspace (project.yaml, missions/, slices) inside the rig workspace. */
  readonly scope: { readonly root: string };
  /** Read-only memory index (src/memory.ts). */
  readonly memory: { readonly server: string; readonly db: string; readonly modelDir: string };
  /** Markdown appended to a locked seat's system prompt every run: the operator's writing rules. */
  readonly prompts: { readonly writingStyle: string };
  /** Operator Pi resources a locked TUI seat with `ui` loads by explicit path. */
  readonly seatUi: SeatUiPolicy;
}

/**
 * The Pi look and skills for a locked TUI seat. Pi still starts with --no-extensions, --no-skills and --no-themes;
 * these load by explicit -e, --skill and --theme paths, so nothing is discovered or installed. The tool allowlist
 * still blocks any tool an extension registers. Every path must lie outside the agent-writable roots.
 */
export interface SeatUiPolicy {
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly themes: readonly string[];
  /** Top-level keys copied from the operator's settings.json (theme, display options). */
  readonly settings: readonly string[];
}

export const TEAM_OPS = ["send", "queue_create", "queue_claim", "queue_update", "queue_handoff_complete", "queue_list", "queue_show", "whoami"] as const;
export type TeamOp = (typeof TEAM_OPS)[number];
export const MISSION_OPS = ["brief", "show", "children", "ready", "note", "comment", "create", "close"] as const;
export type MissionOp = (typeof MISSION_OPS)[number];
export const SCOPE_OPS = [
  "audit",
  "mission_ls",
  "mission_show",
  "mission_create",
  "mission_progress",
  "mission_approve_spec",
  "slice_ls",
  "slice_show",
  "slice_create",
  "slice_progress",
  "slice_close",
  "slice_approve_spec",
] as const;
export type ScopeOp = (typeof SCOPE_OPS)[number];

/**
 * locked: the seat runs Pi with only the rig extension, the role's tools and a sandboxed bash.
 * operator: the seat runs the operator's own Pi (real HOME, their packages, skills and bash) plus the rig tools.
 */
export const POSTURES = ["locked", "operator"] as const;
export type Posture = (typeof POSTURES)[number];
/** Pi's own tools cover these in an operator seat, so an operator role must not list them. */
export const OPERATOR_OWN_TOOLS = ["bash", "fs_list", "fs_read", "fs_search", "fs_write", "fs_edit", "git"] as const;

/** What one kind of seat may do. Every seat runs the same extension; the role narrows its tools and dev. */
export interface Role {
  readonly name: string;
  readonly posture: Posture;
  /** Absolute path of the role prompt under <rigRoot>/context, appended after the shared prompts. */
  readonly prompt: string;
  readonly tools: readonly string[];
  readonly teamOps: readonly TeamOp[];
  readonly missionOps: readonly MissionOp[];
  readonly scopeOps: readonly ScopeOp[];
  /** Locked TUI seats only: load policy.seatUi (operator theme, footer, skills). */
  readonly ui: boolean;
  /** Seats (<pod>-<member>@<rig>) this role may send to or queue for. Absent: every other seat. */
  readonly teamTo?: readonly string[];
  /** Operator seats only: remind this lead to use idle experts during active work. */
  readonly idleAlarm?: IdleAlarmPolicy;
  /** Operator seats only: mark this seat's Herdr tile blocked while it waits on the operator (src/operator-alert.ts). */
  readonly operatorAlert?: OperatorAlertPolicy;
  /** Operator seats only: restart these locked seats with `devrig fresh` before Pi compacts them (src/autofresh.ts). */
  readonly autoFresh?: AutoFreshPolicy;
}

export interface AutoFreshPolicy {
  readonly seats: readonly string[];
  /** A seat must have been settled this long before a restart, so a reply in flight lands first. */
  readonly idleSeconds: number;
  readonly pollSeconds: number;
  /**
   * When set, the lead's team queue_create to one of these seats restarts it blank first if it sits idle at this
   * many tokens or more and the row's task differs from its last one (src/autofresh.ts assignGate).
   */
  readonly assignBlankTokens?: number;
  /** The idle wait, instead of idleSeconds, once the seat got the rig's wrap-up steer. */
  readonly steeredIdleSeconds?: number;
}

export interface IdleAlarmPolicy {
  readonly seats: readonly string[];
  readonly idleSeconds: number;
  readonly repeatSeconds: number;
  readonly pollSeconds: number;
}

export interface OperatorAlertPolicy {
  /** How often the rig checks for an open question. */
  readonly pollSeconds: number;
  /** How often the notification sound repeats while the same wait goes on. */
  readonly repeatSeconds: number;
}

export interface RigPolicy {
  readonly name: string;
  /** OpenRig session name (<pod>-<member>@<rig>) to role name. Seats not listed here refuse to start. */
  readonly seats: Readonly<Record<string, string>>;
  /** Catalog folder rigs/<name> of an overlay rig. Absent for the base rig, which runs on the base files. */
  readonly dir?: string;
}

/** Context budget for the seat. Compaction keeps one session file, which OpenRig tracks for resume. */
export interface BashPolicy {
  /** Home-relative paths bash may neither read nor write. */
  readonly denyHomePaths: readonly string[];
  /** Absolute repo paths (from policy.repos) bash may edit outside .git. */
  readonly writableRepos: readonly string[];
  readonly allowUnixSockets: readonly string[];
  readonly denyMachServices: readonly string[];
}

export interface ContextPolicy {
  /** Past this a locked seat's footer asks the operator for `devrig fresh`. */
  readonly warnTokens: number;
  /** Pi's own threshold compaction, also mid-run, set per model as contextWindow minus this. */
  readonly hardCompactTokens: number;
  /** A seat the lead restarts that is still running past warnTokens is told to wrap up; again past this. */
  readonly steerAgainTokens: number;
  readonly keepRecentTokens: number;
  /** Markdown instructions for the handover a locked seat writes on /fresh. */
  readonly instructionsFile: string;
}

export interface ResultsPolicy {
  /** A locked seat's tool result above this is cut to head and tail; the full text goes to a spill file. */
  readonly capBytes: number;
  /** The same cap for the operator-posture lead, on the rig's own tools only; its Pi tools stay as they are. */
  readonly leadCapBytes: number;
  /** Tools whose results are never cut. */
  readonly uncapped: readonly string[];
}

export type BinaryName = "git" | "gh" | "rg" | "mx";
const BINARY_NAMES: readonly BinaryName[] = ["git", "gh", "rg", "mx"];

export interface DenyRules {
  readonly pathSegments: readonly string[];
  readonly fileNames: readonly string[];
  readonly fileNamePrefixes: readonly string[];
  readonly suffixes: readonly string[];
}

export interface Limits {
  readonly readBytes: number;
  readonly readLines: number;
  readonly outputBytes: number;
  readonly writeBytes: number;
  readonly commandTimeoutSeconds: number;
  readonly listEntries: number;
  readonly searchMatches: number;
}

export interface GitPolicy {
  readonly pushBranchPattern: RegExp;
  /** origin must match this before fetch or push; the only network git transport the rig uses. */
  readonly remotePattern: RegExp;
  readonly subjectMaxLength: number;
  readonly forbiddenCommitPatterns: readonly RegExp[];
}

export class PolicyError extends Error {
  override name = "PolicyError";
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(parent: Json, key: string): Json {
  const value = parent[key];
  if (!isObject(value)) throw new PolicyError(`policy.${key} must be an object`);
  return value;
}

function str(parent: Json, key: string): string {
  const value = parent[key];
  if (typeof value !== "string" || value.length === 0) throw new PolicyError(`policy.${key} must be a non-empty string`);
  return value;
}

function strList(parent: Json, key: string): string[] {
  const value = parent[key];
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string" && v.length > 0)) {
    throw new PolicyError(`policy.${key} must be a list of non-empty strings`);
  }
  return value;
}

function posInt(parent: Json, key: string): number {
  const value = parent[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new PolicyError(`policy.${key} must be a positive integer`);
  }
  return value;
}

/** The account home from the password database, not $HOME, so a private daemon HOME cannot redirect policy paths. */
export function accountHome(): string {
  return userInfo().homedir;
}

export function expandPath(input: string, base: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return isAbsolute(input) ? resolve(input) : resolve(base, input);
}

/** True when child equals parent or lies below it (lexical check on absolute, normalized paths). */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface LoadPolicyOptions {
  readonly rigRoot: string;
  readonly policyFile?: string;
  readonly home?: string;
  /** Test hook: override selected raw fields before validation. */
  readonly overrides?: Json;
  /** Rig to load: the base rig (policy rig.name, the default) or a catalog rig under rigs/<name>. */
  readonly rig?: string;
}

export function isRigName(name: string): boolean {
  return RIG_NAME.test(name);
}

/** `devrig` arguments that select this rig. Always explicit: with several rigs up, a bare command is ambiguous. */
export function rigCliArgs(policy: Policy): string[] {
  return ["--rig", policy.rig.name];
}

/** The rig of an OpenRig session name <pod>-<member>@<rig>, or undefined when the name has no valid suffix. */
export function rigOfSession(sessionName: string | undefined): string | undefined {
  const parts = (sessionName ?? "").split("@");
  if (parts.length !== 2) return undefined;
  const [seat, rig] = parts as [string, string];
  return SEAT_KEY.test(seat) && RIG_NAME.test(rig) ? rig : undefined;
}

/** Keys an overlay may set on a base role. Posture and ui stay with the base role. */
const OVERLAY_ROLE_KEYS = ["prompt", "tools", "teamOps", "missionOps", "scopeOps", "idleAlarm", "operatorAlert", "autoFresh", "teamTo"];

function onlyKeys(raw: Json, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw new PolicyError(`overlay key ${where}${k} is not allowed`);
}

/**
 * The raw policy of catalog rig `name`: the base policy with rigs/<name>/overlay.json applied. The overlay may set
 * the seats, override existing roles (prompt under rigs/<name>/context) and add read-only roots. Control root,
 * workspace, scope root and seat recaps are derived from the rig name, never configured.
 */
function applyOverlay(base: Json, overlay: unknown, name: string, dir: string, rigRoot: string, home: string): Json {
  if (!isObject(overlay)) throw new PolicyError(`rigs/${name}/overlay.json must be an object`);
  onlyKeys(overlay, ["rig", "roles", "readOnlyRoots"], "");
  const baseRig = obj(base, "rig");
  const rigRaw = obj(overlay, "rig");
  onlyKeys(rigRaw, ["name", "seats"], "rig.");
  if (rigRaw.name !== name) throw new PolicyError(`rigs/${name}/overlay.json rig.name must be ${name}`);
  const rig = { name, seats: rigRaw.seats === undefined ? obj(baseRig, "seats") : obj(rigRaw, "seats") };

  const roles: Json = { ...obj(base, "roles") };
  const rolesRaw = overlay.roles === undefined ? {} : obj(overlay, "roles");
  const context = join(dir, "context");
  for (const [role, value] of Object.entries(rolesRaw)) {
    if (!Object.hasOwn(roles, role)) throw new PolicyError(`overlay roles.${role} is not a base role`);
    if (!isObject(value)) throw new PolicyError(`overlay roles.${role} must be an object`);
    onlyKeys(value, OVERLAY_ROLE_KEYS, `roles.${role}.`);
    const patch: Json = { ...value };
    if (value.prompt !== undefined) {
      const prompt = typeof value.prompt === "string" && value.prompt.length > 0 ? resolve(dir, value.prompt) : "";
      if (!isWithin(context, prompt) || !prompt.endsWith(".md")) throw new PolicyError(`overlay roles.${role}.prompt must be a .md file under rigs/${name}/context/`);
      patch.prompt = prompt;
    }
    roles[role] = { ...obj(roles, role), ...patch };
  }

  const baseRoots = base.readOnlyRoots === undefined ? {} : obj(base, "readOnlyRoots");
  const addedRoots = overlay.readOnlyRoots === undefined ? {} : obj(overlay, "readOnlyRoots");
  for (const root of Object.keys(addedRoots)) if (Object.hasOwn(baseRoots, root)) throw new PolicyError(`overlay readOnlyRoots.${root} replaces a base root`);
  const readOnlyRoots: Json = { ...baseRoots, ...addedRoots };
  const baseName = str(baseRig, "name");
  if (typeof baseRoots["seat-recaps"] === "string") {
    const recaps = expandPath(baseRoots["seat-recaps"], rigRoot, home);
    const suffix = join("topology", "rigs", baseName, "seats");
    if (!recaps.endsWith(`${sep}${suffix}`)) throw new PolicyError(`policy.readOnlyRoots.seat-recaps must end in ${suffix}`);
    readOnlyRoots["seat-recaps"] = join(recaps.slice(0, -suffix.length), "topology", "rigs", name, "seats");
  }

  const baseControl = expandPath(str(base, "controlRoot"), rigRoot, home);
  if (basename(baseControl) !== "control") throw new PolicyError("policy.controlRoot must end in /control to derive a rig control root");
  const workspace = join(rigRoot, "workspaces", name);
  return {
    ...base,
    rig,
    roles,
    readOnlyRoots,
    controlRoot: join(dirname(baseControl), "rigs", name, "control"),
    workspace,
    scope: { ...obj(base, "scope"), root: join(workspace, "project") },
  };
}

export function loadPolicy(options: LoadPolicyOptions): Policy {
  const rigRoot = resolve(options.rigRoot);
  const file = options.policyFile ?? join(rigRoot, "policy", "safety.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PolicyError(`cannot read policy ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(raw)) throw new PolicyError("policy root must be an object");
  const merged: Json = { ...raw, ...(options.overrides ?? {}) };
  const home = options.home ?? accountHome();
  const baseName = isObject(merged.rig) && typeof merged.rig.name === "string" ? merged.rig.name : "";
  // The base rig runs on the base files only; a catalog folder under its name would look like it applies.
  if (baseName !== "" && existsSync(join(rigRoot, "rigs", baseName))) throw new PolicyError(`rigs/${baseName} must not exist; the base rig uses policy/, context/ and rig/`);
  const name = options.rig ?? baseName;
  if (name === baseName) return parsePolicy(merged, rigRoot, home);
  if (!RIG_NAME.test(name)) throw new PolicyError(`rig name ${name} is invalid`);
  const dir = join(rigRoot, "rigs", name);
  const overlayFile = join(dir, "overlay.json");
  if (!existsSync(overlayFile)) throw new PolicyError(`unknown rig ${name}: no rigs/${name}/overlay.json`);
  let overlay: unknown;
  try {
    overlay = JSON.parse(readFileSync(overlayFile, "utf8"));
  } catch (error) {
    throw new PolicyError(`cannot read ${overlayFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsePolicy(applyOverlay(merged, overlay, name, dir, rigRoot, home), rigRoot, home, { rigDir: dir });
}

export interface ParsePolicyOptions {
  /** Catalog folder of an overlay rig; its context/ also holds role prompts. */
  readonly rigDir?: string;
}

export function parsePolicy(raw: Json, rigRoot: string, home: string, options: ParsePolicyOptions = {}): Policy {
  if (raw.schemaVersion !== 1) throw new PolicyError("policy.schemaVersion must be 1");
  const at = (p: string): string => expandPath(p, rigRoot, home);

  const tools = strList(raw, "tools");
  if (new Set(tools).size !== tools.length) throw new PolicyError("policy.tools has duplicates");

  const reposRaw = obj(raw, "repos");
  const repos: Record<string, string> = {};
  for (const [name, path] of Object.entries(reposRaw)) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new PolicyError(`policy.repos name ${name} is invalid`);
    if (typeof path !== "string" || path.length === 0) throw new PolicyError(`policy.repos.${name} must be a path`);
    repos[name] = at(path);
  }

  const readOnlyRaw = raw.readOnlyRoots === undefined ? {} : obj(raw, "readOnlyRoots");
  const readOnlyRoots: Record<string, string> = {};
  for (const [name, path] of Object.entries(readOnlyRaw)) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new PolicyError(`policy.readOnlyRoots name ${name} is invalid`);
    if (name === "workspace" || Object.hasOwn(repos, name)) throw new PolicyError(`policy.readOnlyRoots name ${name} is already a root`);
    if (typeof path !== "string" || path.length === 0) throw new PolicyError(`policy.readOnlyRoots.${name} must be a path`);
    readOnlyRoots[name] = at(path);
  }

  const binariesRaw = obj(raw, "binaries");
  const binaries = {} as Record<BinaryName, string>;
  for (const name of BINARY_NAMES) binaries[name] = at(str(binariesRaw, name));

  const denyRaw = obj(raw, "deny");
  const limitsRaw = obj(raw, "limits");
  const gitRaw = obj(raw, "git");
  const contextRaw = obj(raw, "context");
  const bashRaw = obj(raw, "bash");
  const denyHomePaths = strList(bashRaw, "denyHomePaths");
  for (const p of denyHomePaths) if (isAbsolute(p) || p.split("/").some((s) => s === ".." || s === "")) throw new PolicyError(`policy.bash.denyHomePaths entry ${p} must be home-relative`);
  const writableRepos = strList(bashRaw, "writableRepos").map((name) => {
    const path = repos[name];
    if (!path) throw new PolicyError(`policy.bash.writableRepos: unknown repo ${name}`);
    return path;
  });
  const context: ContextPolicy = {
    warnTokens: posInt(contextRaw, "warnTokens"),
    hardCompactTokens: posInt(contextRaw, "hardCompactTokens"),
    steerAgainTokens: posInt(contextRaw, "steerAgainTokens"),
    keepRecentTokens: posInt(contextRaw, "keepRecentTokens"),
    instructionsFile: at(str(contextRaw, "instructionsFile")),
  };
  if (context.keepRecentTokens >= context.warnTokens || context.warnTokens >= context.hardCompactTokens) {
    throw new PolicyError("policy.context needs keepRecentTokens < warnTokens < hardCompactTokens");
  }
  if (context.steerAgainTokens <= context.warnTokens || context.steerAgainTokens >= context.hardCompactTokens) {
    throw new PolicyError("policy.context needs warnTokens < steerAgainTokens < hardCompactTokens");
  }
  const resultsRaw = obj(raw, "results");
  const results: ResultsPolicy = { capBytes: posInt(resultsRaw, "capBytes"), leadCapBytes: posInt(resultsRaw, "leadCapBytes"), uncapped: strList(resultsRaw, "uncapped") };
  for (const t of results.uncapped) if (!tools.includes(t)) throw new PolicyError(`policy.results.uncapped: unknown tool ${t}`);
  const readBytes = posInt(limitsRaw, "readBytes");
  if (results.capBytes < 4096 || readBytes > results.capBytes - 1024) throw new PolicyError("policy.results.capBytes must be at least 4096 and 1024 above limits.readBytes, so fs_read pages instead of spilling");
  if (results.leadCapBytes < results.capBytes) throw new PolicyError("policy.results.leadCapBytes must be at least results.capBytes");
  const rig = parseRig(obj(raw, "rig"), options.rigDir);
  const promptDirs = [join(rigRoot, "context"), ...(options.rigDir === undefined ? [] : [join(options.rigDir, "context")])];
  const roles = parseRoles(obj(raw, "roles"), tools, promptDirs, at, rig);
  for (const [seat, role] of Object.entries(rig.seats)) if (!Object.hasOwn(roles, role)) throw new PolicyError(`policy.rig.seats.${seat}: unknown role ${role}`);
  for (const r of Object.values(roles)) {
    for (const s of r.idleAlarm?.seats ?? []) {
      const role = rig.seats[s];
      if (role === undefined || roles[role]?.posture !== "locked") throw new PolicyError(`policy.roles.${r.name}.idleAlarm: ${s} is not a locked seat`);
    }
    const blankAt = r.autoFresh?.assignBlankTokens;
    if (blankAt !== undefined && blankAt > context.warnTokens) {
      throw new PolicyError(`policy.roles.${r.name}.autoFresh.assignBlankTokens ${blankAt} must not exceed context.warnTokens ${context.warnTokens}; autofresh restarts past that`);
    }
    for (const s of r.autoFresh?.seats ?? []) {
      if (roles[rig.seats[s] as string]?.posture !== "locked") throw new PolicyError(`policy.roles.${r.name}.autoFresh: ${s} is not a locked seat; only locked seats have /fresh`);
    }
  }
  const missionRaw = obj(raw, "mission");

  const policy: Policy = {
    rigRoot,
    home,
    tools,
    workspace: at(str(raw, "workspace")),
    repos,
    readOnlyRoots,
    controlRoot: at(str(raw, "controlRoot")),
    binaries,
    childPath: strList(raw, "childPath").join(":"),
    deny: {
      pathSegments: strList(denyRaw, "pathSegments"),
      fileNames: strList(denyRaw, "fileNames").map((n) => n.toLowerCase()),
      fileNamePrefixes: strList(denyRaw, "fileNamePrefixes").map((n) => n.toLowerCase()),
      suffixes: strList(denyRaw, "suffixes").map((n) => n.toLowerCase()),
    },
    limits: {
      readBytes,
      readLines: posInt(limitsRaw, "readLines"),
      outputBytes: posInt(limitsRaw, "outputBytes"),
      writeBytes: posInt(limitsRaw, "writeBytes"),
      commandTimeoutSeconds: posInt(limitsRaw, "commandTimeoutSeconds"),
      listEntries: posInt(limitsRaw, "listEntries"),
      searchMatches: posInt(limitsRaw, "searchMatches"),
    },
    git: {
      pushBranchPattern: new RegExp(str(gitRaw, "pushBranchPattern")),
      remotePattern: new RegExp(str(gitRaw, "remotePattern")),
      subjectMaxLength: posInt(gitRaw, "subjectMaxLength"),
      forbiddenCommitPatterns: strList(gitRaw, "forbiddenCommitPatterns").map((p) => new RegExp(p, "i")),
    },
    github: parseGithub(obj(raw, "github")),
    context,
    results,
    bash: {
      denyHomePaths,
      writableRepos,
      allowUnixSockets: strList(bashRaw, "allowUnixSockets"),
      denyMachServices: strList(bashRaw, "denyMachServices"),
    },
    rig,
    roles,
    mission: { db: at(str(missionRaw, "db")) },
    scope: { root: at(str(obj(raw, "scope"), "root")) },
    memory: { server: at(str(obj(raw, "memory"), "server")), db: at(str(obj(raw, "memory"), "db")), modelDir: at(str(obj(raw, "memory"), "modelDir")) },
    prompts: { writingStyle: at(str(obj(raw, "prompts"), "writingStyle")) },
    seatUi: parseSeatUi(obj(raw, "seatUi"), at),
  };
  assertLayout(policy);
  return policy;
}

function parseGithub(raw: Json): { host: string; owner: string } {
  const host = str(raw, "host");
  const owner = str(raw, "owner");
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) throw new PolicyError("policy.github.host must be a host name");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) throw new PolicyError("policy.github.owner must be a GitHub user or organization name");
  return { host, owner };
}

const RIG_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SEAT_KEY = /^[a-z0-9][a-z0-9-]{0,60}$/;

function parseRig(raw: Json, dir: string | undefined): RigPolicy {
  const name = str(raw, "name");
  if (!RIG_NAME.test(name)) throw new PolicyError("policy.rig.name is invalid");
  const seatsRaw = obj(raw, "seats");
  const seats: Record<string, string> = {};
  for (const [key, role] of Object.entries(seatsRaw)) {
    if (!SEAT_KEY.test(key)) throw new PolicyError(`policy.rig.seats key ${key} must be <pod>-<member>`);
    if (typeof role !== "string" || role.length === 0) throw new PolicyError(`policy.rig.seats.${key} must name a role`);
    seats[`${key}@${name}`] = role;
  }
  if (Object.keys(seats).length === 0) throw new PolicyError("policy.rig.seats is empty");
  return dir === undefined ? { name, seats } : { name, seats, dir };
}

const SETTINGS_KEY = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
// The rig owns these seat settings; copying the operator's would undo the seat's lockdown.
const RIG_SETTINGS = ["packages", "extensions", "skills", "prompts", "themes", "defaultTools", "compaction", "defaultProjectTrust", "enableSkillCommands", "defaultProvider", "defaultModel", "shellPath"];

function parseSeatUi(raw: Json, at: (p: string) => string): SeatUiPolicy {
  const list = (key: string): string[] => {
    const value = raw[key];
    if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string" && v.length > 0)) throw new PolicyError(`policy.seatUi.${key} must be a list of non-empty strings`);
    return value;
  };
  const settings = list("settings");
  for (const k of settings) {
    if (!SETTINGS_KEY.test(k)) throw new PolicyError(`policy.seatUi.settings key ${k} is invalid`);
    if (RIG_SETTINGS.includes(k)) throw new PolicyError(`policy.seatUi.settings may not copy ${k}; the rig sets it`);
  }
  return { extensions: list("extensions").map(at), skills: list("skills").map(at), themes: list("themes").map(at), settings };
}

function subset<T extends string>(raw: Json, key: string, allowed: readonly T[], where: string): T[] {
  const list = strList(raw, key);
  if (new Set(list).size !== list.length) throw new PolicyError(`${where}.${key} has duplicates`);
  for (const v of list) if (!(allowed as readonly string[]).includes(v)) throw new PolicyError(`${where}.${key}: unknown ${v}`);
  return list as T[];
}

function parseRoles(raw: Json, tools: readonly string[], promptDirs: readonly string[], at: (p: string) => string, rig: RigPolicy): Record<string, Role> {
  const seat = (key: unknown, where: string): string => {
    const full = typeof key === "string" ? `${key}@${rig.name}` : "";
    if (!Object.hasOwn(rig.seats, full)) throw new PolicyError(`${where}: ${String(key)} is not a seat in policy.rig.seats`);
    return full;
  };
  const roles: Record<string, Role> = {};
  for (const name of Object.keys(raw)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new PolicyError(`policy.roles name ${name} is invalid`);
    const r = obj(raw, name);
    const where = `policy.roles.${name}`;
    const prompt = at(str(r, "prompt"));
    if (!promptDirs.some((d) => isWithin(d, prompt)) || !prompt.endsWith(".md")) throw new PolicyError(`${where}.prompt must be a .md file under context/`);
    const roleTools = subset(r, "tools", tools, where);
    const teamOps = subset(r, "teamOps", TEAM_OPS, where);
    const missionOps = subset(r, "missionOps", MISSION_OPS, where);
    const scopeOps = subset(r, "scopeOps", SCOPE_OPS, where);
    if (roleTools.includes("scope") !== scopeOps.length > 0) throw new PolicyError(`${where}: scopeOps must be set exactly when the role has the scope tool`);
    if (roleTools.includes("team") !== teamOps.length > 0) throw new PolicyError(`${where}: teamOps must be set exactly when the role has the team tool`);
    if (roleTools.includes("mission") !== missionOps.length > 0) throw new PolicyError(`${where}: missionOps must be set exactly when the role has the mission tool`);
    const posture = r.posture ?? "locked";
    if (typeof posture !== "string" || !(POSTURES as readonly string[]).includes(posture)) throw new PolicyError(`${where}.posture must be one of ${POSTURES.join(", ")}`);
    if (posture === "operator") {
      const own = roleTools.filter((t) => (OPERATOR_OWN_TOOLS as readonly string[]).includes(t));
      if (own.length > 0) throw new PolicyError(`${where}: an operator seat uses Pi's own ${own.join(", ")}; remove them from tools`);
    }
    const ui = r.ui ?? false;
    if (typeof ui !== "boolean") throw new PolicyError(`${where}.ui must be a boolean`);
    if (ui && posture !== "locked") throw new PolicyError(`${where}.ui is for locked seats; an operator seat already runs the operator's Pi`);
    let teamTo: string[] | undefined;
    if (r.teamTo !== undefined) {
      if (!roleTools.includes("team")) throw new PolicyError(`${where}.teamTo needs the team tool`);
      teamTo = strList(r, "teamTo").map((k) => seat(k, `${where}.teamTo`));
      if (teamTo.length === 0) throw new PolicyError(`${where}.teamTo is empty; drop the team tool instead`);
    }
    let idleAlarm: IdleAlarmPolicy | undefined;
    if (r.idleAlarm !== undefined) {
      const a = obj(r, "idleAlarm");
      if (posture !== "operator") throw new PolicyError(`${where}.idleAlarm is for operator seats`);
      const seats = strList(a, "seats").map((k) => seat(k, `${where}.idleAlarm.seats`));
      if (seats.length === 0 || new Set(seats).size !== seats.length) throw new PolicyError(`${where}.idleAlarm.seats must be distinct seats`);
      const secs = (key: string, min: number, max: number): number => {
        const v = a[key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new PolicyError(`${where}.idleAlarm.${key} must be an integer from ${min} to ${max}`);
        return v;
      };
      idleAlarm = { seats, idleSeconds: secs("idleSeconds", 10, 3600), repeatSeconds: secs("repeatSeconds", 10, 3600), pollSeconds: secs("pollSeconds", 5, 600) };
    }
    let operatorAlert: OperatorAlertPolicy | undefined;
    if (r.operatorAlert !== undefined) {
      const a = obj(r, "operatorAlert");
      if (posture !== "operator") throw new PolicyError(`${where}.operatorAlert is for operator seats`);
      const secs = (key: string, min: number, max: number): number => {
        const v = a[key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new PolicyError(`${where}.operatorAlert.${key} must be an integer from ${min} to ${max}`);
        return v;
      };
      operatorAlert = { pollSeconds: secs("pollSeconds", 5, 600), repeatSeconds: secs("repeatSeconds", 60, 7200) };
    }
    let autoFresh: AutoFreshPolicy | undefined;
    if (r.autoFresh !== undefined) {
      const a = obj(r, "autoFresh");
      if (posture !== "operator") throw new PolicyError(`${where}.autoFresh is for operator seats; it runs devrig`);
      const seats = strList(a, "seats").map((k) => seat(k, `${where}.autoFresh.seats`));
      if (seats.length === 0 || new Set(seats).size !== seats.length) throw new PolicyError(`${where}.autoFresh.seats must be distinct seats`);
      const secs = (key: string, min: number, max: number): number => {
        const v = a[key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new PolicyError(`${where}.autoFresh.${key} must be an integer from ${min} to ${max}`);
        return v;
      };
      const assignBlankTokens = a.assignBlankTokens === undefined ? undefined : secs("assignBlankTokens", 10_000, 1_000_000);
      const idleSeconds = secs("idleSeconds", 10, 3600);
      const steeredIdleSeconds = a.steeredIdleSeconds === undefined ? undefined : secs("steeredIdleSeconds", 3, 3600);
      if (steeredIdleSeconds !== undefined && steeredIdleSeconds > idleSeconds) throw new PolicyError(`${where}.autoFresh.steeredIdleSeconds must not exceed idleSeconds`);
      autoFresh = {
        seats,
        idleSeconds,
        pollSeconds: secs("pollSeconds", 10, 600),
        ...(assignBlankTokens === undefined ? {} : { assignBlankTokens }),
        ...(steeredIdleSeconds === undefined ? {} : { steeredIdleSeconds }),
      };
    }
    roles[name] = { name, posture: posture as Posture, prompt, tools: roleTools, teamOps, missionOps, scopeOps, ui, ...(teamTo ? { teamTo } : {}), ...(idleAlarm ? { idleAlarm } : {}), ...(operatorAlert ? { operatorAlert } : {}), ...(autoFresh ? { autoFresh } : {}) };
  }
  if (Object.keys(roles).length === 0) throw new PolicyError("policy.roles is empty");
  return roles;
}

/** The role of an OpenRig seat, by its exact session name. Unknown seats get nothing. */
export function seatRole(policy: Policy, sessionName: string | undefined): Role {
  const roleName = sessionName !== undefined && Object.hasOwn(policy.rig.seats, sessionName) ? policy.rig.seats[sessionName] : undefined;
  const role = roleName !== undefined && Object.hasOwn(policy.roles, roleName) ? policy.roles[roleName] : undefined;
  if (!role) throw new PolicyError(`seat ${sessionName ?? "<unset>"} has no role in policy.rig.seats`);
  return role;
}

/** Agent-reachable roots must never contain the rig controls, the control store, or the home directory itself. */
function assertLayout(policy: Policy): void {
  const protectedPaths = [
    policy.controlRoot,
    join(policy.rigRoot, "policy"),
    join(policy.rigRoot, "extension"),
    join(policy.rigRoot, "src"),
    join(policy.rigRoot, "bin"),
    join(policy.rigRoot, "shell"),
    join(policy.rigRoot, "rigs"),
    join(policy.home, ".aws"),
    join(policy.home, ".kube"),
    join(policy.home, ".pi"),
  ];
  const roots = [policy.workspace, ...Object.values(policy.repos), ...Object.values(policy.readOnlyRoots)];
  for (const root of roots) {
    if (root === policy.home || isWithin(root, policy.home)) throw new PolicyError(`root ${root} contains the home directory`);
    for (const p of protectedPaths) {
      if (isWithin(root, p)) throw new PolicyError(`root ${root} contains protected path ${p}`);
      if (isWithin(p, root)) throw new PolicyError(`root ${root} lies inside protected path ${p}`);
    }
  }
  // A seat that could write a file it later loads as an extension, skill or theme would run its own code in Pi.
  const ui = [...policy.seatUi.extensions, ...policy.seatUi.skills, ...policy.seatUi.themes];
  for (const p of ui) {
    for (const root of roots) if (isWithin(root, p)) throw new PolicyError(`seatUi path ${p} lies inside agent-reachable root ${root}`);
  }
  if (!isWithin(policy.rigRoot, policy.workspace)) throw new PolicyError("workspace must live inside the rig root");
  if (!isWithin(policy.workspace, policy.scope.root) || policy.scope.root === policy.workspace) throw new PolicyError("scope.root must be a directory inside the workspace");
}

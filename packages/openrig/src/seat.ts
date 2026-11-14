// Seat preparation for the Pi seats OpenRig launches.
//
// Headless seats (runtime: pi): bin/seat/pi runs `node src/seat.ts prepare <openrig args>` and
// execs the real Pi only when this exits 0. It validates the exact argv OpenRig's pi-runner builds.
// TUI seats (community harness pi-tui): bin/seat/openrig-pi-tui-launch runs `prepare-tui`, which
// reads OpenRig's launch variables instead. Both provision the seat agent dir from the operator's
// Pi config (selected provider only) and print the launch plan, one value per line.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountHome, isWithin, loadPolicy, rigOfSession, seatRole, type ContextPolicy, type Policy, type Posture, type SeatUiPolicy } from "./policy.ts";
import { freshDir, primeText, recapPath, takePrime } from "./fresh.ts";
import { removePointer, resumeSession } from "./rebind.ts";

export class SeatError extends Error {
  override name = "SeatError";
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,200}$/;
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,200}$/;
const SESSION_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
/** Pi session ids: letters, digits, '.', '_' and '-', starting and ending with a letter or digit. */
const PI_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;

/** Prompt files every seat appends to the system prompt; bin/pi-exec passes the same list, then the role prompt. */
export const PROMPT_FILES = ["policy/operating-policy.md", "context/coding-reference.md"] as const;

export const DISABLED_BUILTINS = ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"] as const;

export interface SeatArgs {
  readonly sessionDir: string;
  readonly name: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly session?: string;
  readonly fork?: string;
}

/**
 * Accepts only: --mode rpc --session-dir D --name N --no-approve [--model M] [--thinking T] [--session F | --fork R].
 * Anything else, including --approve, is refused.
 */
export function parseSeatArgs(argv: readonly string[]): SeatArgs {
  const seen = new Map<string, string>();
  let noApprove = false;
  const valued = new Set(["--mode", "--session-dir", "--name", "--model", "--thinking", "--session", "--fork"]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    if (flag === "--no-approve") {
      if (noApprove) throw new SeatError("--no-approve given twice");
      noApprove = true;
      continue;
    }
    if (flag === "--approve" || flag === "-a") throw new SeatError("--approve is refused; the seat never trusts project-local files");
    if (!valued.has(flag)) throw new SeatError(`unsupported argument '${flag}'`);
    if (seen.has(flag)) throw new SeatError(`${flag} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) throw new SeatError(`${flag} needs a value`);
    seen.set(flag, value);
    i++;
  }
  if (!noApprove) throw new SeatError("--no-approve is required");
  if (seen.get("--mode") !== "rpc") throw new SeatError("--mode rpc is required");
  const sessionDir = seen.get("--session-dir");
  const name = seen.get("--name");
  if (!sessionDir) throw new SeatError("--session-dir is required");
  if (!name || !SESSION_NAME.test(name)) throw new SeatError("--name is required and must be an OpenRig session name");
  const model = seen.get("--model");
  if (model !== undefined && !MODEL.test(model)) throw new SeatError("--model must be <provider>/<id>[:thinking]");
  const thinking = seen.get("--thinking");
  if (thinking !== undefined && !THINKING.has(thinking)) throw new SeatError(`--thinking ${thinking} is not a Pi thinking level`);
  const session = seen.get("--session");
  const fork = seen.get("--fork");
  if (session !== undefined && fork !== undefined) throw new SeatError("--session and --fork are exclusive");
  return { sessionDir, name, model, thinking, session, fork };
}

export interface SeatLayout {
  readonly agentDir: string;
  readonly sessionsDir: string;
}

/** Checks the env and argv agree with OpenRig's seat layout under the rig's private OPENRIG_HOME. */
export function checkLayout(args: SeatArgs, env: NodeJS.ProcessEnv, home: string): SeatLayout {
  const agentDir = env.PI_CODING_AGENT_DIR;
  const envSessions = env.PI_CODING_AGENT_SESSION_DIR;
  if (!agentDir || !isAbsolute(agentDir)) throw new SeatError("PI_CODING_AGENT_DIR must be set to an absolute path");
  if (resolve(agentDir) !== agentDir || basename(agentDir) !== "agent") throw new SeatError("PI_CODING_AGENT_DIR must be <seat>/agent");
  const seatRoot = dirname(agentDir);
  const stateRoot = join(home, ".devrig", "openrig-home", "state", "pi");
  if (dirname(seatRoot) !== stateRoot) throw new SeatError(`seat must live directly under ${stateRoot}`);
  if (basename(seatRoot) !== args.name) throw new SeatError("seat dir does not match --name");
  const sessionsDir = join(seatRoot, "sessions");
  if (args.sessionDir !== sessionsDir || envSessions !== sessionsDir) throw new SeatError("--session-dir and PI_CODING_AGENT_SESSION_DIR must be <seat>/sessions");
  if (args.session !== undefined) {
    const file = resolve(args.session);
    if (!isWithin(sessionsDir, file) || file === sessionsDir) throw new SeatError("--session must be a file under the seat sessions dir");
  }
  if (args.fork !== undefined) {
    const ref = args.fork;
    const asPath = isAbsolute(ref) ? resolve(ref) : undefined;
    if (asPath ? !isWithin(sessionsDir, asPath) || asPath === sessionsDir : !SESSION_REF.test(ref)) {
      throw new SeatError("--fork must be a session id or a file under the seat sessions dir");
    }
  }
  return { agentDir, sessionsDir };
}

export type TuiConversation = { readonly kind: "new" | "resume"; readonly id: string };

export interface TuiPlan extends SeatLayout {
  readonly name: string;
  readonly conversation: TuiConversation;
  readonly model?: string;
  readonly firstInput?: string;
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * Reads the variables OpenRig passes a names_conversation community harness and maps them onto the seat
 * layout under the rig's private OPENRIG_HOME: state/pi-tui/<session name>/{agent,sessions}.
 */
export function planTuiSeat(env: NodeJS.ProcessEnv, home: string): TuiPlan {
  const openrigHome = join(home, ".devrig", "openrig-home");
  if (env.OPENRIG_HOME !== openrigHome) throw new SeatError(`OPENRIG_HOME must be ${openrigHome}`);
  const name = env.OPENRIG_SESSION_NAME;
  if (!name || !SESSION_NAME.test(name)) throw new SeatError("OPENRIG_SESSION_NAME is missing or not an OpenRig session name");
  const seatRoot = join(openrigHome, "state", "pi-tui", name);

  const fresh = optional(env, "OPENRIG_CONVERSATION");
  const resume = optional(env, "OPENRIG_RESUME_REF");
  if ((fresh === undefined) === (resume === undefined)) throw new SeatError("exactly one of OPENRIG_CONVERSATION and OPENRIG_RESUME_REF must be set");
  const conversation: TuiConversation = fresh !== undefined ? { kind: "new", id: fresh } : { kind: "resume", id: resume as string };
  if (!PI_SESSION_ID.test(conversation.id)) throw new SeatError(`'${conversation.id}' is not a Pi session id`);

  const model = optional(env, "OPENRIG_MODEL");
  if (model !== undefined && !MODEL.test(model)) throw new SeatError("OPENRIG_MODEL must be <provider>/<id>[:thinking]");

  const firstInput = optional(env, "OPENRIG_FIRST_INPUT");
  if (firstInput !== undefined) {
    const inputs = join(openrigHome, "state", "first-input");
    if (!isAbsolute(firstInput) || resolve(firstInput) !== firstInput || !isWithin(inputs, firstInput)) {
      throw new SeatError(`OPENRIG_FIRST_INPUT must be a file under ${inputs}`);
    }
  }
  return { name, agentDir: join(seatRoot, "agent"), sessionsDir: join(seatRoot, "sessions"), conversation, model, firstInput };
}

/** Pi reads a first message starting with @ as a file and one starting with / as a command, even after `--`. */
export function checkFirstInput(file: string): void {
  const st = lstatSync(file);
  if (!st.isFile()) throw new SeatError("OPENRIG_FIRST_INPUT is not a regular file");
  const text = readFileSync(file, "utf8");
  if (text.startsWith("@") || text.startsWith("/")) throw new SeatError("first input must not start with @ or /");
}

/**
 * OpenRig's startup turn tells the seat to run `rig whoami` and `rig queue list` in a shell. Seats have no rig
 * command; the team tool covers both. Rewrites those commands and leaves the rest of the text as it is.
 */
export function adaptFirstInput(text: string): string {
  return text
    .replace(/`?rig whoami --json(?: --all-peers)?`?/g, "the team tool (op whoami)")
    .replace(/`?rig queue list --destination [^\s`]+(?: --[a-z-]+(?: [^\s`-][^\s`]*)?)*`?/g, "the team tool (op queue_list, mine)");
}

/**
 * Writes the first input next to the seat's agent dir, readable by the operator only: the priming line of an
 * `devrig fresh` launch, if any, then OpenRig's adapted startup turn. Undefined when there is neither.
 */
export function writeFirstInput(source: string | undefined, agentDir: string, prime?: string): string | undefined {
  if (source === undefined && prime === undefined) return undefined;
  const parts = [prime, source === undefined ? undefined : adaptFirstInput(readFileSync(source, "utf8"))].filter((p): p is string => p !== undefined);
  const out = join(dirname(agentDir), "first-input.txt");
  writeFileSync(out, parts.join("\n\n"), { mode: 0o600 });
  return out;
}

function firstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
  } finally {
    closeSync(fd);
  }
}

/**
 * The one session file whose header names this id. Pi names files <time>_<id>.jsonl, but the header is what
 * identifies the session. Zero or several matches refuse the resume, so a missing conversation is never replaced.
 */
export function findSessionFile(sessionsDir: string, id: string): string {
  if (!PI_SESSION_ID.test(id)) throw new SeatError(`'${id}' is not a Pi session id`);
  const names = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
  const found = names
    .filter((n) => n.endsWith(`_${id}.jsonl`))
    .map((n) => join(sessionsDir, n))
    .filter((file) => {
      const st = lstatSync(file);
      if (!st.isFile() || st.size === 0) return false;
      try {
        const header: unknown = JSON.parse(firstLine(file));
        return isObject(header) && header.type === "session" && header.id === id;
      } catch {
        return false;
      }
    });
  if (found.length !== 1) throw new SeatError(`expected one Pi session ${id} in ${sessionsDir}, found ${found.length}`);
  return found[0] as string;
}

/**
 * What Pi opens: the session file for a resume, the id for a new conversation. An operator seat follows the
 * rebind pointer its extension writes after /continue (src/rebind.ts); a new conversation drops the old pointer.
 * Locked seats never follow it, so nothing a seat writes picks the conversation it resumes.
 */
export function tuiTarget(plan: TuiPlan, posture: Posture): string {
  const { kind, id } = plan.conversation;
  if (kind === "new") {
    if (posture === "operator") removePointer(plan.sessionsDir);
    return id;
  }
  return findSessionFile(plan.sessionsDir, posture === "operator" ? resumeSession(plan.sessionsDir, id) : id);
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(file: string): Json {
  if (!existsSync(file)) return {};
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isObject(raw)) throw new SeatError(`${file} is not a JSON object`);
  return raw;
}

function writeAtomic(file: string, data: Json): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export interface SeatFiles {
  readonly settings: Json;
  readonly models: Json;
  readonly modelsStore: Json;
  readonly auth: Json;
}

export interface OperatorPi {
  readonly settings: Json;
  readonly models: Json;
  readonly modelsStore: Json;
  readonly auth: Json;
}

type Budget = Pick<ContextPolicy, "hardCompactTokens" | "keepRecentTokens">;

/** Pi's default output headroom; a model whose window cannot fit it above the budget keeps this default. */
const BASE_RESERVE_TOKENS = 16384;

/**
 * Pi compacts when context > contextWindow - reserveTokens. Pin that point at hardCompactTokens
 * for every catalog model whose window leaves at least BASE_RESERVE_TOKENS above it, so a model switch
 * keeps the same budget. Smaller windows keep Pi's default reserve and compact a little earlier.
 */
export function compactionOverrides(catalog: Json, budget: Budget, provider: string): Json {
  const overrides: Json = {};
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  for (const m of models) {
    if (!isObject(m) || typeof m.id !== "string" || typeof m.contextWindow !== "number") continue;
    if (m.contextWindow - budget.hardCompactTokens < BASE_RESERVE_TOKENS) continue;
    overrides[`${provider}/${m.id}`] = { reserveTokens: m.contextWindow - budget.hardCompactTokens };
  }
  return overrides;
}

/**
 * Builds the seat's settings, models, catalog and auth from the operator's Pi config. Pure, for tests.
 * uiSettings names operator settings keys (theme, footer config) to copy; the rig's own keys always win.
 */
export function buildSeatFiles(operator: OperatorPi, seatAuth: Json, tools: readonly string[], budget: Budget, uiSettings: readonly string[] = []): SeatFiles {
  const s = operator.settings;
  const copied: Json = {};
  for (const key of uiSettings) if (Object.hasOwn(s, key)) copied[key] = s[key];
  const provider = s.defaultProvider;
  const model = s.defaultModel;
  if (typeof provider !== "string" || !PROVIDER_NAME.test(provider) || typeof model !== "string" || !MODEL.test(`${provider}/${model}`)) {
    throw new SeatError("configure a default provider and model in your own Pi before launching seats");
  }
  const catalog = isObject(operator.modelsStore[provider]) ? operator.modelsStore[provider] : {};
  const settings: Json = {
    ...copied,
    defaultProvider: provider,
    defaultModel: model,
    defaultThinkingLevel: typeof s.defaultThinkingLevel === "string" ? s.defaultThinkingLevel : "high",
    ...(isObject(s.retry) ? { retry: s.retry } : {}),
    compaction: {
      enabled: true,
      reserveTokens: BASE_RESERVE_TOKENS,
      keepRecentTokens: budget.keepRecentTokens,
      modelOverrides: compactionOverrides(catalog, budget, provider),
    },
    defaultTools: [...tools],
    extensions: [...DISABLED_BUILTINS],
    packages: [],
    skills: [],
    prompts: [],
    themes: [],
    enableSkillCommands: false,
    defaultProjectTrust: "never",
    quietStartup: true,
    enableInstallTelemetry: false,
  };

  const providers = isObject(operator.models.providers) ? operator.models.providers : {};
  const selectedModels = providers[provider];
  const models: Json = { providers: isObject(selectedModels) ? { [provider]: selectedModels } : {} };

  const opCred = operator.auth[provider];
  if (!isObject(opCred)) throw new SeatError(`operator auth.json has no ${provider} login; run /login in your own Pi first`);
  const seatCred = seatAuth[provider];
  // Keep a token the seat refreshed itself when it is newer and from the same login.
  const keepSeat =
    isObject(seatCred) &&
    typeof opCred.refresh === "string" &&
    seatCred.refresh === opCred.refresh &&
    typeof seatCred.expires === "number" &&
    typeof opCred.expires === "number" &&
    seatCred.expires > opCred.expires;
  const auth: Json = { [provider]: keepSeat ? seatCred : opCred };
  return { settings, models, modelsStore: isObject(operator.modelsStore[provider]) ? { [provider]: catalog } : {}, auth };
}

export function provisionSeat(layout: SeatLayout, home: string, tools: readonly string[], budget: Budget, uiSettings: readonly string[] = []): void {
  const opDir = join(home, ".pi", "agent");
  if (resolve(layout.agentDir) === resolve(opDir)) throw new SeatError("refusing to provision into the operator's own Pi dir");
  mkdirSync(layout.agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(layout.sessionsDir, { recursive: true, mode: 0o700 });
  const files = buildSeatFiles(
    {
      settings: readJson(join(opDir, "settings.json")),
      models: readJson(join(opDir, "models.json")),
      modelsStore: readJson(join(opDir, "models-store.json")),
      auth: readJson(join(opDir, "auth.json")),
    },
    readJson(join(layout.agentDir, "auth.json")),
    tools,
    budget,
    uiSettings,
  );
  writeAtomic(join(layout.agentDir, "settings.json"), files.settings);
  writeAtomic(join(layout.agentDir, "models.json"), files.models);
  writeAtomic(join(layout.agentDir, "models-store.json"), files.modelsStore);
  writeAtomic(join(layout.agentDir, "auth.json"), files.auth);
  // A UI seat takes the operator's key bindings too, so the same keys work in every pane.
  const keys = join(opDir, "keybindings.json");
  if (uiSettings.length > 0 && existsSync(keys)) writeAtomic(join(layout.agentDir, "keybindings.json"), readJson(keys));
}

/** Pi flags that load the seat UI by explicit path, one argv entry per element. Pure. */
export function seatUiArgs(ui: SeatUiPolicy): string[] {
  return [...ui.extensions.flatMap((p) => ["-e", p]), ...ui.skills.flatMap((p) => ["--skill", p]), ...ui.themes.flatMap((p) => ["--theme", p])];
}

/**
 * Writes the UI flags for the TUI launcher, one per line, into the seat agent dir. A missing path stops the
 * launch: Pi would only warn, and a seat without its guards extension must not start as if it had one.
 */
export function writeUiArgs(agentDir: string, ui: SeatUiPolicy): string {
  for (const p of [...ui.extensions, ...ui.skills, ...ui.themes]) {
    if (!isAbsolute(p) || /[\n\r\0]/.test(p)) throw new SeatError(`seat UI path ${JSON.stringify(p)} is not a clean absolute path`);
    if (!existsSync(p)) throw new SeatError(`seat UI path missing: ${p}`);
  }
  const file = join(agentDir, "ui-args");
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, seatUiArgs(ui).map((a) => `${a}\n`).join(""), { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function checkPromptFiles(rigRoot: string): void {
  for (const rel of PROMPT_FILES) {
    const file = join(rigRoot, rel);
    // Pi treats a missing path as literal prompt text, so a missing file must stop the launch.
    if (!existsSync(file) || !lstatSync(file).isFile()) throw new SeatError(`prompt file missing: ${rel}`);
  }
}

/**
 * One value per output line, then `end`. The shell launchers read them with `read -r` and check the `end` line:
 * command substitution strips trailing newlines, so without it an empty last value would be lost.
 */
export function planLines(values: readonly string[]): string {
  for (const v of values) if (/[\n\r\0]/.test(v)) throw new SeatError("launch value contains a line break");
  return `${[...values, "end"].join("\n")}\n`;
}

function main(argv: readonly string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "version" && rest.length === 0) {
    process.stdout.write(`${join(accountHome(), ".pi", "agent", "bin", "pi")}\n`);
    return 0;
  }
  if (cmd !== "prepare" && !(cmd === "prepare-tui" && rest.length === 0)) {
    process.stderr.write("usage: seat.ts prepare <openrig pi args> | seat.ts prepare-tui | seat.ts version\n");
    return 2;
  }
  const rigRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const home = accountHome();
  try {
    // The seat's @<rig> suffix picks the rig's policy, so the name is resolved before the policy loads.
    const policyFor = (name: string): Policy => {
      const rig = rigOfSession(name);
      return loadPolicy({ rigRoot, home, ...(rig ? { rig } : {}) });
    };
    const pi = join(home, ".pi", "agent", "bin", "pi");
    // Returns the shared head of the launch plan: seat name, the role's tools, the role prompt and the real Pi.
    const prepare = (policy: Policy, name: string, layout: SeatLayout, posture: Posture, tui = false): string[] => {
      const role = seatRole(policy, name);
      if (role.posture !== posture) throw new SeatError(`seat ${name} is ${role.posture}, this launch path is ${posture}`);
      checkPromptFiles(rigRoot);
      if (!existsSync(role.prompt) || !lstatSync(role.prompt).isFile()) throw new SeatError(`role prompt missing: ${role.prompt}`);
      if (!existsSync(policy.context.instructionsFile)) throw new SeatError("handover instructions file missing");
      // An operator seat runs the operator's own Pi dir; only its conversations live in the seat.
      if (posture === "operator") mkdirSync(layout.sessionsDir, { recursive: true, mode: 0o700 });
      else provisionSeat(layout, home, role.tools, policy.context, tui && role.ui ? policy.seatUi.settings : []);
      if (!existsSync(pi)) throw new SeatError(`real pi launcher missing: ${pi}`);
      return [name, role.tools.join(","), role.prompt, pi];
    };
    if (cmd === "prepare-tui") {
      const plan = planTuiSeat(process.env, home);
      const policy = policyFor(plan.name);
      const posture = seatRole(policy, plan.name).posture;
      const head = prepare(policy, plan.name, plan, posture, true);
      const uiArgs = posture === "locked" && seatRole(policy, plan.name).ui ? writeUiArgs(plan.agentDir, policy.seatUi) : "";
      if (plan.firstInput !== undefined) checkFirstInput(plan.firstInput);
      // Only a new conversation consumes the marker `devrig fresh` leaves; a resume keeps its own history.
      const mode = plan.conversation.kind === "new" && posture === "locked" ? takePrime(freshDir(plan.sessionsDir)) : undefined;
      const prime = mode === undefined ? undefined : primeText(mode, plan.name, recapPath(join(home, ".devrig", "openrig-home"), plan.name));
      const firstInput = writeFirstInput(plan.firstInput, plan.agentDir, prime);
      if (firstInput !== undefined) checkFirstInput(firstInput);
      const target = tuiTarget(plan, posture);
      process.stdout.write(
        planLines([...head, plan.agentDir, plan.sessionsDir, plan.model ?? "", plan.conversation.kind, target, firstInput ?? "", posture, home, uiArgs]),
      );
      return 0;
    }
    const args = parseSeatArgs(rest);
    // Headless seats are always locked; an operator seat needs its own terminal.
    process.stdout.write(planLines(prepare(policyFor(args.name), args.name, checkLayout(args, process.env, home), "locked")));
    return 0;
  } catch (error) {
    process.stderr.write(`[devrig-seat] refused: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

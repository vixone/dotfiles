// Where one rig keeps its spec, control store, workspace and project history. `devrig` evals the shell
// assignments this prints, so the CLI and the seats derive the same paths from the same policy.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountHome, isRigName, loadPolicy, PolicyError, type Policy } from "./policy.ts";

export interface RigLayout {
  readonly name: string;
  /** Spec template in the repo: rig/rig.template.yaml for the base rig, rigs/<name>/rig.yaml for a catalog rig. */
  readonly template: string;
  /** Rendered spec under ~/.devrig. */
  readonly spec: string;
  readonly control: string;
  readonly workspace: string;
  /** OpenRig project tree (scope.root). */
  readonly project: string;
  /** Git dir that versions the project tree. */
  readonly projectGit: string;
  /** OpenRig RECAP folder of the rig's seats. */
  readonly recaps: string;
}

/** Pure: everything comes from the loaded policy. */
export function rigLayout(policy: Policy): RigLayout {
  const state = join(policy.home, ".devrig");
  const own = policy.rig.dir === undefined ? state : join(state, "rigs", policy.rig.name);
  const recaps = policy.readOnlyRoots["seat-recaps"];
  if (recaps === undefined) throw new PolicyError("policy.readOnlyRoots.seat-recaps is missing");
  return {
    name: policy.rig.name,
    template: policy.rig.dir === undefined ? join(policy.rigRoot, "rig", "rig.template.yaml") : join(policy.rig.dir, "rig.yaml"),
    spec: join(own, "rig.yaml"),
    control: policy.controlRoot,
    workspace: policy.workspace,
    project: policy.scope.root,
    projectGit: join(own, "project.git"),
    recaps,
  };
}

/** One `rig_<key>='value'` line per field. Refuses a value with a single quote rather than escape it. */
export function rigEnvLines(layout: RigLayout): string[] {
  const vars: Record<string, string> = {
    rig_name: layout.name,
    rig_template: layout.template,
    rig_spec: layout.spec,
    rig_control: layout.control,
    rig_workspace: layout.workspace,
    rig_project: layout.project,
    rig_project_git: layout.projectGit,
    rig_recaps: layout.recaps,
  };
  return Object.entries(vars).map(([k, v]) => {
    if (v.includes("'") || v.includes("\n")) throw new PolicyError(`${k} must not contain a quote or newline: ${v}`);
    return `${k}='${v}'`;
  });
}

export interface SpecPaths {
  readonly root: string;
  readonly state: string;
  readonly workspace: string;
}

/** The rig spec from its template: @@ROOT@@, @@STATE@@ and @@WORKSPACE@@ replaced. Its top-level name must be the rig's. */
export function renderSpec(template: string, name: string, p: SpecPaths): string {
  for (const v of [p.root, p.state, p.workspace]) if (/["\n\r\\]/.test(v)) throw new PolicyError(`path ${v} must not contain a quote, backslash or line break`);
  const text = template.split("@@ROOT@@").join(p.root).split("@@STATE@@").join(p.state).split("@@WORKSPACE@@").join(p.workspace);
  const names = [...text.matchAll(/^name:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  if (names.length !== 1 || names[0] !== name) throw new PolicyError(`the spec template must have exactly one top-level "name: ${name}"`);
  if (text.includes("@@")) throw new PolicyError("the spec template has an unknown @@ placeholder");
  return text;
}

export function renderSpecFile(policy: Policy): string {
  const l = rigLayout(policy);
  const text = renderSpec(readFileSync(l.template, "utf8"), l.name, { root: policy.rigRoot, state: join(policy.home, ".devrig"), workspace: l.workspace });
  mkdirSync(dirname(l.spec), { recursive: true, mode: 0o700 });
  writeFileSync(`${l.spec}.tmp`, text);
  renameSync(`${l.spec}.tmp`, l.spec);
  return l.spec;
}

/**
 * Scaffolds rigs/<name> from the base rig or another catalog rig: overlay.json with the same seats and role
 * overrides, rig.yaml with the new name and the rig's own workspace as seat cwd, and the context prompts. The new
 * rig must then load, or the folder is removed again.
 */
export function scaffoldRig(base: Policy, name: string, like: Policy, home: string): string {
  if (base.rig.dir !== undefined) throw new PolicyError("scaffoldRig needs the base policy");
  if (!isRigName(name)) throw new PolicyError(`rig name ${name} is invalid`);
  const dir = join(base.rigRoot, "rigs", name);
  if (name === base.rig.name || existsSync(dir)) throw new PolicyError(`rig ${name} already exists`);
  mkdirSync(join(base.rigRoot, "rigs"), { recursive: true });
  try {
    if (like.rig.dir === undefined) {
      const seats = Object.fromEntries(Object.entries(like.rig.seats).map(([k, v]) => [k.slice(0, k.lastIndexOf("@")), v]));
      mkdirSync(join(dir, "context"), { recursive: true });
      writeFileSync(join(dir, "overlay.json"), `${JSON.stringify({ rig: { name, seats }, roles: {} }, null, 2)}\n`);
      const template = readFileSync(join(base.rigRoot, "rig", "rig.template.yaml"), "utf8")
        .replace(/^# Rendered by .*\n# .*\n/, `# Rendered by \`devrig --rig ${name} provision\` into ~/.devrig/rigs/${name}/rig.yaml. Do not launch this template directly.\n`)
        .replace(/^name: .*$/m, `name: ${name}`)
        .split('"@@ROOT@@/workspace"').join('"@@WORKSPACE@@"');
      writeFileSync(join(dir, "rig.yaml"), template);
    } else {
      cpSync(like.rig.dir, dir, { recursive: true });
      const overlay = JSON.parse(readFileSync(join(dir, "overlay.json"), "utf8")) as { rig: { name: string } };
      overlay.rig.name = name;
      writeFileSync(join(dir, "overlay.json"), `${JSON.stringify(overlay, null, 2)}\n`);
      writeFileSync(join(dir, "rig.yaml"), readFileSync(join(dir, "rig.yaml"), "utf8").replace(/^name: .*$/m, `name: ${name}`).split(`rigs/${like.rig.name}/`).join(`rigs/${name}/`));
    }
    const policy = loadPolicy({ rigRoot: base.rigRoot, home, rig: name });
    renderSpec(readFileSync(join(dir, "rig.yaml"), "utf8"), name, { root: base.rigRoot, state: join(home, ".devrig"), workspace: policy.workspace });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

const USAGE = "usage: rig-env.ts env [rig] | render [rig] | new <name> [like]";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, rig, like] = process.argv.slice(2);
  try {
    const rigRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const home = accountHome();
    const load = (r: string | undefined): Policy => loadPolicy({ rigRoot, home, ...(r ? { rig: r } : {}) });
    if (cmd === "env") process.stdout.write(`${rigEnvLines(rigLayout(load(rig))).join("\n")}\n`);
    else if (cmd === "render") process.stdout.write(`${renderSpecFile(load(rig))}\n`);
    else if (cmd === "new" && rig) process.stdout.write(`${scaffoldRig(load(undefined), rig, load(like), home)}\n`);
    else {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`rig-env: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

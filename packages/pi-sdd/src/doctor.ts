import { access, constants, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { skillNames } from './catalog.ts';
import { loadModelOverrides, loadRoleConfig, resolveModel, workerRoles } from './models.ts';
import { subagentIncompatibility } from './worker-tool.ts';

export interface DoctorTool {
  name: string;
  parameters: unknown;
  sourceInfo: { path: string };
}

export interface DoctorInput {
  version: string;
  platform: string;
  tools: readonly DoctorTool[];
  commandCollision: string | null;
  agentDir: string;
  beadsDir: string;
  pathEnv: string;
  skillsRoot: string;
  rolesPath: string;
  overridesPath: string;
  availableModels: readonly string[];
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'unverified' | 'warn' | 'fail';
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function findExecutable(name: string, pathEnv: string): Promise<string | null> {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (!await isFile(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function roleChecks(input: DoctorInput): Promise<DoctorCheck> {
  let config;
  let overrides;
  try {
    [config, overrides] = await Promise.all([loadRoleConfig(input.rolesPath), loadModelOverrides(input.overridesPath)]);
  } catch (error) {
    return { name: 'roles', status: 'fail', detail: failure(error) };
  }
  const lines: string[] = [];
  let failed = false;
  for (const role of workerRoles) {
    try {
      const model = resolveModel({ role, roles: config.roles, overrides, available: input.availableModels, escalation: 'doctor check' });
      const source = overrides[role] === undefined ? '' : ' (override)';
      lines.push(`${role} -> ${model}${source}${role === 'hardest' ? ' (explicit escalation only)' : ''}`);
    } catch (error) {
      failed = true;
      lines.push(`${role}: ${failure(error)}`);
    }
  }
  return { name: 'roles', status: failed ? 'fail' : 'ok', detail: lines.join('; ') };
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: 'host',
    status: input.platform !== 'darwin' ? 'fail' : input.version === '1.0.4' ? 'ok' : 'warn',
    detail: `pi ${input.version} on ${input.platform}; pi-subagent workers require macOS and were verified against pi 1.0.4`,
  });
  checks.push(input.commandCollision
    ? { name: 'command', status: 'fail', detail: input.commandCollision }
    : { name: 'command', status: 'ok', detail: '/sdd registration is unique' });

  const subagent = input.tools.find(tool => tool.name === 'subagent');
  if (!subagent) {
    checks.push({ name: 'subagent', status: 'fail', detail: 'SUBAGENT_UNAVAILABLE: no subagent tool is registered in this session' });
  } else {
    const problem = subagentIncompatibility(subagent.parameters);
    checks.push(problem
      ? { name: 'subagent', status: 'fail', detail: `${problem} (registered by ${subagent.sourceInfo.path})` }
      : { name: 'subagent', status: 'ok', detail: `registered by ${subagent.sourceInfo.path} with start/status/wait/cancel/list` });
  }

  const guardPath = join(input.agentDir, 'extensions', 'guards', 'index.ts');
  checks.push(await isFile(guardPath)
    ? {
      name: 'guards',
      status: 'unverified',
      detail: `${guardPath} present. pi-subagent workers load it and fail the run when it is missing or fails to load. This session cannot prove its tool_call hooks are loaded here: they register no tool or command the host lists`,
    }
    : { name: 'guards', status: 'fail', detail: `${guardPath} missing; every worker run will fail` });

  const bd = await findExecutable('bd', input.pathEnv);
  const beads = await isDirectory(input.beadsDir);
  checks.push({
    name: 'bd',
    status: bd && beads ? 'ok' : 'fail',
    detail: `${bd ? `${bd} found on PATH (not executed)` : 'bd not found on PATH'}; global directory ${input.beadsDir} ${beads ? 'present' : 'missing'}`,
  });

  checks.push(await roleChecks(input));

  const missing: string[] = [];
  for (const name of skillNames) if (!await isFile(join(input.skillsRoot, name, 'SKILL.md'))) missing.push(name);
  checks.push({
    name: 'skills',
    status: missing.length ? 'fail' : 'ok',
    detail: `${skillNames.length - missing.length}/${skillNames.length} SKILL.md files present${missing.length ? `; missing ${missing.join(', ')}` : ''}`,
  });

  checks.push({
    name: 'worker limits',
    status: 'ok',
    detail: 'workers run with low or off thinking and only read, write, edit and bash; no web, MCP, skills or nested agents. Research needing the web stays with the parent',
  });
  return { ok: checks.every(check => check.status !== 'fail'), checks };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = report.checks.map(check => `${check.name}: ${check.status === 'ok' ? '' : `${check.status.toUpperCase()} `}${check.detail}`);
  return [`SDD doctor: ${report.ok ? 'no failures' : 'FAILURES found'} (no providers contacted, no code run, no configuration changed)`, ...lines].join('\n');
}

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

export const ROLE_KEYS = Object.freeze({
  code: 'feature, refactoring',
  fix: 'bug-fix',
  performance: 'perf-issue',
  research: 'how explorer',
  review: 'judgment and prose',
  eval: 'judgment and prose',
  prose: 'judgment and prose',
  hardest: 'hardest tasks',
});

export type WorkerRole = keyof typeof ROLE_KEYS;
export const workerRoles = Object.freeze(Object.keys(ROLE_KEYS)) as readonly WorkerRole[];

export const defaultRolesPath = join(homedir(), '.pi', 'agent', 'pstack', 'models.json');
export const defaultOverridesPath = join(homedir(), '.pi', 'agent', 'pi-sdd', 'config.json');

const MODEL_PATTERN = '^[^/\\s]+/\\S+$';
const modelId = new RegExp(MODEL_PATTERN);
const ModelIdSchema = Type.String({ pattern: MODEL_PATTERN });
const strict = { additionalProperties: false } as const;

export const RoleConfigSchema = Type.Object({
  version: Type.Literal(1),
  roles: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
  skillsEnabled: Type.Optional(Type.Boolean()),
}, strict);
export type RoleConfig = Static<typeof RoleConfigSchema>;

export const OverridesConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  models: Type.Object(Object.fromEntries(workerRoles.map(role => [role, Type.Optional(ModelIdSchema)])), strict),
}, strict);

export type ModelOverrides = Partial<Record<WorkerRole, string>>;

export function isWorkerRole(value: string): value is WorkerRole {
  return Object.hasOwn(ROLE_KEYS, value);
}

export interface ResolveModelInput {
  role: string;
  roles: Readonly<Record<string, unknown>>;
  overrides: ModelOverrides;
  available: readonly string[];
  escalation?: string | undefined;
}

export function resolveModel({ role, roles, overrides, available, escalation }: ResolveModelInput): string {
  if (!isWorkerRole(role)) throw new Error(`MODEL_ROLE_UNKNOWN: ${role} is not one of ${workerRoles.join(', ')}`);
  if (role === 'hardest' && !escalation?.trim()) {
    throw new Error('MODEL_ESCALATION_REQUIRED: the hardest role needs an explicit escalation reason');
  }
  const override = overrides[role];
  if (override !== undefined) {
    if (!modelId.test(override)) throw new Error(`MODEL_OVERRIDE_INVALID: override for ${role} must be an exact provider/model ID`);
    if (!available.includes(override)) throw new Error(`MODEL_UNAVAILABLE: override for ${role} names ${override}, which this host does not list as available`);
    return override;
  }
  const key = ROLE_KEYS[role];
  if (!Object.hasOwn(roles, key)) throw new Error(`MODEL_ROLE_MISSING: role ${role} needs "${key}" in the pstack role configuration`);
  const value = roles[key];
  if (typeof value !== 'string' || !modelId.test(value)) {
    throw new Error(`MODEL_ROLE_INVALID: "${key}" for role ${role} must be one exact provider/model ID`);
  }
  if (!available.includes(value)) throw new Error(`MODEL_UNAVAILABLE: role ${role} maps to ${value}, which this host does not list as available`);
  return value;
}

async function readJson(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`MODEL_CONFIG_INVALID: ${path} is not valid JSON`);
  }
}

function schemaError(path: string, schema: TSchema, value: unknown): Error {
  const first = Value.Errors(schema, value)[0];
  return new Error(`MODEL_CONFIG_INVALID: ${path} ${first?.instancePath || '/'} ${first?.message ?? 'does not match the schema'}`);
}

export async function loadRoleConfig(path = defaultRolesPath): Promise<RoleConfig> {
  const value = await readJson(path);
  if (value === undefined) throw new Error(`MODEL_CONFIG_MISSING: ${path} does not exist`);
  if (!Value.Check(RoleConfigSchema, value)) throw schemaError(path, RoleConfigSchema, value);
  return value;
}

export async function loadModelOverrides(path = defaultOverridesPath): Promise<ModelOverrides> {
  const value = await readJson(path);
  if (value === undefined) return {};
  if (!Value.Check(OverridesConfigSchema, value)) throw schemaError(path, OverridesConfigSchema, value);
  const overrides: ModelOverrides = {};
  for (const role of workerRoles) {
    const model = value.models[role];
    if (typeof model === 'string') overrides[role] = model;
  }
  return overrides;
}

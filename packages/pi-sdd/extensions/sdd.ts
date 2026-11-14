import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { BeadsClient, ExecuteTool } from '../src/beads.ts';
import { commandCollision, parseSddCommand, skillFile, workflowMessage, type SddCommand } from '../src/commands.ts';
import { createEvaluationTool } from '../src/evaluation-tool.ts';
import { createControlTool } from '../src/control-tool.ts';
import { formatDoctor, runDoctor } from '../src/doctor.ts';
import { defaultOverridesPath, defaultRolesPath, loadModelOverrides, loadRoleConfig, type ModelOverrides } from '../src/models.ts';
import { createWorkerTool, denyStarts, WorkerRegistry, type AuthorizeStart } from '../src/worker-tool.ts';
import { repositoryRoot } from '../src/project-lock.ts';
import {
  focusConflict,
  inactiveState,
  readLandFocus,
  reduceSession,
  SESSION_ENTRY_TYPE,
  type SessionState,
} from '../src/session-state.ts';
import { resolveSpec } from '../src/spec-store.ts';

const ownPath = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(ownPath));
const POLICY_SECTION = 'pi-sdd-workflow';

export interface SddExtensionOptions {
  skillsRoot?: string;
  beadsDir?: string;
  createClient?: (executeTool: ExecuteTool) => BeadsClient;
  authorizeStart?: AuthorizeStart;
  agentDir?: string;
  rolesPath?: string;
  overridesPath?: string;
  loadModels?: () => Promise<{ roles: Readonly<Record<string, unknown>>; overrides: ModelOverrides }>;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function same(a: SessionState, b: SessionState): boolean {
  return a.active === b.active && a.projectRoot === b.projectRoot && a.specPath === b.specPath && a.missionId === b.missionId;
}

export function createSddExtension(options: SddExtensionOptions = {}): (pi: ExtensionAPI) => void {
  const skillsRoot = options.skillsRoot ?? join(packageRoot, 'skills');
  const beadsDir = options.beadsDir ?? join(homedir(), '.missions', '.beads');
  const rolesPath = options.rolesPath ?? defaultRolesPath;
  const overridesPath = options.overridesPath ?? defaultOverridesPath;
  const loadModels = options.loadModels ?? (async () => {
    const [config, overrides] = await Promise.all([loadRoleConfig(rolesPath), loadModelOverrides(overridesPath)]);
    return { roles: config.roles, overrides };
  });

  return pi => {
    let state: SessionState = { ...inactiveState };
    let policy: string | null = null;
    const owned = new Set<AbortController>();
    const workers = new WorkerRegistry();

    const refresh = (ctx: ExtensionContext) => {
      state = { ...inactiveState };
      state = reduceSession(ctx.sessionManager.getBranch());
    };
    const record = (next: SessionState) => {
      pi.appendEntry(SESSION_ENTRY_TYPE, next);
      state = next;
    };

    pi.on('session_start', (_event, ctx) => refresh(ctx));
    pi.on('session_tree', (_event, ctx) => refresh(ctx));
    pi.on('session_shutdown', () => {
      for (const controller of owned) controller.abort();
      owned.clear();
      workers.clear();
    });
    pi.on('before_agent_start', async event => {
      const options = event.systemPromptOptions;
      if (!state.active) {
        delete options.sections[POLICY_SECTION];
        return;
      }
      policy ??= (await readFile(join(packageRoot, 'policies', 'workflow.md'), 'utf8')).trim();
      if (options.forceSystemPrompt !== undefined) {
        return { systemPrompt: `${options.forceSystemPrompt}\n\n<${POLICY_SECTION}>\n${policy}\n</${POLICY_SECTION}>` };
      }
      options.sections[POLICY_SECTION] = policy;
    });

    async function status(ctx: ExtensionCommandContext, target: string | null): Promise<void> {
      refresh(ctx);
      const focus = readLandFocus(ctx.sessionManager.getBranch());
      const conflict = focusConflict(state, focus);
      const lines = [
        `SDD ${state.active ? 'active' : 'inactive'}`,
        `project: ${state.projectRoot || 'none'}`,
        `spec: ${state.specPath ?? 'none'}`,
        `mission: ${state.missionId ?? 'none'}`,
        `land-focus: ${focus?.id ?? 'none'}`,
      ];
      if (conflict) lines.push(`FOCUS_CONFLICT: SDD mission ${conflict.sddMissionId} differs from land-focus ${conflict.focusMissionId}`);
      if (target !== null) {
        try {
          const resolved = await resolveSpec({ projectRoot: state.projectRoot || ctx.cwd, target });
          lines.push(resolved.kind === 'descriptor'
            ? `spec ${target}: ${resolved.path} (tier ${resolved.spec.tier}, bound to ${resolved.spec.binding?.missionId ?? 'none'})`
            : `spec ${target}: ${resolved.path} (legacy ${resolved.inferredTier}, requires import)`);
        } catch (error) {
          lines.push(`spec ${target}: ${message(error)}`);
        }
      }
      lines.push('Task states are read by the sdd_control status operation.');
      ctx.ui.notify(lines.join('\n'), 'info');
    }

    async function dispatch(ctx: ExtensionCommandContext, command: Extract<SddCommand, { kind: 'workflow' }>): Promise<void> {
      const collision = commandCollision(pi.getCommands(), ownPath);
      if (collision) {
        ctx.ui.notify(collision, 'error');
        return;
      }
      const skillPath = skillFile(skillsRoot, command.verb);
      if (!await exists(skillPath)) {
        ctx.ui.notify(`SKILL_NOT_FOUND: ${skillPath}. The ${command.verb} workflow is not installed; nothing was started.`, 'error');
        return;
      }
      refresh(ctx);
      const conflict = focusConflict(state, readLandFocus(ctx.sessionManager.getBranch()));
      if (conflict) {
        const summary = `FOCUS_CONFLICT: SDD mission ${conflict.sddMissionId} differs from land-focus ${conflict.focusMissionId}.`;
        if (!ctx.hasUI) {
          ctx.ui.notify(`${summary} Resolve it with /focus or /sdd off, then retry.`, 'error');
          return;
        }
        const choices = [`Continue with SDD mission ${conflict.sddMissionId}`, 'Turn SDD off', 'Cancel'];
        const choice = await ctx.ui.select(summary, choices);
        if (choice === choices[1]) {
          if (state.active) record({ ...state, active: false });
          ctx.ui.notify('SDD off; nothing was started.', 'info');
          return;
        }
        if (choice !== choices[0]) {
          ctx.ui.notify('SDD dispatch cancelled; nothing changed.', 'warning');
          return;
        }
      }
      const projectRoot = await repositoryRoot(ctx.cwd);
      const sameProject = state.projectRoot === projectRoot;
      const next: SessionState = {
        active: true,
        projectRoot,
        specPath: sameProject ? state.specPath : null,
        missionId: sameProject ? state.missionId : null,
      };
      if (!same(state, next)) record(next);
      const text = workflowMessage({ ...command, skillPath, ...next });
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: 'followUp' });
    }

    pi.registerCommand('sdd', {
      description: 'Run an opt-in spec-driven workflow: /sdd <brainstorm|specify|implement|review|...> | status | doctor | off',
      handler: async (args, ctx) => {
        let command: SddCommand;
        try {
          command = parseSddCommand(args);
        } catch (error) {
          ctx.ui.notify(message(error), 'error');
          return;
        }
        switch (command.kind) {
          case 'status':
            await status(ctx, command.target);
            return;
          case 'doctor': {
            const report = await runDoctor({
              version: VERSION,
              platform: process.platform,
              tools: pi.getAllTools(),
              commandCollision: commandCollision(pi.getCommands(), ownPath),
              agentDir: options.agentDir ?? getAgentDir(),
              beadsDir,
              pathEnv: process.env.PATH ?? '',
              skillsRoot,
              rolesPath,
              overridesPath,
              availableModels: ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`),
            });
            ctx.ui.notify(formatDoctor(report), report.ok ? 'info' : 'error');
            return;
          }
          case 'off':
            try {
              refresh(ctx);
            } catch (error) {
              if (!(error instanceof Error) || !error.message.startsWith('SESSION_STATE_CORRUPT:')) throw error;
              // Explicit off is the recovery path: never reuse untrusted binding context.
              record({ ...inactiveState, projectRoot: await repositoryRoot(ctx.cwd) });
            }
            if (state.active) record({ ...state, active: false });
            ctx.ui.notify('SDD off for this session branch. Spec files and mission bindings are unchanged.', 'info');
            return;
          case 'workflow':
            await dispatch(ctx, command);
            return;
        }
      },
    });

    pi.registerTool(createEvaluationTool({ owned }));
    pi.registerTool(createControlTool({
      beadsDir,
      createClient: options.createClient,
      appendState: record,
      owned,
    }));
    pi.registerTool(createWorkerTool({
      registry: workers,
      owned,
      authorizeStart: options.authorizeStart ?? denyStarts,
      loadModels,
      policiesDir: join(packageRoot, 'policies'),
    }));
  };
}

export default createSddExtension();

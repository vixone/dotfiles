import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentSession, DefaultResourceLoader, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
type SDK = typeof import('@earendil-works/pi-coding-agent');

export async function installedSdk(): Promise<SDK> {
  const install = join(userInfo().homedir, '.pi/agent/install');
  const version = (await readFile(join(install, 'current-version'), 'utf8')).trim();
  if (version !== '1.0.4') throw new Error('HOST_VERSION_UNSUPPORTED: ' + version);
  const root = await realpath(join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent'));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { main: string };
  return await import(pathToFileURL(join(root, manifest.main)).href) as SDK;
}

export interface Host {
  loader: DefaultResourceLoader;
  session: AgentSession;
  calls: string[];
  notices: string[];
}

export async function withPiHost<T>(run: (host: Host) => Promise<T>, collision = false): Promise<T> {
  const root = await mkdtemp('/tmp/pi-sdd-host-');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let session: AgentSession | undefined;
  try {
    const sdk = await installedSdk();
    const calls: string[] = [];
    const notices: string[] = [];
    const settingsManager = sdk.SettingsManager.inMemory({});
    const loader = new sdk.DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager,
      additionalExtensionPaths: [packageRoot],
      additionalSkillPaths: [join(packageRoot, 'skills')],
      noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [pi => {
        for (const name of ['start', 'focus', 'land', 'pstack', ...(collision ? ['sdd'] : [])]) {
          pi.registerCommand(name, { description: 'coexistence fixture', handler: async () => { calls.push(name); } });
        }
        pi.on('tool_call', event => {
          if (event.toolName === 'bash' && /\bbd\b/.test(JSON.stringify(event.input))) {
            throw new Error('REAL_BEADS_FORBIDDEN');
          }
        });
      }],
    });
    await loader.reload();
    ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
      settingsManager, sessionManager: sdk.SessionManager.inMemory(root) }));
    const uiContext = { notify: (text: string) => { notices.push(text); }, select: async () => undefined,
      confirm: async () => false, input: async () => undefined, setStatus: () => {} };
    await session.bindExtensions({ mode: 'rpc', uiContext: uiContext as unknown as ExtensionUIContext });
    return await run({ loader, session, calls, notices });
  } finally {
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

export type Tier = 'direct' | 'incremental' | 'factory-command' | 'factory-http';
export async function runAcceptance({ tier }: { tier: Tier }) {
  return withPiHost(async ({ loader, session, notices }) => {
    if (loader.getExtensions().errors.length) throw new Error('HOST_LOAD_FAILED');
    await session.prompt('/sdd status');
    const control = loader.getExtensions().extensions.flatMap(e => [...e.tools.values()])
      .find(t => t.definition.name === 'sdd_control');
    if (!control) throw new Error('CONTROL_TOOL_MISSING');
    // Inspect the registered schema; a receipt cannot be persisted by this snapshot.
    if (JSON.stringify(control.definition.parameters).includes('checkpoint')) {
      throw new Error('HARNESS_REQUIRES_CHECKPOINT_ADAPTER');
    }
    return { tier, status: 'blocked' as const, reason: 'CHECKPOINT_CAPABILITY_MISSING', closedTasks: 0,
      commandEvidence: notices };
  });
}

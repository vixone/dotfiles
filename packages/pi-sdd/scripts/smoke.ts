import { readdir, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, dirname } from 'node:path';
import { runAcceptance, type Tier } from '../test/helpers/pi-host.ts';

async function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let allowed = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--allow-provider-usage') { allowed = true; continue; }
    const match = /^--(mode|tier|project)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error('UNKNOWN_ARGUMENT: ' + arg);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--') || values.has(match[1]!)) throw new Error('INVALID_ARGUMENT: ' + arg);
    values.set(match[1]!, value);
  }
  const mode = values.get('mode') ?? 'offline';
  const tier = values.get('tier') ?? 'direct';
  if (!['offline', 'live'].includes(mode)) throw new Error('INVALID_MODE');
  if (!['direct', 'incremental', 'factory-command', 'factory-http'].includes(tier)) throw new Error('INVALID_TIER');
  if (mode === 'live' && !allowed) throw new Error('PROVIDER_APPROVAL_REQUIRED');
  const project = values.get('project');
  if (!project || !isAbsolute(project)) throw new Error('ABSOLUTE_DISPOSABLE_PROJECT_REQUIRED');
  if ((await lstat(project)).isSymbolicLink()) throw new Error('PROJECT_SYMLINK_FORBIDDEN');
  const canonical = await realpath(project);
  if (dirname(canonical) !== await realpath('/tmp') || !/\/pi-sdd-(offline|live)\.[A-Za-z0-9]+$/.test(canonical)
      || (await readdir(canonical)).length !== 0) throw new Error('EMPTY_DISPOSABLE_PROJECT_REQUIRED');
  if (mode === 'live') throw new Error('LIVE_ADAPTER_UNAVAILABLE: no provider call made');
  const report = await runAcceptance({ tier: tier as Tier });
  console.log(JSON.stringify(report, null, 2));
  // A blocked smoke is not a successful tier acceptance run.
  process.exitCode = 2;
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

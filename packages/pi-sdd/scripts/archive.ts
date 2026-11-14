import { lstat, readdir, readFile, realpath, mkdtemp, mkdir, copyFile, chmod, rm } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'));
const reviewed = ['package.json', 'package-lock.json', 'extensions', 'src', 'skills', 'policies', 'templates', 'README.md', 'docs', 'install.sh', 'scripts/archive.ts', 'LICENSE', 'NOTICE', 'upstream.json'];
const forbidden = /^(?:\..*|node_modules|auth\.json|credentials.*|.*\.log)$/i;

async function inventory(): Promise<string[]> {
  const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !('files' in manifest) || JSON.stringify(manifest.files) !== JSON.stringify(reviewed)) {
    throw new Error('package.json files must match the reviewed distribution inventory');
  }
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`Archive refuses symlink: ${path}`);
    if (path.split('/').some(part => forbidden.test(part))) throw new Error(`Unreviewed private path: ${path}`);
    if (info.isDirectory()) {
      for (const child of (await readdir(join(root, path))).sort()) {
        if (child === '.gitkeep') continue;
        await visit(`${path}/${child}`);
      }
    } else if (info.isFile()) {
      const text = await readFile(join(root, path), 'utf8');
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text)) throw new Error(`Secret-like content: ${path}`);
      files.push(path);
    } else throw new Error(`Unsupported distribution file: ${path}`);
  }
  for (const path of reviewed) await visit(path);
  return files;
}

async function check(): Promise<void> {
  const failures: string[] = [];
  const requireCheck = (ok: boolean, detail: string) => { console.log(`${ok ? 'OK' : 'MISSING prerequisite'}: ${detail}`); if (!ok) failures.push(detail); };
  requireCheck(process.versions.node.split('.')[0] === '26', 'Node 26');
  requireCheck(process.platform === 'darwin', 'macOS worker host');
  const version = spawnSync('pi', ['--version'], { encoding: 'utf8', timeout: 5000 });
  requireCheck(version.status === 0 && /(?:^|\s)1\.0\.4(?:\s|$)/.test(version.stdout), 'pi 1.0.4 on PATH');
  const agent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  async function present(path: string): Promise<boolean> { try { return (await lstat(path)).isFile(); } catch { return false; } }
  requireCheck(await present(join(agent, 'extensions/guards/index.ts')), 'required guards/index.ts');
  const bd = (process.env.PATH ?? '').split(':').some(dir => { const r = spawnSync('/bin/test', ['-x', join(dir, 'bd')]); return r.status === 0; });
  requireCheck(bd, 'global bd executable on PATH (not invoked)');
  try { requireCheck((await lstat(join(homedir(), '.beads'))).isDirectory(), 'global ~/.beads'); } catch { requireCheck(false, 'global ~/.beads'); }
  try {
    const roles: unknown = JSON.parse(await readFile(join(agent, 'pstack/models.json'), 'utf8'));
    const keys = ['feature, refactoring', 'bug-fix', 'perf-issue', 'how explorer', 'judgment and prose', 'hardest tasks'];
    const valid = roles !== null && typeof roles === 'object' && 'version' in roles && roles.version === 1 && 'roles' in roles && roles.roles !== null && typeof roles.roles === 'object' && keys.every(key => {
      const model = Object.getOwnPropertyDescriptor(roles.roles, key)?.value;
      return typeof model === 'string' && /^[^/\s]+\/\S+$/.test(model);
    });
    requireCheck(valid, 'pstack exact role model IDs');
  } catch { requireCheck(false, 'pstack/models.json role configuration'); }
  // CLI inspection cannot prove a registered tool schema or guard hooks. Doctor is the activation gate.
  try {
    const settings: unknown = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'));
    const sources = settings && typeof settings === 'object' && 'packages' in settings && Array.isArray(settings.packages) ? settings.packages : [];
    requireCheck(sources.some((p: unknown) => {
      const source = typeof p === 'string' ? p : p && typeof p === 'object' && 'source' in p ? p.source : '';
      return typeof source === 'string' && /(?:^|[\/:-])pi-subagent(?:$|[@\/])/.test(source);
    }), 'pi-subagent package declaration; active contract must pass /sdd doctor');
  } catch { requireCheck(false, 'pi-subagent settings declaration'); }
  const files = await inventory(); console.log(`OK: ${files.length} reviewed resources, secret-pattern scan clean`);
  console.log('UNVERIFIED: active subagent start/status/wait/cancel/list, guard hooks and model availability require /sdd doctor. No providers contacted.');
  if (failures.length) throw new Error(`${failures.length} missing or incompatible prerequisites; no changes made`);
}

async function archive(output: string): Promise<void> {
  if (!isAbsolute(output) || !output.endsWith('.tar.gz')) throw new Error('Archive output must be an absolute .tar.gz path');
  const parent = await realpath(dirname(output));
  const destination = join(parent, output.slice(output.lastIndexOf('/') + 1));
  const rel = relative(root, destination);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('Archive output must be outside the package');
  try { await lstat(destination); throw new Error('Archive output already exists'); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const files = await inventory();
  const temporary = await mkdtemp('/tmp/pi-sdd-bundle-');
  try {
    for (const file of files) {
      const target = join(temporary, 'pi-sdd', file); await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, file), target); await chmod(target, file === 'install.sh' ? 0o755 : 0o644);
    }
    const result = spawnSync('tar', ['-czf', destination, '-C', temporary, 'pi-sdd'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    if (result.status !== 0) throw new Error(result.stderr || 'tar failed');
    console.log(files.map(file => `pi-sdd/${file}`).join('\n'));
    console.log(`Archive: ${destination}; ${files.length} files; secret-pattern scan clean (not a secrecy guarantee)`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try {
  if (process.argv[2] === '--check' && process.argv.length === 3) await check();
  else if (process.argv[2] === '--archive' && process.argv.length === 4 && process.argv[3]) await archive(resolve(process.argv[3]) === process.argv[3] ? process.argv[3] : (() => { throw new Error('Use a canonical absolute output path'); })());
  else throw new Error('Usage: archive.ts --check | --archive /absolute/output.tar.gz');
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }

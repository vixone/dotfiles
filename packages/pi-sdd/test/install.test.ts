import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('installer delegates exact canonical source and preserves unrelated settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdd-install-'));
  try {
    const home = join(root, 'home'); const bin = join(root, 'bin');
    const agent = join(home, '.pi', 'agent');
    await mkdir(agent, { recursive: true }); await mkdir(bin);
    const settings = join(agent, 'settings.json');
    const before = { packages: ['pstack', 'footer', 'themes', 'pi-subagent'], theme: 'existing' };
    await writeFile(settings, JSON.stringify(before));
    await writeFile(join(bin, 'pi'), `#!/usr/bin/env node\nconst fs=require('fs');const p=process.env.PI_CODING_AGENT_DIR+'/settings.json';const s=JSON.parse(fs.readFileSync(p));const [verb,source]=process.argv.slice(2);if(verb==='install'){if(!s.packages.includes(source))s.packages.push(source)}else if(verb==='remove'){s.packages=s.packages.filter(x=>x!==source)}else process.exit(9);fs.writeFileSync(p,JSON.stringify(s));\n`, { mode: 0o755 });
    const alias = join(root, 'package with spaces'); await symlink(resolve('.'), alias);
    const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PATH: `${bin}:${process.env.PATH}`, TMPDIR: '/tmp' };
    const run = (arg: string) => spawnSync(join(alias, 'install.sh'), [arg], { env, encoding: 'utf8' });
    for (let i = 0; i < 2; i++) { const r = run('--install'); assert.equal(r.status, 0, r.stderr); }
    const after = JSON.parse(await readFile(settings, 'utf8'));
    assert.deepEqual(after.packages.filter((p: string) => p !== resolve('.')), before.packages);
    assert.equal(after.packages.filter((p: string) => p === resolve('.')).length, 1);
    for (let i = 0; i < 2; i++) assert.equal(run('--remove').status, 0);
    assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), before);
    const bytes = await readFile(settings, 'utf8'); run('--check');
    assert.equal(await readFile(settings, 'utf8'), bytes);
    assert.notEqual(run('--unknown').status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

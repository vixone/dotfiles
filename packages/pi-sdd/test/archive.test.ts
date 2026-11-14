import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('archive contains only distribution paths and is relocatable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdd-archive-'));
  try {
    const output = join(root, 'package with spaces.tar.gz');
    const result = spawnSync('./install.sh', ['--archive', output], { encoding: 'utf8', env: { ...process.env, TMPDIR: '/tmp' } });
    assert.equal(result.status, 0, result.stderr);
    const list = spawnSync('tar', ['-tzf', output], { encoding: 'utf8' });
    assert.equal(list.status, 0); assert.doesNotMatch(list.stdout, /(?:^|\/)(?:\.git|\.pi|\.beads|node_modules|test)(?:\/|$)/m);
    assert.match(list.stdout, /pi-sdd\/extensions\/sdd.ts/);
    assert.equal(spawnSync('tar', ['-xzf', output, '-C', root]).status, 0);
    const pkg = JSON.parse(await readFile(join(root, 'pi-sdd/package.json'), 'utf8'));
    assert.ok(pkg.files.includes('scripts/archive.ts'));
    await access(join(root, 'pi-sdd/install.sh'));
    const check = spawnSync(join(root, 'pi-sdd/install.sh'), ['--check'], { encoding: 'utf8', env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent') } });
    assert.notEqual(check.status, 0); assert.match(check.stderr + check.stdout, /prerequisite|missing/i);
    assert.notEqual(spawnSync('./install.sh', ['--archive', 'relative.tar.gz']).status, 0);
    assert.notEqual(spawnSync('./install.sh', ['--archive', output]).status, 0);
    const agent = join(root, 'agent'); const bin = join(root, 'bin');
    await mkdir(join(agent, 'extensions/guards'), { recursive: true });
    await mkdir(join(agent, 'pstack')); await mkdir(join(root, '.beads')); await mkdir(bin);
    await writeFile(join(agent, 'extensions/guards/index.ts'), '// fixture');
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: ['pi-subagent'] }));
    const roles = Object.fromEntries(['feature, refactoring', 'bug-fix', 'perf-issue', 'how explorer', 'judgment and prose', 'hardest tasks'].map(key => [key, 'fixture/model']));
    await writeFile(join(agent, 'pstack/models.json'), JSON.stringify({ version: 1, roles }));
    await writeFile(join(bin, 'pi'), '#!/bin/sh\necho 1.0.4\n', { mode: 0o755 });
    await writeFile(join(bin, 'bd'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PATH: `${bin}:${process.env.PATH}`, TMPDIR: '/tmp' };
    const ready = spawnSync(join(root, 'pi-sdd/install.sh'), ['--check'], { encoding: 'utf8', env });
    assert.equal(ready.status, process.platform === 'darwin' ? 0 : 1, ready.stderr);
    assert.match(ready.stdout, /UNVERIFIED/);
    // Repacking the extracted bundle must refuse escaping links and credential patterns.
    await symlink('/tmp', join(root, 'pi-sdd/src/escape'));
    const repack = () => spawnSync(join(root, 'pi-sdd/install.sh'), ['--archive', join(root, 'second.tar.gz')], { encoding: 'utf8', env });
    assert.match(repack().stderr, /symlink/);
    await rm(join(root, 'pi-sdd/src/escape'));
    await writeFile(join(root, 'pi-sdd/src/private.txt'), '-----BEGIN PRIVATE KEY-----');
    assert.match(repack().stderr, /Secret-like/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

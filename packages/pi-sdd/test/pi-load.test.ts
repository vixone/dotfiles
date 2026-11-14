import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPiHost } from './helpers/pi-host.ts';
import { skillNames } from '../src/catalog.ts';

test('installed release loads explicit skills and preserves command namespaces', async () => {
  await withPiHost(async ({ loader, session, calls }) => {
    assert.deepEqual(loader.getExtensions().errors, []);
    const skills = loader.getSkills().skills;
    assert.deepEqual(skills.map(s => s.name).sort(), [...skillNames].sort());
    assert.ok(skills.every(s => s.disableModelInvocation));
    const names = session.extensionRunner.getRegisteredCommands().map(c => c.invocationName);
    assert.equal(names.filter(n => n === 'sdd').length, 1);
    for (const name of ['start', 'focus', 'land', 'pstack']) {
      assert.ok(names.includes(name));
      await session.prompt('/' + name);
    }
    assert.deepEqual(calls, ['start', 'focus', 'land', 'pstack']);
    await session.prompt('/sdd off');
  });
});

test('pre-existing sdd is diagnosed rather than silently selected', async () => {
  await withPiHost(async ({ session, notices }) => {
    const commands = session.extensionRunner.getRegisteredCommands();
    assert.equal(commands.filter(c => c.name === 'sdd').length, 2);
    const ours = commands.find(c => c.name === 'sdd' && c.sourceInfo?.path.includes('sdd.ts'));
    assert.ok(ours);
    await session.prompt('/' + ours.invocationName + ' doctor');
    assert.match(notices.join('\n'), /COMMAND_COLLISION|collision|another.*sdd/i);
  }, true);
});

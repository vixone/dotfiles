import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance } from './helpers/pi-host.ts';

for (const tier of ['direct', 'incremental', 'factory-command', 'factory-http'] as const) {
  test(tier + ' does not fabricate completion when checkpoint capability is absent', async () => {
    const report = await runAcceptance({ tier });
    assert.equal(report.status, 'blocked');
    assert.match(report.reason, /CHECKPOINT_CAPABILITY_MISSING/);
    assert.equal(report.closedTasks, 0);
  });
}

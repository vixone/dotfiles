import { test } from 'node:test';
import assert from 'node:assert/strict';
test('passing behavior', () => assert.equal(2 + 2, 4));
test('intentional regression evidence', () => assert.equal(2 + 2, 5));

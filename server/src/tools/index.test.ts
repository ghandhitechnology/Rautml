import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildToolRegistry, REGISTRY_ORDER } from './index.js';

describe('tool registry', () => {
  it('matches the declared order, includes browser, and has unique names', () => {
    const names = buildToolRegistry().map((tool) => tool.name);
    assert.deepEqual(names, [...REGISTRY_ORDER]);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes('browser'));
  });
});

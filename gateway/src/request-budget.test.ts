import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestBudget } from './request-budget.js';

test('request budget caps bursts, refills and tolerates clock rollback without unbounded state', () => {
  const budget = new RequestBudget(2, 10, 1000);
  assert.equal(budget.allow(1000), true);
  assert.equal(budget.allow(1000), true);
  assert.equal(budget.allow(1000), false);
  assert.equal(budget.allow(900), false);
  assert.equal(budget.allow(1099), false);
  assert.equal(budget.allow(1100), true);
  assert.equal(budget.allow(1100), false);
  assert.equal(budget.allow(10000), true);
  assert.equal(budget.allow(10000), true);
  assert.equal(budget.allow(10000), false);
});

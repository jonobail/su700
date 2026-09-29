import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from '../lib/rate-limit.mjs';

const HOUR = 3_600_000;
const limits = { tokensPerHour: 6, snippetMinutesPerDay: 30, globalSnippetsPerDay: 500 };

function limiter(overrides = {}) {
  let t = 0;
  const rl = new RateLimiter({ ...limits, ...overrides }, () => t);
  return { rl, advance: (ms) => (t += ms) };
}

test('allows 6 tokens per hour per client, then refuses', () => {
  const { rl } = limiter();
  for (let i = 0; i < 6; i++) {
    assert.equal(rl.check('a', 5), null);
    rl.recordToken('a', 5);
  }
  assert.equal(rl.check('a', 5), 'tokens_per_hour');
  assert.equal(rl.check('b', 5), null, 'other clients are unaffected');
});

test('the hourly window rolls', () => {
  const { rl, advance } = limiter();
  for (let i = 0; i < 6; i++) rl.recordToken('a', 5);
  advance(HOUR - 1);
  assert.equal(rl.check('a', 5), 'tokens_per_hour');
  assert.ok(rl.retryAfter('a', 'tokens_per_hour') <= 1);
  advance(2);
  assert.equal(rl.check('a', 5), null);
});

test('caps snippet minutes per client per day', () => {
  const { rl, advance } = limiter({ tokensPerHour: 1000 });
  // 59 × 30 s = 29.5 min used: one more 30 s snippet lands exactly on the 30 min cap.
  for (let i = 0; i < 59; i++) rl.recordToken('a', 30);
  assert.equal(rl.check('a', 30), null);
  assert.equal(rl.check('a', 31), 'snippet_minutes_per_day');
  rl.recordToken('a', 30);
  assert.equal(rl.check('a', 1), 'snippet_minutes_per_day');
  advance(24 * HOUR + 1);
  assert.equal(rl.check('a', 30), null);
});

test('global daily cap counts served snippets across all clients', () => {
  const { rl, advance } = limiter({ globalSnippetsPerDay: 3 });
  rl.recordSnippet();
  rl.recordSnippet();
  assert.equal(rl.globalCapReached(), false);
  rl.recordSnippet();
  assert.equal(rl.globalCapReached(), true);
  assert.equal(rl.check('new-client', 5), 'global_daily_cap');
  advance(24 * HOUR + 1);
  assert.equal(rl.globalCapReached(), false);
});

test('sweep drops expired entries', () => {
  const { rl, advance } = limiter();
  rl.recordToken('a', 5);
  advance(25 * HOUR);
  rl.sweep();
  assert.equal(rl.tokens.size, 0);
  assert.equal(rl.seconds.size, 0);
});

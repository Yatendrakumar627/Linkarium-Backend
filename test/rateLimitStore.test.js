const { describe, test } = require('node:test');
const assert = require('node:assert');
const { createRateLimitStore } = require('../utils/rateLimitStore');

describe('RateLimitStore', () => {
  test('increments hits in memory when database is disconnected', async () => {
    const store = createRateLimitStore('test-ip', 60_000);
    const first = await store.increment('127.0.0.1');
    assert.strictEqual(first.totalHits, 1);
    assert.ok(first.resetTime instanceof Date);

    const second = await store.increment('127.0.0.1');
    assert.strictEqual(second.totalHits, 2);

    const third = await store.increment('127.0.0.1');
    assert.strictEqual(third.totalHits, 3);
  });

  test('isolates keys', async () => {
    const store = createRateLimitStore('test-ns', 60_000);
    const userA = await store.increment('userA');
    const userB = await store.increment('userB');

    assert.strictEqual(userA.totalHits, 1);
    assert.strictEqual(userB.totalHits, 1);
  });

  test('decrements hit count', async () => {
    const store = createRateLimitStore('test-dec', 60_000);
    await store.increment('user1');
    await store.increment('user1');
    await store.decrement('user1');
    const next = await store.increment('user1');
    assert.strictEqual(next.totalHits, 2);
  });

  test('resetKey clears a key counter', async () => {
    const store = createRateLimitStore('test-reset', 60_000);
    await store.increment('userX');
    await store.increment('userX');
    await store.resetKey('userX');

    const fresh = await store.increment('userX');
    assert.strictEqual(fresh.totalHits, 1);
  });

  test('resetAll clears all keys for the store', async () => {
    const store = createRateLimitStore('test-clear', 60_000);
    await store.increment('k1');
    await store.increment('k2');
    await store.resetAll();

    const k1 = await store.increment('k1');
    const k2 = await store.increment('k2');
    assert.strictEqual(k1.totalHits, 1);
    assert.strictEqual(k2.totalHits, 1);
  });

  test('resets counter after window expires', async () => {
    // 50ms short window
    const store = createRateLimitStore('test-expire', 50);
    const r1 = await store.increment('expiring-user');
    assert.strictEqual(r1.totalHits, 1);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const r2 = await store.increment('expiring-user');
    assert.strictEqual(r2.totalHits, 1);
  });
});


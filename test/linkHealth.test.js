const { describe, test } = require('node:test');
const assert = require('node:assert');
const { classify, nextCheckDelay, buildHealthUpdate } = require('../utils/linkHealth');

describe('classify', () => {
  test('a 200 response is healthy', () => {
    const verdict = classify({ ok: true, status: 200, finalUrl: 'https://example.com/' });
    assert.strictEqual(verdict.status, 'healthy');
    assert.strictEqual(verdict.httpStatus, 200);
  });

  test('a 301 that was followed is healthy', () => {
    assert.strictEqual(classify({ ok: true, status: 200 }).status, 'healthy');
  });

  test('a 404 is broken', () => {
    const verdict = classify({ ok: false, status: 404, error: 'HTTP 404' });
    assert.strictEqual(verdict.status, 'broken');
    assert.strictEqual(verdict.httpStatus, 404);
  });

  test('a 410 is broken', () => {
    assert.strictEqual(classify({ ok: false, status: 410 }).status, 'broken');
  });

  test('a 500 is broken', () => {
    const verdict = classify({ ok: false, status: 500 });
    assert.strictEqual(verdict.status, 'broken');
    assert.strictEqual(verdict.errorKind, 'server');
  });

  test('a 403 means the page exists but we may not read it', () => {
    const verdict = classify({ ok: false, status: 403 });
    assert.strictEqual(verdict.status, 'healthy');
    assert.strictEqual(verdict.errorKind, 'restricted');
  });

  test('a 429 is not a broken link', () => {
    assert.strictEqual(classify({ ok: false, status: 429 }).status, 'healthy');
  });

  test('a 999 (LinkedIn bot challenge) is treated as restricted healthy, not broken', () => {
    const verdict = classify({ ok: false, status: 999 });
    assert.strictEqual(verdict.status, 'healthy');
    assert.strictEqual(verdict.errorKind, 'restricted');
  });

  test('a blocked URL is unknown, not broken', () => {
    const verdict = classify({ ok: false, status: null, errorKind: 'blocked-ip', error: 'blocked' });
    assert.strictEqual(verdict.status, 'unknown');
  });

  test('a DNS failure is broken', () => {
    const verdict = classify({ ok: false, status: null, errorKind: 'dns' });
    assert.strictEqual(verdict.status, 'broken');
  });

  test('a timeout is broken', () => {
    const verdict = classify({ ok: false, status: null, errorKind: 'timeout' });
    assert.strictEqual(verdict.status, 'broken');
    assert.strictEqual(verdict.errorKind, 'timeout');
  });
});

describe('nextCheckDelay', () => {
  test('a healthy link is checked once a week', () => {
    assert.strictEqual(nextCheckDelay('healthy', 0), 7 * 24 * 60 * 60 * 1000);
  });

  test('a broken link is checked the next day', () => {
    assert.strictEqual(nextCheckDelay('broken', 1), 24 * 60 * 60 * 1000);
  });

  test('repeated failures back off', () => {
    const first = nextCheckDelay('broken', 1);
    const third = nextCheckDelay('broken', 3);
    assert.ok(third > first);
  });

  test('the delay is capped', () => {
    assert.ok(nextCheckDelay('broken', 50) <= 30 * 24 * 60 * 60 * 1000);
  });
});

describe('buildHealthUpdate', () => {
  const now = new Date('2026-10-21T12:00:00Z');

  test('stores a healthy verdict', () => {
    const health = buildHealthUpdate(null, { status: 'healthy', httpStatus: 200, latencyMs: 42 }, now);
    assert.strictEqual(health.status, 'healthy');
    assert.strictEqual(health.httpStatus, 200);
    assert.strictEqual(health.latencyMs, 42);
    assert.strictEqual(health.failures, 0);
    assert.strictEqual(health.lastOkAt.toISOString(), now.toISOString());
    assert.ok(health.nextCheckAt.getTime() > now.getTime());
  });

  test('counts consecutive failures', () => {
    const verdict = { status: 'broken', httpStatus: 404, error: 'HTTP 404', errorKind: 'http' };
    const first = buildHealthUpdate({ failures: 0 }, verdict, now);
    assert.strictEqual(first.failures, 1);

    const second = buildHealthUpdate(first, verdict, now);
    assert.strictEqual(second.failures, 2);
  });

  test('a broken link keeps the date of the last success', () => {
    const lastOk = new Date('2026-10-01T12:00:00Z');
    const health = buildHealthUpdate(
      { lastOkAt: lastOk },
      { status: 'broken', httpStatus: 404 },
      now
    );
    assert.strictEqual(health.lastOkAt.toISOString(), lastOk.toISOString());
  });

  test('a recovery resets the failure counter', () => {
    const health = buildHealthUpdate({ failures: 7 }, { status: 'healthy', httpStatus: 200 }, now);
    assert.strictEqual(health.failures, 0);
  });
});

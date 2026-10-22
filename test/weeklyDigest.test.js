const { describe, test } = require('node:test');
const assert = require('node:assert');
const { isDigestDue } = require('../workers/tasks/weeklyDigest');

// 2026-10-19 is a Monday.
const MONDAY_8 = new Date('2026-10-19T08:00:00Z');
const prefs = (overrides = {}) => ({
  digestDay: 1,
  digestHour: 8,
  timezone: 'UTC',
  ...overrides,
});

describe('isDigestDue', () => {
  test('is due at the start of the window', () => {
    assert.strictEqual(isDigestDue(prefs(), MONDAY_8), true);
  });

  test('is not due before the target hour', () => {
    assert.strictEqual(isDigestDue(prefs(), new Date('2026-10-19T07:59:00Z')), false);
  });

  test('accepts a late run inside the 24-hour window', () => {
    assert.strictEqual(isDigestDue(prefs(), new Date('2026-10-19T12:00:00Z')), true);
    assert.strictEqual(isDigestDue(prefs(), new Date('2026-10-20T07:00:00Z')), true);
  });

  test('does not repeat once the window has closed', () => {
    assert.strictEqual(isDigestDue(prefs(), new Date('2026-10-20T08:00:00Z')), false);
    assert.strictEqual(isDigestDue(prefs(), new Date('2026-10-21T12:00:00Z')), false);
  });

  test('does not send twice in the same window', () => {
    const sent = prefs({ lastDigestAt: new Date('2026-10-19T09:00:00Z') });
    assert.strictEqual(isDigestDue(sent, new Date('2026-10-19T12:00:00Z')), false);
    assert.strictEqual(isDigestDue(sent, new Date('2026-10-20T07:00:00Z')), false);
  });

  test('sends again the following week', () => {
    const sent = prefs({ lastDigestAt: new Date('2026-10-12T09:00:00Z') });
    assert.strictEqual(isDigestDue(sent, MONDAY_8), true);
  });

  test('handles a late-night schedule delivered after midnight', () => {
    const late = prefs({ digestHour: 23 });
    assert.strictEqual(isDigestDue(late, new Date('2026-10-19T23:00:00Z')), true);
    assert.strictEqual(isDigestDue(late, new Date('2026-10-20T06:00:00Z')), true);
    assert.strictEqual(isDigestDue(late, new Date('2026-10-20T23:00:00Z')), false);
  });
});

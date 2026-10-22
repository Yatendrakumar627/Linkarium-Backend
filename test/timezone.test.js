const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  safeTimeZone,
  makeDateFormatter,
  startOfDayInTz,
  formatDayLabel,
  dayKey,
  dayOfWeek,
  hourOfDay,
} = require('../utils/timezone');

describe('safeTimeZone', () => {
  test('keeps a valid timezone', () => {
    assert.strictEqual(safeTimeZone('Europe/Berlin'), 'Europe/Berlin');
  });

  test('falls back to UTC for an unknown timezone', () => {
    assert.strictEqual(safeTimeZone('Mars/Olympus'), 'UTC');
  });

  test('falls back to UTC for an empty value', () => {
    assert.strictEqual(safeTimeZone(''), 'UTC');
    assert.strictEqual(safeTimeZone(undefined), 'UTC');
  });
});

describe('makeDateFormatter', () => {
  test('reports the calendar day in the given timezone', () => {
    // 2026-03-01T23:30:00Z is already the next day in Berlin (UTC+1 in March
    // before the DST switch on the 29th — actually UTC+2 in summer).
    const date = new Date('2026-06-01T23:30:00Z');
    const berlin = makeDateFormatter('Europe/Berlin')(date);
    assert.strictEqual(berlin.key, '2026-06-02');
    assert.strictEqual(berlin.y, 2026);
    assert.strictEqual(berlin.m, 6);
    assert.strictEqual(berlin.d, 2);
  });

  test('reports the same day in UTC', () => {
    const date = new Date('2026-06-01T23:30:00Z');
    const utc = makeDateFormatter('UTC')(date);
    assert.strictEqual(utc.key, '2026-06-01');
  });
});

describe('dayKey', () => {
  test('returns an ISO-like key', () => {
    assert.strictEqual(dayKey(new Date('2026-10-21T12:00:00Z'), 'UTC'), '2026-10-21');
  });
});

describe('startOfDayInTz', () => {
  test('is the midnight of that day in that timezone', () => {
    const midnight = startOfDayInTz(2026, 10, 21, 'UTC');
    assert.strictEqual(midnight.toISOString(), '2026-10-21T00:00:00.000Z');
  });

  test('accounts for the timezone offset', () => {
    const midnight = startOfDayInTz(2026, 10, 21, 'Europe/Berlin');
    // Berlin is UTC+2 in October (CEST ends in late October), so midnight is
    // 22:00 UTC on the previous day.
    assert.strictEqual(midnight.toISOString(), '2026-10-20T22:00:00.000Z');
  });
});

describe('formatDayLabel', () => {
  test('produces a short label', () => {
    const label = formatDayLabel(new Date('2026-10-21T12:00:00Z'), 'UTC');
    assert.match(label, /21/);
  });
});

describe('dayOfWeek', () => {
  test('returns 0 for Sunday and 6 for Saturday', () => {
    // 2026-10-18 is a Sunday, 2026-10-24 is a Saturday.
    assert.strictEqual(dayOfWeek(new Date('2026-10-18T12:00:00Z'), 'UTC'), 0);
    assert.strictEqual(dayOfWeek(new Date('2026-10-24T12:00:00Z'), 'UTC'), 6);
  });
});

describe('hourOfDay', () => {
  test('returns the hour in the given timezone', () => {
    assert.strictEqual(hourOfDay(new Date('2026-10-21T12:00:00Z'), 'UTC'), 12);
    assert.strictEqual(hourOfDay(new Date('2026-10-21T12:00:00Z'), 'Europe/Berlin'), 14);
  });
});

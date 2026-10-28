const { describe, test } = require('node:test');
const assert = require('node:assert');
const { parseQuery, matchesQuery, matchesCondition, resolveFlag } = require('../utils/querylang');

// A small link document used by the tests.
function doc(overrides = {}) {
  return {
    title: 'React hooks guide',
    url: 'https://example.com/react-hooks',
    description: 'A guide to hooks',
    note: 'Read this again before the workshop',
    tags: ['ai', 'react'],
    favorite: true,
    visits: 12,
    color: '#ff0000',
    host: 'example.com',
    hostLabel: 'example.com',
    collectionId: 'c1',
    tokens: ['react', 'hook', 'guide', 'workshop'],
    articleTokens: ['effect', 'dependency'],
    createdAt: new Date('2026-10-01T00:00:00Z'),
    archivedAt: null,
    mergedInto: null,
    deletedAt: null,
    health: { status: 'healthy', lastOkAt: new Date('2026-10-20T00:00:00Z') },
    og: { title: 'React hooks guide' },
    article: { wordCount: 1200, text: 'The effect dependency array matters.' },
    ...overrides,
  };
}

describe('matchesQuery', () => {
  test('matches free text against the metadata tokens', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('react')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('react hook')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('react vue')), false);
  });

  test('matches free text against the article tokens', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('dependency')), true);
  });

  test('matches a tag', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('tag:ai')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('tag:vue')), false);
  });

  test('matches a domain, including subdomains', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('domain:example.com')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('domain:other.com')), false);
  });

  test('matches a collection by id', () => {
    const ast = parseQuery('collection:work');
    assert.strictEqual(matchesQuery(doc(), ast, { collectionIds: ['c1'] }), true);
    assert.strictEqual(matchesQuery(doc(), ast, { collectionIds: ['c2'] }), false);
    assert.strictEqual(matchesQuery(doc(), ast, { collectionIds: null }), false);
  });

  test('matches the flags', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:favorite')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:broken')), false);
    assert.strictEqual(matchesQuery(doc({ health: { status: 'broken' } }), parseQuery('is:broken')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:healthy')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:archived')), false);
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:unarchived')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:merged')), false);
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:noted')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:with-og')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:readable')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('is:never-visited')), false);
  });

  test('matches the visit count', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('visits:>10')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('visits:<10')), false);
    assert.strictEqual(matchesQuery(doc(), parseQuery('visits:12')), true);
  });

  test('matches the date range', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('after:2026-09-01')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('before:2026-09-01')), false);
  });

  test('matches an exact phrase', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('"react hooks"')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('"hooks react"')), false);
  });

  test('honours an exclusion', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('react -vue')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('react -react')), false);
  });

  test('combines several conditions with AND', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('react tag:ai is:favorite')), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('react tag:ai is:broken')), false);
  });

  test('a fuzzy search tolerates a typo', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('reakt'), { fuzzy: true }), true);
    assert.strictEqual(matchesQuery(doc(), parseQuery('reakt')), false);
  });

  test('an empty query matches everything', () => {
    assert.strictEqual(matchesQuery(doc(), parseQuery('')), true);
  });
});

describe('matchesCondition', () => {
  test('compares plain values', () => {
    assert.strictEqual(matchesCondition(doc(), { favorite: true }), true);
    assert.strictEqual(matchesCondition(doc(), { favorite: false }), false);
  });

  test('treats null as missing', () => {
    assert.strictEqual(matchesCondition(doc(), { archivedAt: null }), true);
    assert.strictEqual(matchesCondition(doc(), { archivedAt: { $ne: null } }), false);
  });

  test('handles $exists', () => {
    assert.strictEqual(matchesCondition(doc(), { note: { $exists: true } }), true);
    assert.strictEqual(matchesCondition(doc(), { missing: { $exists: false } }), true);
  });

  test('handles $size', () => {
    assert.strictEqual(matchesCondition(doc(), { tags: { $size: 2 } }), true);
    assert.strictEqual(matchesCondition(doc(), { tags: { $size: 0 } }), false);
  });

  test('handles the comparison operators', () => {
    assert.strictEqual(matchesCondition(doc(), { visits: { $gt: 10 } }), true);
    assert.strictEqual(matchesCondition(doc(), { visits: { $gte: 12 } }), true);
    assert.strictEqual(matchesCondition(doc(), { visits: { $lt: 12 } }), false);
    assert.strictEqual(matchesCondition(doc(), { visits: { $lte: 12 } }), true);
  });

  test('handles dates', () => {
    assert.strictEqual(
      matchesCondition(doc(), { createdAt: { $gte: new Date('2026-09-01T00:00:00Z') } }),
      true
    );
    assert.strictEqual(
      matchesCondition(doc(), { createdAt: { $lt: new Date('2026-09-01T00:00:00Z') } }),
      false
    );
  });

  test('handles $or and $nor', () => {
    assert.strictEqual(matchesCondition(doc(), { $or: [{ favorite: false }, { favorite: true }] }), true);
    assert.strictEqual(matchesCondition(doc(), { $nor: [{ favorite: true }] }), false);
  });

  test('handles $in', () => {
    assert.strictEqual(matchesCondition(doc(), { visits: { $in: [11, 12] } }), true);
    assert.strictEqual(matchesCondition(doc(), { visits: { $in: [11] } }), false);
  });
});

describe('resolveFlag', () => {
  test('returns the condition of a known flag', () => {
    assert.deepStrictEqual(resolveFlag('favorite'), { favorite: true });
  });

  test('re-evaluates a relative flag every time', () => {
    const condition = resolveFlag('recent');
    assert.ok(condition.createdAt.$gte instanceof Date);
    // "recent" means "created within the last 30 days".
    const age = Date.now() - condition.createdAt.$gte.getTime();
    assert.ok(age > 29 * 24 * 60 * 60 * 1000 && age <= 30 * 24 * 60 * 60 * 1000 + 5000);
  });

  test('returns null for an unknown flag', () => {
    assert.strictEqual(resolveFlag('nonsense'), null);
  });
});

const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  levenshtein,
  isFuzzyMatch,
  fuzzyTokenScore,
  expandFuzzyTokens,
  tokenFuzzyMatch,
  defaultThreshold,
} = require('../utils/fuzzy');

describe('levenshtein', () => {
  test('identical strings have distance 0', () => {
    assert.strictEqual(levenshtein('react', 'react'), 0);
  });

  test('counts single edits', () => {
    assert.strictEqual(levenshtein('react', 'reakt'), 1);
    assert.strictEqual(levenshtein('react', 'reac'), 1);
    assert.strictEqual(levenshtein('react', 'reacts'), 1);
  });

  test('handles empty strings', () => {
    assert.strictEqual(levenshtein('', ''), 0);
    assert.strictEqual(levenshtein('abc', ''), 3);
    assert.strictEqual(levenshtein('', 'abc'), 3);
  });

  test('stops early once the distance is known to exceed the maximum', () => {
    // The exact distance is 3, but the early exit reports "more than 1".
    assert.strictEqual(levenshtein('kitten', 'sitting', 1), 2);
  });
});

describe('defaultThreshold', () => {
  test('short terms get no tolerance', () => {
    assert.strictEqual(defaultThreshold('js'), 0);
    assert.strictEqual(defaultThreshold('abc'), 0);
  });

  test('longer terms get a quarter of their length', () => {
    assert.strictEqual(defaultThreshold('react'), 1);
    assert.strictEqual(defaultThreshold('typescript'), 2);
  });
});

describe('isFuzzyMatch', () => {
  test('an exact match always matches', () => {
    assert.strictEqual(isFuzzyMatch('react', 'react'), true);
  });

  test('a single typo still matches', () => {
    assert.strictEqual(isFuzzyMatch('react', 'reakt'), true);
  });

  test('an unrelated word does not match', () => {
    assert.strictEqual(isFuzzyMatch('react', 'angular'), false);
  });

  test('short terms never match a different token', () => {
    assert.strictEqual(isFuzzyMatch('js', 'jsp'), false);
  });
});

describe('fuzzyTokenScore', () => {
  test('an exact match scores 1', () => {
    assert.strictEqual(fuzzyTokenScore('react', 'react'), 1);
  });

  test('a typo scores lower than an exact match', () => {
    const exact = fuzzyTokenScore('react', 'react');
    const typo = fuzzyTokenScore('react', 'reakt');
    assert.ok(typo > 0);
    assert.ok(typo < exact);
  });

  test('an unrelated token scores 0', () => {
    assert.strictEqual(fuzzyTokenScore('react', 'zzzzzzzz'), 0);
  });
});

describe('expandFuzzyTokens', () => {
  test('finds the tokens within the edit distance', () => {
    const vocabulary = ['react', 'redux', 'router', 'reakt'];
    const found = expandFuzzyTokens('react', vocabulary);
    assert.ok(found.includes('react'));
    assert.ok(found.includes('reakt'));
    assert.ok(!found.includes('redux'));
  });

  test('keeps the original casing', () => {
    const found = expandFuzzyTokens('react', ['React']);
    assert.deepStrictEqual(found, ['React']);
  });

  test('an empty vocabulary yields nothing', () => {
    assert.deepStrictEqual(expandFuzzyTokens('react', []), []);
  });
});

describe('tokenFuzzyMatch', () => {
  test('is true when any token is close enough', () => {
    assert.strictEqual(tokenFuzzyMatch('react', ['redux', 'reakt']), true);
  });

  test('is false when nothing is close enough', () => {
    assert.strictEqual(tokenFuzzyMatch('react', ['redux', 'angular']), false);
  });

  test('is false for an empty token list', () => {
    assert.strictEqual(tokenFuzzyMatch('react', []), false);
  });
});

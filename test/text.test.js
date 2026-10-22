const { describe, test } = require('node:test');
const assert = require('node:assert');
const { tokenize, tokenizeTags, buildSearchTokens, escapeRegex } = require('../utils/text');

describe('tokenize', () => {
  test('lowercases and splits on punctuation', () => {
    assert.deepStrictEqual(tokenize('Hello, World!'), ['hello', 'world']);
  });

  test('removes stopwords', () => {
    assert.deepStrictEqual(tokenize('the quick brown fox'), ['quick', 'brown', 'fox']);
  });

  test('keeps non-latin words intact', () => {
    assert.deepStrictEqual(tokenize('नमस्ते 世界'), ['नमस्ते', '世界']);
  });

  test('deduplicates and preserves order', () => {
    assert.deepStrictEqual(tokenize('react react vue'), ['react', 'vue']);
  });

  test('drops single characters', () => {
    assert.deepStrictEqual(tokenize('a b cd'), ['cd']);
  });
});

describe('tokenizeTags', () => {
  test('splits hyphenated tags', () => {
    assert.deepStrictEqual(tokenizeTags(['machine-learning']), ['machine', 'learning']);
  });
});

describe('buildSearchTokens', () => {
  test('indexes title, tags, description and URL parts', () => {
    const tokens = buildSearchTokens({
      title: 'React Guide',
      description: 'Hooks explained',
      tags: ['frontend'],
      url: 'https://docs.example.com/learn/react',
    });
    assert.ok(tokens.includes('react'));
    assert.ok(tokens.includes('guide'));
    assert.ok(tokens.includes('frontend'));
    assert.ok(tokens.includes('hooks'));
    assert.ok(tokens.includes('docs'));
    assert.ok(tokens.includes('learn'));
  });

  test('ignores an unparsable URL', () => {
    const tokens = buildSearchTokens({ title: 'A', description: '', tags: [], url: 'nonsense' });
    assert.deepStrictEqual(tokens, ['a'].filter((t) => t.length >= 2));
  });
});

describe('escapeRegex', () => {
  test('escapes metacharacters', () => {
    assert.strictEqual(escapeRegex('a.b*c'), 'a\\.b\\*c');
  });
});

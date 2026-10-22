const { describe, test } = require('node:test');
const assert = require('node:assert');
const { generateApiKey, hashApiKey, parseApiKey, isApiKeyShape, maskKey } = require('../utils/apiKey');

describe('generateApiKey', () => {
  test('produces a key with a readable prefix', () => {
    const generated = generateApiKey();
    assert.ok(generated.key.startsWith('lk_'));
    assert.strictEqual(generated.prefix.length, 8);
    assert.ok(generated.key.includes(generated.prefix));
  });

  test('produces a different key every time', () => {
    assert.notStrictEqual(generateApiKey().key, generateApiKey().key);
  });

  test('the stored hash is not the key', () => {
    const generated = generateApiKey();
    assert.notStrictEqual(generated.hash, generated.key);
    assert.strictEqual(generated.hash, hashApiKey(generated.key));
  });
});

describe('parseApiKey', () => {
  test('splits a key into prefix and secret', () => {
    const generated = generateApiKey();
    const parsed = parseApiKey(generated.key);
    assert.strictEqual(parsed.prefix, generated.prefix);
    assert.ok(parsed.secret.length > 0);
  });

  test('rejects a key without the right shape', () => {
    assert.strictEqual(parseApiKey('nope'), null);
    assert.strictEqual(parseApiKey('lk_onlyprefix'), null);
    assert.strictEqual(parseApiKey(''), null);
  });
});

describe('isApiKeyShape', () => {
  test('accepts a generated key', () => {
    assert.strictEqual(isApiKeyShape(generateApiKey().key), true);
  });

  test('rejects a random string', () => {
    assert.strictEqual(isApiKeyShape('Bearer sometoken'), false);
  });
});

describe('maskKey', () => {
  test('keeps the prefix visible and hides the secret', () => {
    const generated = generateApiKey();
    const masked = maskKey(generated.key);
    assert.ok(masked.startsWith('lk_'));
    assert.ok(masked.includes(generated.prefix));
    assert.ok(!masked.includes(generated.hash));
  });
});

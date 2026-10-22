const { describe, test } = require('node:test');
const assert = require('node:assert');
const { canonicalizeUrl, registrableDomain, isSameCanonical } = require('../utils/canonical');

describe('canonicalizeUrl', () => {
  test('lowercases the host and strips www', () => {
    const r = canonicalizeUrl('https://WWW.Example.COM/Path');
    assert.strictEqual(r.canonical, 'https://example.com/Path');
    assert.strictEqual(r.host, 'example.com');
  });

  test('removes the default port', () => {
    assert.strictEqual(canonicalizeUrl('http://example.com:80/a').canonical, 'https://example.com/a');
    assert.strictEqual(canonicalizeUrl('https://example.com:443/a').canonical, 'https://example.com/a');
  });

  test('forces https for identity purposes', () => {
    assert.strictEqual(canonicalizeUrl('http://example.com/a').canonical, 'https://example.com/a');
  });

  test('removes a trailing slash except on the root', () => {
    assert.strictEqual(canonicalizeUrl('https://example.com/docs/').canonical, 'https://example.com/docs');
    assert.strictEqual(canonicalizeUrl('https://example.com/').canonical, 'https://example.com/');
  });

  test('strips tracking parameters and keeps meaningful ones', () => {
    const r = canonicalizeUrl('https://example.com/p?utm_source=twitter&utm_medium=social&id=42&fbclid=abc');
    assert.strictEqual(r.canonical, 'https://example.com/p?id=42');
  });

  test('sorts remaining query parameters so order does not matter', () => {
    const a = canonicalizeUrl('https://example.com/p?b=2&a=1').canonical;
    const b = canonicalizeUrl('https://example.com/p?a=1&b=2').canonical;
    assert.strictEqual(a, b);
  });

  test('drops playback-style hashes but keeps meaningful ones', () => {
    assert.strictEqual(canonicalizeUrl('https://example.com/watch#t=30').canonical, 'https://example.com/watch');
    assert.strictEqual(canonicalizeUrl('https://example.com/docs#install').canonical, 'https://example.com/docs#install');
  });

  test('collapses YouTube watch links onto youtu.be', () => {
    assert.strictEqual(
      canonicalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').canonical,
      'https://youtu.be/dQw4w9WgXcQ'
    );
    assert.strictEqual(
      canonicalizeUrl('https://youtu.be/dQw4w9WgXcQ').canonical,
      'https://youtu.be/dQw4w9WgXcQ'
    );
    assert.strictEqual(
      canonicalizeUrl('https://youtube.com/shorts/abc123').canonical,
      'https://youtu.be/abc123'
    );
  });

  test('unwraps google.com/url?q=', () => {
    assert.strictEqual(
      canonicalizeUrl('https://www.google.com/url?q=https://example.com/page&sa=U').canonical,
      'https://example.com/page'
    );
  });

  test('rejects non-http schemes, credentials and garbage', () => {
    assert.strictEqual(canonicalizeUrl('javascript:alert(1)'), null);
    assert.strictEqual(canonicalizeUrl('file:///etc/passwd'), null);
    assert.strictEqual(canonicalizeUrl('data:text/html,<h1>x'), null);
    assert.strictEqual(canonicalizeUrl('https://user:pass@example.com/'), null);
    assert.strictEqual(canonicalizeUrl('not a url'), null);
    assert.strictEqual(canonicalizeUrl(''), null);
    assert.strictEqual(canonicalizeUrl(null), null);
  });
});

describe('isSameCanonical', () => {
  test('treats url variants as the same page', () => {
    assert.ok(isSameCanonical('http://example.com', 'https://example.com/'));
    assert.ok(isSameCanonical('https://example.com/a?utm_source=x', 'https://example.com/a'));
    assert.ok(!isSameCanonical('https://example.com/a', 'https://example.com/b'));
  });
});

describe('registrableDomain', () => {
  test('returns the registrable domain', () => {
    assert.strictEqual(registrableDomain('docs.google.com'), 'google.com');
    assert.strictEqual(registrableDomain('example.co.uk'), 'example.co.uk');
    assert.strictEqual(registrableDomain('youtu.be'), 'youtu.be');
  });
});

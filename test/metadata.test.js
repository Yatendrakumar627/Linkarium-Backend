const { describe, test } = require('node:test');
const assert = require('node:assert');
const { siteNameFromHostname, cleanTitle, isHttpUrl, registrableLabel, pathSlugName, isKnownBrand, productName } = require('../utils/metadata');
const { normalizeUrl } = require('../utils/helpers');

describe('registrableLabel', () => {
  test('extracts the brand label ignoring subdomains and TLDs', () => {
    assert.strictEqual(registrableLabel('gemini.google.com'), 'google');
    assert.strictEqual(registrableLabel('docs.google.com'), 'google');
    assert.strictEqual(registrableLabel('mail.google.co.uk'), 'google');
    assert.strictEqual(registrableLabel('github.com'), 'github');
    assert.strictEqual(registrableLabel('chatgpt.com'), 'chatgpt');
    assert.strictEqual(registrableLabel('www.linkedin.com'), 'linkedin');
  });

  test('handles multi-segment and uncommon public suffixes via PSL', () => {
    assert.strictEqual(registrableLabel('example.co.uk'), 'example');
    assert.strictEqual(registrableLabel('example.co.kr'), 'example');
    assert.strictEqual(registrableLabel('mail.google.com.cn'), 'google');
    assert.strictEqual(registrableLabel('myshop.xyz'), 'myshop');
    assert.strictEqual(registrableLabel('biz.cloud'), 'biz');
  });

  test('treats private multi-tenant suffixes as subdomains', () => {
    assert.strictEqual(registrableLabel('mysite.blogspot.com'), 'mysite');
    assert.strictEqual(registrableLabel('foo.github.io'), 'foo');
    assert.strictEqual(registrableLabel('site.appspot.com'), 'site');
  });

  test('strips port', () => {
    assert.strictEqual(registrableLabel('example.com:8080'), 'example');
    assert.strictEqual(registrableLabel('localhost:3000'), 'localhost');
  });

  test('returns empty for empty input', () => {
    assert.strictEqual(registrableLabel(''), '');
    assert.strictEqual(registrableLabel(null), '');
  });
});

describe('siteNameFromHostname', () => {
  test('prefers brand over subdomain for known sites', () => {
    assert.strictEqual(siteNameFromHostname('gemini.google.com'), 'Google');
    assert.strictEqual(siteNameFromHostname('docs.google.com'), 'Google');
    assert.strictEqual(siteNameFromHostname('www.youtube.com'), 'YouTube');
    assert.strictEqual(siteNameFromHostname('github.com'), 'GitHub');
    assert.strictEqual(siteNameFromHostname('chatgpt.com'), 'ChatGPT');
    assert.strictEqual(siteNameFromHostname('www.linkedin.com'), 'LinkedIn');
  });

  test('strips port and protocol', () => {
    assert.strictEqual(siteNameFromHostname('localhost:3000'), 'Localhost');
    assert.strictEqual(siteNameFromHostname('example.com:8080'), 'Example');
  });

  test('handles multi-segment public suffixes', () => {
    assert.strictEqual(siteNameFromHostname('example.co.uk'), 'Example');
    assert.strictEqual(siteNameFromHostname('example.com.au'), 'Example');
    assert.strictEqual(siteNameFromHostname('mysite.blogspot.com'), 'Mysite');
    assert.strictEqual(siteNameFromHostname('foo.github.io'), 'Foo');
  });

  test('title-cases unknown single-segment labels', () => {
    assert.strictEqual(siteNameFromHostname('example.com'), 'Example');
    assert.strictEqual(siteNameFromHostname('developer.example.com'), 'Example');
  });

  test('returns empty for empty input', () => {
    assert.strictEqual(siteNameFromHostname(''), '');
    assert.strictEqual(siteNameFromHostname(null), '');
  });
});

describe('isKnownBrand', () => {
  test('recognizes known brand domains regardless of subdomain', () => {
    assert.strictEqual(isKnownBrand('gemini.google.com'), true);
    assert.strictEqual(isKnownBrand('docs.google.com'), true);
    assert.strictEqual(isKnownBrand('github.com'), true);
    assert.strictEqual(isKnownBrand('trustmrr.com'), false);
  });
});

describe('productName', () => {
  test('Google: path prefix names the product', () => {
    assert.strictEqual(productName('google', 'docs.google.com', '/spreadsheets/d/abc/edit'), 'Spreadsheets');
    assert.strictEqual(productName('google', 'docs.google.com', '/document/d/abc/edit'), 'Document');
    assert.strictEqual(productName('google', 'docs.google.com', '/forms/d/abc/edit'), 'Forms');
  });

  test('Google: subdomain names the product when path is generic', () => {
    assert.strictEqual(productName('google', 'gemini.google.com', '/app/09fc2923bd3f14f0'), 'Gemini');
    assert.strictEqual(productName('google', 'mail.google.com', '/'), 'Gmail');
    assert.strictEqual(productName('google', 'calendar.google.com', '/r/week'), 'Calendar');
  });

  test('Google: recognized subdomain product preferred over generic path', () => {
    assert.strictEqual(productName('google', 'maps.google.com', '/'), 'Maps');
  });

  test('Google: ignored/generic subdomains and unknown paths fall back to null', () => {
    assert.strictEqual(productName('google', 'www.google.com', '/'), null);
    assert.strictEqual(productName('google', 'accounts.google.com', '/'), null);
    assert.strictEqual(productName('google', 'tools.google.com', '/'), null);
  });

  test('Google: id-like path segments are not treated as products', () => {
    assert.strictEqual(productName('google', 'gemini.google.com', '/09fc2923bd3f14f0'), 'Gemini');
  });

  test('generalizes to other multi-product brands', () => {
    assert.strictEqual(productName('microsoft', 'azure.microsoft.com', '/'), 'Azure');
    assert.strictEqual(productName('amazon', 'aws.amazon.com', '/'), 'AWS');
    assert.strictEqual(productName('apple', 'icloud.apple.com', '/'), 'iCloud');
  });

  test('returns null for unknown or unconfigured brands', () => {
    assert.strictEqual(productName('google', 'foo.google.com', '/'), null);
    assert.strictEqual(productName('github', 'github.com', '/'), null);
    assert.strictEqual(productName('nope', 'nope.com', '/'), null);
  });
});

describe('pathSlugName', () => {
  test('extracts a readable last path segment', () => {
    assert.strictEqual(pathSlugName('https://trustmrr.com/startup/tortolitos'), 'Tortolitos');
    assert.strictEqual(pathSlugName('https://example.com/blog/my-awesome-post'), 'My Awesome Post');
  });

  test('rejects ids/hashes/tokens', () => {
    assert.strictEqual(pathSlugName('https://example.com/app/09fc2923bd3f14f0'), '');
    assert.strictEqual(
      pathSlugName('https://example.com/items/9b2a3c4d-1111-2222-3333-444455556666'),
      ''
    );
    assert.strictEqual(pathSlugName('https://example.com/order/1234567890'), '');
  });

  test('returns empty for invalid urls and empty paths', () => {
    assert.strictEqual(pathSlugName('not a url'), '');
    assert.strictEqual(pathSlugName('https://example.com'), '');
    assert.strictEqual(pathSlugName(''), '');
  });
});

describe('cleanTitle', () => {
  test('trims and collapses whitespace', () => {
    assert.strictEqual(cleanTitle('  Hello   World  '), 'Hello World');
  });

  test('cuts trailing brand separators', () => {
    assert.strictEqual(cleanTitle('Some Page - Brand'), 'Some Page');
    assert.strictEqual(cleanTitle('Another | SiteName'), 'Another');
  });

  test('returns empty for empty input', () => {
    assert.strictEqual(cleanTitle(''), '');
    assert.strictEqual(cleanTitle(null), '');
  });
});

describe('isHttpUrl', () => {
  test('accepts http/https and rejects others', () => {
    assert.strictEqual(isHttpUrl('https://a.com'), true);
    assert.strictEqual(isHttpUrl('http://a.com'), true);
    assert.strictEqual(isHttpUrl('ftp://a.com'), false);
    assert.strictEqual(isHttpUrl('not a url'), false);
    assert.strictEqual(isHttpUrl(''), false);
  });
});

describe('normalizeUrl + isHttpUrl integration', () => {
  test('normalizeUrl adds https and remains a valid http url', () => {
    assert.strictEqual(isHttpUrl(normalizeUrl('chatgpt.com')), true);
    assert.strictEqual(isHttpUrl(normalizeUrl('ftp://x.com')), false);
  });
});

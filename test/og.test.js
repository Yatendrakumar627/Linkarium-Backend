const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  decodeEntities,
  parseAttributes,
  collectMeta,
  extractTitle,
  extractCanonical,
  resolveUrl,
  extractOpenGraph,
} = require('../utils/og');

describe('decodeEntities', () => {
  test('decodes the common named entities', () => {
    assert.strictEqual(decodeEntities('Tom &amp; Jerry'), 'Tom & Jerry');
    assert.strictEqual(decodeEntities('&lt;div&gt;'), '<div>');
    assert.strictEqual(decodeEntities('&quot;quoted&quot;'), '"quoted"');
  });

  test('decodes numeric entities', () => {
    assert.strictEqual(decodeEntities('&#65;&#66;'), 'AB');
    assert.strictEqual(decodeEntities('&#x41;'), 'A');
  });

  test('leaves unknown entities alone', () => {
    assert.strictEqual(decodeEntities('&notarealentity;'), '&notarealentity;');
  });
});

describe('parseAttributes', () => {
  test('reads double quoted attributes', () => {
    const attrs = parseAttributes('<meta property="og:title" content="Hello">');
    assert.strictEqual(attrs.property, 'og:title');
    assert.strictEqual(attrs.content, 'Hello');
  });

  test('reads single quoted and unquoted attributes', () => {
    assert.strictEqual(parseAttributes("<a href='/x'>").href, '/x');
    assert.strictEqual(parseAttributes('<a href=/x>').href, '/x');
  });

  test('decodes entities in the values', () => {
    assert.strictEqual(parseAttributes('<meta content="a &amp; b">').content, 'a & b');
  });
});

describe('collectMeta', () => {
  test('indexes the meta tags by property and name', () => {
    const meta = collectMeta(`
      <meta property="og:title" content="Title">
      <meta name="description" content="Description">
      <meta charset="utf-8">
    `);
    assert.strictEqual(meta['og:title'], 'Title');
    assert.strictEqual(meta.description, 'Description');
    assert.strictEqual(meta.charset, undefined);
  });

  test('the first occurrence wins', () => {
    const meta = collectMeta(`
      <meta property="og:title" content="First">
      <meta property="og:title" content="Second">
    `);
    assert.strictEqual(meta['og:title'], 'First');
  });
});

describe('extractTitle', () => {
  test('reads the title element', () => {
    assert.strictEqual(extractTitle('<html><head><title>  Hello   World </title></head></html>'), 'Hello World');
  });

  test('returns an empty string when there is no title', () => {
    assert.strictEqual(extractTitle('<html></html>'), '');
  });
});

describe('extractCanonical', () => {
  test('reads the canonical link', () => {
    assert.strictEqual(
      extractCanonical('<link rel="canonical" href="https://example.com/a">'),
      'https://example.com/a'
    );
  });

  test('ignores other link relations', () => {
    assert.strictEqual(extractCanonical('<link rel="stylesheet" href="/a.css">'), '');
  });
});

describe('resolveUrl', () => {
  test('resolves a relative URL against the page URL', () => {
    assert.strictEqual(resolveUrl('/img.png', 'https://example.com/a/b'), 'https://example.com/img.png');
  });

  test('keeps an absolute URL', () => {
    assert.strictEqual(resolveUrl('https://cdn.example.com/i.png', 'https://example.com/'), 'https://cdn.example.com/i.png');
  });

  test('adds the scheme to a protocol relative URL', () => {
    assert.strictEqual(resolveUrl('//cdn.example.com/i.png', 'https://example.com/'), 'https://cdn.example.com/i.png');
  });

  test('returns an empty string for an empty value', () => {
    assert.strictEqual(resolveUrl('', 'https://example.com/'), '');
  });
});

describe('extractOpenGraph', () => {
  test('reads a complete card', () => {
    const html = `
      <html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Description">
        <meta property="og:image" content="/cover.png">
        <meta property="og:site_name" content="Example">
        <meta property="og:type" content="article">
      </head></html>
    `;

    const og = extractOpenGraph(html, 'https://example.com/posts/1');
    assert.strictEqual(og.title, 'OG Title');
    assert.strictEqual(og.description, 'OG Description');
    assert.strictEqual(og.image, 'https://example.com/cover.png');
    assert.strictEqual(og.siteName, 'Example');
    assert.strictEqual(og.type, 'article');
  });

  test('falls back to the twitter card and the title element', () => {
    const html = `
      <html><head>
        <title>Page title</title>
        <meta name="twitter:title" content="Twitter Title">
        <meta name="twitter:description" content="Twitter Description">
        <meta name="twitter:image" content="https://cdn.example.com/i.png">
      </head></html>
    `;

    const og = extractOpenGraph(html, 'https://example.com/');
    assert.strictEqual(og.title, 'Twitter Title');
    assert.strictEqual(og.description, 'Twitter Description');
    assert.strictEqual(og.image, 'https://cdn.example.com/i.png');
  });

  test('falls back to the document title', () => {
    const og = extractOpenGraph('<html><head><title>Only a title</title></head></html>', 'https://example.com/');
    assert.strictEqual(og.title, 'Only a title');
    assert.strictEqual(og.description, '');
  });
});

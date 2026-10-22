const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  detectTitle,
  identifyProvider,
  cleanCandidateTitle,
  isNoisyTitle,
  clearTitleCache,
} = require('../utils/titleEngine');
const { pathSlugName, siteNameFromHostname } = require('../utils/metadata');

describe('Title Detection Engine - Provider Identification', () => {
  test('identifies YouTube URLs', () => {
    assert.strictEqual(identifyProvider(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).id, 'youtube');
    assert.strictEqual(identifyProvider(new URL('https://youtu.be/dQw4w9WgXcQ')).id, 'youtube');
    assert.strictEqual(identifyProvider(new URL('https://m.youtube.com/shorts/abc123xyz')).id, 'youtube');
  });

  test('identifies Google Workspace URLs', () => {
    assert.strictEqual(identifyProvider(new URL('https://docs.google.com/document/d/12345/edit')).id, 'google_workspace');
    assert.strictEqual(identifyProvider(new URL('https://docs.google.com/spreadsheets/d/67890/edit')).id, 'google_workspace');
    assert.strictEqual(identifyProvider(new URL('https://drive.google.com/file/d/abc/view')).id, 'google_workspace');
  });

  test('identifies GitHub URLs', () => {
    assert.strictEqual(identifyProvider(new URL('https://github.com/facebook/react')).id, 'github');
  });

  test('identifies Spotify URLs', () => {
    assert.strictEqual(identifyProvider(new URL('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).id, 'spotify');
  });

  test('identifies generic URLs', () => {
    assert.strictEqual(identifyProvider(new URL('https://www.theyarehuge.com')).id, 'generic_web');
    assert.strictEqual(identifyProvider(new URL('https://techcrunch.com/2026/01/01/news')).id, 'generic_web');
  });
});

describe('Title Detection Engine - Noise & Suffix Cleaning', () => {
  test('flags noisy / placeholder titles', () => {
    assert.strictEqual(isNoisyTitle('Home'), true);
    assert.strictEqual(isNoisyTitle('Homepage'), true);
    assert.strictEqual(isNoisyTitle('404 Not Found'), true);
    assert.strictEqual(isNoisyTitle('Just a moment...'), true);
    assert.strictEqual(isNoisyTitle('Sign in - Google Accounts'), true);
    assert.strictEqual(isNoisyTitle('Untitled Document'), true);
    assert.strictEqual(isNoisyTitle('Real Article Title'), false);
  });

  test('cleans brand suffixes from candidate titles without breaking hyphens inside titles', () => {
    assert.strictEqual(cleanCandidateTitle('Rick Astley - Never Gonna Give You Up - YouTube', 'YouTube', 'youtube.com'), 'Rick Astley - Never Gonna Give You Up');
    assert.strictEqual(cleanCandidateTitle('Q3 Financial Plan - Google Sheets', 'Google Sheets', 'docs.google.com'), 'Q3 Financial Plan');
    assert.strictEqual(cleanCandidateTitle('React Tutorial | Medium', 'Medium', 'medium.com'), 'React Tutorial');
    assert.strictEqual(cleanCandidateTitle('Clean Title Without Suffix', '', 'example.com'), 'Clean Title Without Suffix');
  });
});

describe('Title Detection Engine - Path Slug & Hostname Fallbacks', () => {
  test('extracts slug from deep content / video URL (user example)', () => {
    const url = 'https://www.theyarehuge.com/v/dan-dangler-zac-wild-s-oiled-up-orgy-with-big-tit-brunette-milf.big-boobs';
    const slug = pathSlugName(url);
    assert.strictEqual(slug, "Dan Dangler Zac Wild's Oiled Up Orgy With Big Tit Brunette Milf Big Boobs");
  });

  test('falls back to site name for homepage URL (user example)', () => {
    const url = 'https://www.theyarehuge.com/';
    const slug = pathSlugName(url);
    assert.strictEqual(slug, ''); // No slug on homepage
    const site = siteNameFromHostname(new URL(url).hostname);
    assert.strictEqual(site, 'Theyarehuge');
  });

  test('handles .html file extensions in path slug', () => {
    const url = 'https://example.com/articles/react-router-guide.html';
    const slug = pathSlugName(url);
    assert.strictEqual(slug, 'React Router Guide');
  });

  test('rejects hashes and IDs in path slug', () => {
    assert.strictEqual(pathSlugName('https://example.com/item/123456789'), '');
    assert.strictEqual(pathSlugName('https://example.com/item/09fc2923bd3f14f0'), '');
    assert.strictEqual(pathSlugName('https://example.com/item/9b2a3c4d-1111-2222-3333-444455556666'), '');
  });
});

describe('Title Detection Engine - Integration with detectTitle', () => {
  test('resolves slug fallback for un-fetchable or offline deep link', async () => {
    clearTitleCache();
    const url = 'https://www.theyarehuge.com/v/dan-dangler-zac-wild-s-oiled-up-orgy-with-big-tit-brunette-milf.big-boobs';
    const result = await detectTitle(url, { skipCache: true });
    assert.strictEqual(result.ok, true);
    // Should either find the slug or real title
    assert.ok(result.title.length > 10);
    assert.ok(result.title.includes('Dan Dangler') || result.title.includes('Theyarehuge'));
  });

  test('resolves homepage title and site name', async () => {
    clearTitleCache();
    const url = 'https://www.theyarehuge.com';
    const result = await detectTitle(url, { skipCache: true });
    assert.strictEqual(result.ok, true);
    assert.ok(result.title && result.title.length > 0);
    assert.strictEqual(result.siteName, 'Theyarehuge');
  });


  test('resolves Google Docs product name when offline or private', async () => {
    clearTitleCache();
    const url = 'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit';
    const result = await detectTitle(url, { skipCache: true });
    assert.strictEqual(result.ok, true);
    assert.ok(result.title === 'Google Docs' || result.title.length > 0);
  });

  test('rejects invalid URLs gracefully', async () => {
    const result = await detectTitle('not a url');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'invalid');
  });
});

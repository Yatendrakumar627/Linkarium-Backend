const { describe, test } = require('node:test');
const assert = require('node:assert');
const { parseQuery, compileAst, scoreLink, matchesQuery } = require('../utils/querylang');

describe('Large Dataset Search & Edge Cases (100+ items, Link & Exclusion Search)', () => {
  // Generate 150 diverse test link documents representing realistic edge cases
  const dataset = [];
  const domains = ['github.com', 'youtube.com', 'chataibot.pro', 'drive.google.com', 'retrogameszone.com', 'news.ycombinator.com', 'reddit.com', 'wikipedia.org'];

  for (let i = 0; i < 150; i++) {
    const domain = domains[i % domains.length];
    let url = `https://${domain}/item-${i}`;
    if (i === 10) url = 'https://drive.google.com/drive/mobile/folders/1Gi9jhbLRABF2FD6a8KuETTwb1q5uESwA?utm_source=ig&utm_medium=social';
    if (i === 20) url = 'https://chataibot.pro/app/free-chat?variant=new';
    if (i === 30) url = 'https://github.com/facebook/react';
    if (i === 40) url = 'https://retrogameszone.com/games/vice-city/';

    const tags = [];
    if (i % 2 === 0) tags.push('website');
    if (i % 3 === 0) tags.push('dev');
    if (i % 5 === 0) tags.push('ai');
    if (i % 7 === 0) tags.push('games');

    dataset.push({
      _id: `id-${i}`,
      title: i === 30 ? 'React - A JavaScript library for building user interfaces' : `Link Title ${i} ${tags.join(' ')}`,
      url,
      canonicalUrl: url.split('?')[0].replace(/\/$/, ''),
      tags,
      tokens: [domain.split('.')[0], ...tags, `item-${i}`],
      articleTokens: i % 4 === 0 ? ['common', 'word', 'article'] : [],
      visits: i,
      favorite: i % 10 === 0,
      createdAt: new Date(Date.now() - i * 3600000),
    });
  }

  test('Search by link URL with complex tracking query parameters', () => {
    const query = 'https://drive.google.com/drive/mobile/folders/1Gi9jhbLRABF2FD6a8KuETTwb1q5uESwA?utm_source=ig&utm_medium=social';
    const ast = parseQuery(query);
    assert.ok(ast.rawUrl);
    const { filter, hasText } = compileAst(ast);
    assert.strictEqual(hasText, true);

    const matches = dataset.filter((doc) => matchesQuery(doc, ast));
    assert.ok(matches.length >= 1);
    assert.strictEqual(matches[0].url, query);

    const score = scoreLink(matches[0], ast);
    assert.ok(score >= 80, 'Exact URL match should receive high relevance score');
  });

  test('Search by clean URL without protocol', () => {
    const query = 'github.com/facebook/react';
    const ast = parseQuery(query);
    assert.ok(ast.rawUrl || ast.terms.includes('facebook'));

    const matches = dataset.filter((doc) => matchesQuery(doc, ast));
    assert.ok(matches.some((m) => m.url.includes('facebook/react')));
  });

  test('Exclusion search: -link with and without space', () => {
    const ast1 = parseQuery('-link');
    assert.deepStrictEqual(ast1.exclude, ['link']);

    const ast2 = parseQuery('- link');
    assert.deepStrictEqual(ast2.exclude, ['link']);

    const ast3 = parseQuery('- link only');
    assert.deepStrictEqual(ast3.exclude, ['link']);
    assert.ok(ast3.terms.includes('only'));
  });

  test('Search for common words previously dropped by stopwords (website, dev, app)', () => {
    const astWebsite = parseQuery('website');
    assert.deepStrictEqual(astWebsite.terms, ['website']);
    const { hasText: hasTextWebsite } = compileAst(astWebsite);
    assert.strictEqual(hasTextWebsite, true);

    const astDev = parseQuery('dev');
    assert.deepStrictEqual(astDev.terms, ['dev']);

    const matches = dataset.filter((doc) => matchesQuery(doc, astWebsite));
    assert.ok(matches.length > 0 && matches.length < dataset.length, 'Should filter, not return all links');
  });

  test('Search for short technical terms (c++, .net, ai, js, go)', () => {
    const astCpp = parseQuery('c++');
    assert.deepStrictEqual(astCpp.terms, ['cpp']);

    const astNet = parseQuery('.net');
    assert.deepStrictEqual(astNet.terms, ['net']);

    const astAi = parseQuery('ai');
    assert.deepStrictEqual(astAi.terms, ['ai']);

    const matchesAi = dataset.filter((doc) => matchesQuery(doc, astAi));
    assert.ok(matchesAi.length > 0);
    // All matched items should actually have 'ai' in title, tags, or tokens
    for (const m of matchesAi) {
      const hasAi = m.tags.includes('ai') || m.tokens.includes('ai') || m.title.toLowerCase().includes('ai');
      assert.ok(hasAi, `Item ${m.title} should have ai`);
    }
  });

  test('Relevance ranking over 100+ items', () => {
    const ast = parseQuery('react');
    const scored = dataset
      .map((doc) => ({ doc, score: scoreLink(doc, ast) }))
      .sort((a, b) => b.score - a.score);

    assert.strictEqual(scored[0].doc.url, 'https://github.com/facebook/react');
  });
});

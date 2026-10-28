const { describe, test } = require('node:test');
const assert = require('node:assert');
const { parseQuery, compileAst, scoreLink, matchesPhrases } = require('../utils/querylang');

describe('parseQuery', () => {
  test('collects free text terms', () => {
    const ast = parseQuery('react hooks');
    assert.deepStrictEqual(ast.terms, ['react', 'hooks']);
    assert.deepStrictEqual(ast.phrases, []);
  });

  test('parses tags, domains and collections', () => {
    const ast = parseQuery('tag:ai domain:youtube.com collection:Work');
    assert.deepStrictEqual(ast.tags, ['ai']);
    assert.deepStrictEqual(ast.domains, ['youtube.com']);
    assert.deepStrictEqual(ast.collections, ['work']);
  });

  test('normalises a domain written as a full URL', () => {
    assert.deepStrictEqual(parseQuery('domain:https://www.youtube.com/watch').domains, ['youtube.com']);
  });

  test('parses flags, comparisons and dates', () => {
    const ast = parseQuery('is:favorite visits:>10 after:2026-01-01 before:2026-02-01');
    assert.deepStrictEqual(ast.flags, ['favorite']);
    assert.deepStrictEqual(ast.visits, [{ op: '>', value: 10 }]);
    assert.strictEqual(ast.after.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.strictEqual(ast.before.toISOString(), '2026-02-01T00:00:00.000Z');
  });

  test('parses relative dates', () => {
    const ast = parseQuery('after:7d');
    assert.ok(ast.after instanceof Date);
    assert.ok(Date.now() - ast.after.getTime() > 6.9 * 24 * 3600 * 1000);
  });

  test('keeps quoted text as a phrase', () => {
    const ast = parseQuery('"state management"');
    assert.deepStrictEqual(ast.phrases, ['state management']);
  });

  test('collects exclusions', () => {
    assert.deepStrictEqual(parseQuery('-draft notes').exclude, ['draft']);
  });

  test('degrades unknown operators to free text instead of failing', () => {
    const ast = parseQuery('https://example.com/page');
    assert.strictEqual(ast.operators.length, 0);
    assert.ok(ast.terms.includes('example'));
  });

  test('never throws on garbage', () => {
    assert.doesNotThrow(() => parseQuery(':::: >>><< is: visits: after: tag:'));
  });

  test('records the raw source text of every operator (for removable chips)', () => {
    const ast = parseQuery('tag:ai is:favorite');
    assert.strictEqual(ast.operators[0].raw, 'tag:ai');
    assert.strictEqual(ast.operators[1].raw, 'is:favorite');
  });
});

describe('compileAst', () => {
  test('combines the base filter with the parsed operators', () => {
    const ast = parseQuery('tag:ai is:favorite');
    const { filter } = compileAst(ast, { user: 'u1', deletedAt: null });
    assert.strictEqual(filter.$and[0].user, 'u1');
    assert.deepStrictEqual(filter.$and[1], { tags: { $all: ['ai'] } });
    assert.deepStrictEqual(filter.$and[2], { favorite: true });
  });

  test('text queries become prefix lookups on the token index', () => {
    const ast = parseQuery('react');
    const { filter, hasText } = compileAst(ast, { user: 'u1' });
    assert.ok(hasText);
    // A term matches the metadata tokens or the tokens of the article body.
    assert.deepStrictEqual(filter.$and[1], {
      $or: [{ tokens: { $regex: '^react' } }, { articleTokens: { $regex: '^react' } }],
    });
  });

  test('a query without free text is not a text query', () => {
    const { hasText } = compileAst(parseQuery('tag:ai'), { user: 'u1' });
    assert.strictEqual(hasText, false);
  });

  test('multiple tags require every tag, not just one of them', () => {
    const ast = parseQuery('tag:ai tag:react');
    const { filter } = compileAst(ast, { user: 'u1' });
    assert.deepStrictEqual(filter.$and[1], { tags: { $all: ['ai', 'react'] } });
  });

  test('exclusions are compiled as a negated token match', () => {
    const ast = parseQuery('-draft');
    const { filter } = compileAst(ast, { user: 'u1' });
    // The term must appear in neither token set.
    assert.deepStrictEqual(filter.$and[1], {
      $nor: [{ tokens: { $regex: '^draft' } }, { articleTokens: { $regex: '^draft' } }],
    });
  });

  test('domains match the host or the registrable domain', () => {
    const ast = parseQuery('domain:google.com');
    const { filter } = compileAst(ast, { user: 'u1' });
    assert.deepStrictEqual(filter.$and[1], {
      $or: [{ host: { $in: ['google.com'] } }, { hostLabel: { $in: ['google.com'] } }],
    });
  });

  test('compiles health status flags: is:broken and is:healthy', () => {
    const ast = parseQuery('is:broken');
    const { filter } = compileAst(ast, { user: 'u1' });
    assert.deepStrictEqual(filter.$and[1], { 'health.status': 'broken' });

    const healthyAst = parseQuery('is:healthy');
    const healthyCompiled = compileAst(healthyAst, { user: 'u1' });
    assert.deepStrictEqual(healthyCompiled.filter.$and[1], { 'health.status': 'healthy' });
  });

  test('compiles is:stale flag to lastOkAt comparison', () => {
    const ast = parseQuery('is:stale');
    const { filter } = compileAst(ast, { user: 'u1' });
    assert.ok(Array.isArray(filter.$and[1].$or));
    assert.strictEqual(filter.$and[1].$or[1]['health.lastOkAt'], null);
  });
});

describe('scoreLink', () => {
  const doc = {
    title: 'React hooks guide',
    url: 'https://example.com/react-hooks',
    description: 'A guide',
    tags: ['react'],
    visits: 10,
    createdAt: new Date(),
  };

  test('title matches outrank description matches', () => {
    const titleHit = scoreLink({ ...doc, description: '' }, parseQuery('react'));
    const descHit = scoreLink({ ...doc, title: 'Something else', url: 'https://example.com' }, parseQuery('react'));
    assert.ok(titleHit > descHit);
  });

  test('an exact tag match adds a strong boost', () => {
    const withTag = scoreLink(doc, parseQuery('tag:react'));
    const withoutTag = scoreLink({ ...doc, tags: [] }, parseQuery('tag:react'));
    assert.ok(withTag > withoutTag);
  });
});

describe('matchesPhrases', () => {
  test('requires the exact phrase to be present', () => {
    const doc = { title: 'State management in React', description: '', url: '' };
    assert.ok(matchesPhrases(doc, ['state management']));
    assert.ok(!matchesPhrases(doc, ['management state']));
  });
});

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { stripNoise, extractElement, htmlToText, extractArticle } = require('../utils/article');

describe('stripNoise', () => {
  test('removes scripts and styles', () => {
    const html = '<body><script>var x = 1;</script><style>p{}</style><p>Kept</p></body>';
    const cleaned = stripNoise(html);
    assert.ok(!cleaned.includes('var x'));
    assert.ok(!cleaned.includes('p{}'));
    assert.ok(cleaned.includes('Kept'));
  });

  test('removes comments', () => {
    assert.ok(!stripNoise('<!-- hidden -->visible').includes('hidden'));
  });
});

describe('extractElement', () => {
  test('returns the inner html of the element', () => {
    assert.strictEqual(extractElement('<div><p>Inside</p></div>', 'div'), '<p>Inside</p>');
  });

  test('honours nested elements', () => {
    const html = '<div>one <div>two</div> three</div>';
    assert.strictEqual(extractElement(html, 'div'), 'one <div>two</div> three');
  });

  test('returns null when the element is missing', () => {
    assert.strictEqual(extractElement('<p>x</p>', 'article'), null);
  });
});

describe('htmlToText', () => {
  test('turns block elements into line breaks', () => {
    assert.strictEqual(htmlToText('<p>One</p><p>Two</p>'), 'One\nTwo');
  });

  test('removes the remaining tags', () => {
    assert.strictEqual(htmlToText('<p>Hello <b>world</b></p>'), 'Hello world');
  });

  test('decodes entities', () => {
    assert.strictEqual(htmlToText('<p>Tom &amp; Jerry</p>'), 'Tom & Jerry');
  });

  test('collapses the whitespace', () => {
    assert.strictEqual(htmlToText('<p>  a   b  </p>'), 'a b');
  });
});

describe('extractArticle', () => {
  test('prefers the article element', () => {
    const html = `
      <html><body>
        <nav>Navigation</nav>
        <article><p>The actual content of the page.</p></article>
      </body></html>
    `;
    const result = extractArticle(html, { minWords: 3 });
    assert.strictEqual(result.strategy, 'article');
    assert.ok(result.text.includes('actual content'));
    assert.ok(!result.text.includes('Navigation'));
  });

  test('falls back to main', () => {
    const html = `
      <html><body>
        <nav>Navigation</nav>
        <main><p>The main region of the page with plenty of words in it so that it counts as real content.</p></main>
      </body></html>
    `;
    const result = extractArticle(html, { minWords: 3 });
    assert.strictEqual(result.strategy, 'main');
    assert.ok(result.text.includes('main region'));
  });

  test('a tiny article element falls back to the body', () => {
    const html = `
      <html><body>
        <article><p>Teaser.</p></article>
        <p>The rest of the page, which is much longer and therefore the real content.</p>
      </body></html>
    `;
    const result = extractArticle(html);
    assert.strictEqual(result.strategy, 'body');
    assert.ok(result.text.includes('real content'));
  });

  test('counts the words', () => {
    const result = extractArticle('<html><body><p>one two three four five</p></body></html>');
    assert.strictEqual(result.wordCount, 5);
  });

  test('caps the text', () => {
    const long = '<p>' + 'word '.repeat(5000) + '</p>';
    const result = extractArticle(long, { maxChars: 100 });
    assert.ok(result.text.length <= 100);
  });

  test('returns nothing for an empty document', () => {
    const result = extractArticle('');
    assert.strictEqual(result.text, '');
    assert.strictEqual(result.wordCount, 0);
  });
});

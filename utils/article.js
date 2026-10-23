// Article text extraction.
//
// Turns an HTML page into the readable text of its main content. The result
// powers reader mode and full-text search inside a link's body.
//
// Deliberately dependency-free: no DOM parser, just a small tag scanner. The
// heuristics are conservative — when in doubt the page is returned as plain
// text rather than being mangled.
//
// This module is pure — it takes HTML and returns an object.

const { decodeEntities } = require('./og');

// Elements that introduce a line break.
const BLOCK_ELEMENTS =
  'address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

// Elements that are never shown to the reader.
const HIDDEN_ELEMENTS = /<(script|style|noscript|template|svg|math|iframe|object|embed|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

// Comments.
const COMMENTS = /<!--[\s\S]*?-->/g;

// The maximum amount of text kept per link.
const MAX_CHARS = 20_000;

/**
 * Remove the elements that never contribute readable text.
 * @param {string} html
 */
function stripNoise(html) {
  return String(html || '')
    .replace(COMMENTS, ' ')
    .replace(HIDDEN_ELEMENTS, ' ');
}

/**
 * Return the inner HTML of the first `<tag>` element, honouring nesting.
 *
 * @param {string} html
 * @param {string} tagName
 * @returns {string|null} the inner HTML, or null when the element is absent
 */
function extractElement(html, tagName) {
  const source = String(html || '');
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const first = openRe.exec(source);
  if (!first) return null;

  const contentStart = first.index + first[0].length;
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');

  let depth = 1;
  let pos = contentStart;

  while (depth > 0) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;

    const nextOpen = openRe.exec(source);
    const nextClose = closeRe.exec(source);
    if (!nextClose) return source.slice(contentStart); // unterminated element

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      pos = openRe.lastIndex;
      continue;
    }

    depth -= 1;
    pos = closeRe.lastIndex;
    if (depth === 0) return source.slice(contentStart, nextClose.index);
  }

  return null;
}

/**
 * Convert HTML into plain text.
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  let text = String(html || '');

  // Block-level tags become line breaks.
  text = text.replace(new RegExp(`</?(${BLOCK_ELEMENTS})\\b[^>]*>`, 'gi'), '\n');
  // Remaining tags are removed.
  text = text.replace(/<[^>]+>/g, ' ');
  // Entities are decoded last, so "&amp;lt;" does not turn into "<".
  text = decodeEntities(text);

  // Collapse the whitespace: at most one space inside a line, no empty lines.
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter((line) => line.length > 0);

  return lines.join('\n');
}

/**
 * Extract the readable article text of a page.
 *
 * Preference order:
 *   1. `<article>` — the semantic "this is the content" element
 *   2. `<main>`    — the semantic "this is the main region" element
 *   3. `<body>`    — everything else
 *
 * @param {string} html
 * @param {{maxChars?: number, minWords?: number}} options
 * @returns {{text: string, wordCount: number, strategy: string}}
 */
function extractArticle(html, options = {}) {
  const { maxChars = MAX_CHARS, minWords = 25 } = options;
  const cleaned = stripNoise(html);

  let content = null;
  let strategy = 'body';

  const article = extractElement(cleaned, 'article');
  if (article) {
    content = article;
    strategy = 'article';
  } else {
    const main = extractElement(cleaned, 'main');
    if (main) {
      content = main;
      strategy = 'main';
    } else {
      const body = extractElement(cleaned, 'body');
      content = body !== null ? body : cleaned;
    }
  }

  let text = htmlToText(content);
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

  // A tiny <article> is usually a teaser, not the content. Fall back to the
  // body in that case.
  if (strategy !== 'body' && wordCount < minWords) {
    const body = extractElement(cleaned, 'body');
    const fallback = htmlToText(body !== null ? body : cleaned);
    const fallbackWords = fallback ? fallback.split(/\s+/).filter(Boolean).length : 0;
    if (fallbackWords > wordCount) {
      text = fallback;
      strategy = 'body';
      return {
        text: text.slice(0, maxChars),
        wordCount: fallbackWords,
        strategy,
      };
    }
  }

  return {
    text: text.slice(0, maxChars),
    wordCount,
    strategy,
  };
}

module.exports = {
  stripNoise,
  extractElement,
  htmlToText,
  extractArticle,
  MAX_CHARS,
};

// Link enrichment.
//
// Fetches a saved page once and extracts the two things that make a bookmark
// worth revisiting: the OpenGraph card (title, description, preview image) and
// the readable article text (for reader mode and full-text search).
//
// All fetches go through the SSRF guard — see utils/fetcher.js.

const { safeFetch } = require('./fetcher');
const { extractOpenGraph } = require('./og');
const { extractArticle } = require('./article');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Fetch and parse a page.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, maxBytes?: number, article?: boolean}} options
 * @returns {Promise<{ok: boolean, og: object|null, article: object|null,
 *                    finalUrl: string|null, error: string|null, errorKind: string|null}>}
 */
async function fetchAndExtract(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    article = true,
  } = options;

  const result = await safeFetch(url, { method: 'GET', timeoutMs, maxBytes });

  if (!result.ok) {
    return {
      ok: false,
      og: null,
      article: null,
      finalUrl: result.finalUrl || null,
      error: result.error || 'Could not fetch the page.',
      errorKind: result.errorKind || null,
    };
  }

  // A non-HTML response (a PDF, an image) has no metadata to read.
  if (result.contentType && !/text\/html|application\/xhtml\+xml/i.test(result.contentType)) {
    return {
      ok: false,
      og: null,
      article: null,
      finalUrl: result.finalUrl || null,
      error: `Unsupported content type: ${result.contentType}`,
      errorKind: 'content-type',
    };
  }

  const html = result.text || '';
  const og = extractOpenGraph(html, result.finalUrl || url);
  const articleData = article ? extractArticle(html) : { text: '', wordCount: 0, strategy: 'skipped' };

  return {
    ok: true,
    og,
    article: articleData,
    finalUrl: result.finalUrl || url,
    error: null,
    errorKind: null,
  };
}

/**
 * Build the `og` / `article` sub-documents for a link from an extraction.
 *
 * @param {object} extraction the result of fetchAndExtract
 * @param {Date} now
 */
function buildEnrichment(extraction, now = new Date()) {
  const og = {
    title: extraction.og?.title || '',
    description: extraction.og?.description || '',
    image: extraction.og?.image || '',
    favicon: extraction.og?.favicon || '',
    siteName: extraction.og?.siteName || '',
    type: extraction.og?.type || '',
    fetchedAt: now,
    error: '',
  };

  const article = {
    text: extraction.article?.text || '',
    wordCount: extraction.article?.wordCount || 0,
    extractedAt: now,
  };

  return { og, article };
}

module.exports = {
  fetchAndExtract,
  buildEnrichment,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
};

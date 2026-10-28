// Text utilities shared by the search index, the query language parser and the
// (planned) auto-tagging engine.
//
// Everything here is deliberately dependency-free and Unicode aware: titles
// and descriptions are not always English, so splitting on `[^\p{L}\p{N}]`
// keeps non-latin words intact instead of shredding them into empty strings.

// Common English words plus web noise. Removed from the searchable token set so
// that "the" or "com" never dominates a query.
const STOPWORDS = new Set(
  [
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
    'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
    'can', 'could',
    'did', 'do', 'does', 'doing', 'down', 'during',
    'each', 'few', 'for', 'from', 'further',
    'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
    'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
    'just',
    'me', 'more', 'most', 'my', 'myself',
    'no', 'nor', 'not', 'now',
    'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
    'same', 'she', 'should', 'so', 'some', 'such',
    'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
    'those', 'through', 'to', 'too',
    'under', 'until', 'up', 'very',
    'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
    'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
    // web / url noise
    'com', 'org', 'net', 'edu', 'gov', 'int', 'info', 'biz', 'co', 'io', 'www', 'http', 'https',
    'html', 'htm', 'php', 'aspx', 'jsp', 'index', 'amp', 'utm',
  ].map((w) => w.toLowerCase())
);

// Split a string into lowercase word tokens. Punctuation (including dots,
// slashes and hyphens) acts as a separator. Combining marks (\p{M}) are kept
// so that scripts such as Devanagari or Arabic are not shredded into
// fragments.
function splitWords(input) {
  if (input === null || input === undefined) return [];
  return String(input)
    .toLowerCase()
    .replace(/\bc\+\+/gi, ' cpp ')
    .replace(/\bc#/gi, ' csharp ')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean);
}

// Turn free text into a deduplicated list of indexable tokens.
function tokenize(input, options = {}) {
  const { stopwords = true, minLength = 2, limit = 40 } = options;
  const out = [];
  const seen = new Set();
  for (const word of splitWords(input)) {
    if (word.length < minLength) continue;
    if (stopwords && STOPWORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

// Tokens for a tag list. Tags are stored lowercased and hyphenated, so
// "machine-learning" must also match a search for "learning".
function tokenizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const tag of tags) {
    for (const word of splitWords(tag)) {
      if (word.length < 2) continue;
      if (STOPWORDS.has(word)) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}

// Escape a string for safe use inside a RegExp.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the searchable token set for a link.
 *
 * Tokens come from the title, the tags, the description, the note and the URL
 * (host + path segments). The result is stored on the document so that search
 * can use an index instead of a regex collection scan.
 */
function buildSearchTokens(link, options = {}) {
  const { limit = 80 } = options;
  const seen = new Set();
  const out = [];

  const push = (words) => {
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
  };

  push(tokenize(link.title));
  push(tokenizeTags(link.tags));
  push(tokenize(link.description, { limit: 40 }));
  // The private note is searchable, but capped so a long note cannot push the
  // title and tags out of the token budget.
  push(tokenize(link.note, { limit: 30 }));

  if (link.url) {
    try {
      const u = new URL(link.url);
      push(tokenize(u.hostname, { stopwords: false }));
      push(tokenize(u.pathname, { limit: 20 }));
    } catch {
      /* not a URL — ignore */
    }
  }

  return out.slice(0, limit);
}

module.exports = { tokenize, tokenizeTags, splitWords, escapeRegex, buildSearchTokens, STOPWORDS };

// OpenGraph / Twitter card metadata extraction.
//
// Deliberately dependency-free: the server has no DOM parser, and the only
// thing we need from a page is its `<meta>` tags and its `<title>`. A small
// tag scanner is enough and keeps the attack surface (and the bundle) small.
//
// This module is pure — it takes HTML and returns an object.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
};

/** Decode HTML entities (named and numeric). */
function decodeEntities(text) {
  if (!text) return '';
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Parse the attributes of a single HTML tag.
 * @param {string} tag e.g. `<meta property="og:title" content="Hi">`
 * @returns {Record<string, string>}
 */
function parseAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;
  let match;
  while ((match = re.exec(String(tag))) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[match[1].toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

/** Collect every `<meta>` tag of a document into a map keyed by property/name. */
function collectMeta(html) {
  const meta = {};
  const re = /<meta\b[^>]*>/gi;
  let match;
  while ((match = re.exec(String(html))) !== null) {
    const attrs = parseAttributes(match[0]);
    const key = attrs.property || attrs.name || attrs.itemprop;
    if (!key) continue;
    const value = attrs.content ?? '';
    if (!value) continue;
    const normalized = key.toLowerCase();
    // The first occurrence wins (that is what browsers do).
    if (!(normalized in meta)) meta[normalized] = value;
  }
  return meta;
}

/** The document title (the contents of the first `<title>` element). */
function extractTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html));
  if (!match) return '';
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
}

/** The canonical URL declared by `<link rel="canonical">`. */
function extractCanonical(html) {
  const re = /<link\b[^>]*>/gi;
  let match;
  while ((match = re.exec(String(html))) !== null) {
    const attrs = parseAttributes(match[0]);
    const rel = String(attrs.rel || '').toLowerCase();
    if (rel.split(/\s+/).includes('canonical') && attrs.href) {
      return attrs.href;
    }
  }
  return '';
}

/** Extract favicon declared by `<link rel="icon|shortcut icon|apple-touch-icon">`. */
function extractFavicon(html, baseUrl = '') {
  const re = /<link\b[^>]*>/gi;
  let match;
  let bestIcon = '';
  let appleIcon = '';

  while ((match = re.exec(String(html))) !== null) {
    const attrs = parseAttributes(match[0]);
    const rel = String(attrs.rel || '').toLowerCase();
    const href = attrs.href;
    if (!href) continue;

    if (rel.includes('apple-touch-icon')) {
      appleIcon = href;
    } else if (rel.includes('icon')) {
      bestIcon = href;
    }
  }

  const chosen = appleIcon || bestIcon;
  return chosen && baseUrl ? resolveUrl(chosen, baseUrl) : chosen || '';
}

/** Resolve a possibly relative URL against the page URL. */
function resolveUrl(value, baseUrl) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  if (/^(https?:)?\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
    // Protocol-relative URLs need the base's scheme.
    if (trimmed.startsWith('//')) {
      try {
        return new URL(`https:${trimmed}`).toString();
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

/**
 * Extract the OpenGraph / Twitter card metadata of a page.
 *
 * @param {string} html
 * @param {string} pageUrl the URL the HTML came from (used to resolve images)
 * @returns {{title: string, description: string, image: string, siteName: string,
 *            type: string, canonical: string}}
 */
/** Extract title / headline from JSON-LD schema if present. */
function extractJsonLdTitle(html) {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(String(html))) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : data && data['@graph'] ? data['@graph'] : [data];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item.headline || item.name || item.title;
        if (typeof candidate === 'string' && candidate.trim()) {
          return decodeEntities(candidate).replace(/\s+/g, ' ').trim();
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }
  return '';
}

function extractOpenGraph(html, pageUrl = '') {
  const source = String(html || '');
  const meta = collectMeta(source);

  const title =
    meta['og:title'] ||
    meta['twitter:title'] ||
    meta['title'] ||
    extractTitle(source) ||
    extractJsonLdTitle(source);

  const description =
    meta['og:description'] ||
    meta['twitter:description'] ||
    meta['description'] ||
    meta['twitter:text'] ||
    '';

  const image =
    meta['og:image:secure_url'] ||
    meta['og:image:url'] ||
    meta['og:image'] ||
    meta['twitter:image'] ||
    meta['twitter:image:src'] ||
    '';

  const siteName = meta['og:site_name'] || meta['application-name'] || '';
  const type = meta['og:type'] || '';

  return {
    title: String(title).replace(/\s+/g, ' ').trim(),
    description: String(description).replace(/\s+/g, ' ').trim(),
    image: pageUrl ? resolveUrl(image, pageUrl) : String(image).trim(),
    favicon: pageUrl ? extractFavicon(source, pageUrl) : '',
    siteName: String(siteName).replace(/\s+/g, ' ').trim(),
    type: String(type).trim(),
    canonical: extractCanonical(source),
  };
}

module.exports = {
  decodeEntities,
  parseAttributes,
  collectMeta,
  extractTitle,
  extractJsonLdTitle,
  extractCanonical,
  extractFavicon,
  resolveUrl,
  extractOpenGraph,
};


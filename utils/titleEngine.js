// server/utils/titleEngine.js
//
// Advanced Link Title Detection Engine.
// Follows link-title-detection-engine.md specification:
// - Provider-aware candidate collection (YouTube, Google Workspace, GitHub, Spotify, Generic Web)
// - SSRF-safe page fetch with strict timeout
// - Deterministic candidate ranking and quality scoring
// - Anti-noise filtering (Cloudflare challenges, 404s, login walls, generic "Home")
// - Suffix / brand normalization
// - URL path slug fallback (deep paths, hyphens, dots, extensions)
// - Hostname / brand fallback for root domains
// - In-memory LRU / TTL caching for speed and upstream protection

const { safeFetch } = require('./fetcher');
const { extractOpenGraph, extractJsonLdTitle } = require('./og');
const {
  siteNameFromHostname,
  registrableLabel,
  productName,
  isKnownBrand,
  isHttpUrl,
  pathSlugName,
  BRAND_NAMES,
} = require('./metadata');
const { normalizeUrl } = require('./helpers');

// TTL in milliseconds
const CACHE_SUCCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_FALLBACK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 1000;

// In-memory LRU-like cache: key -> { data, expiresAt }
const titleCache = new Map();

// In-flight promises to coalesce duplicate concurrent requests
const inFlightRequests = new Map();

const NOISY_TITLE_REGEXES = [
  /^(home|homepage|welcome|index|default|untitled|untitled document|loading)(\s*[-:|•·–—]\s*.*)?$/i,
  /^(400|401|403|404|500|502|503|504)(\s+.*|\s*[-:|•·–—].*)?$/i,
  /^(not found|page not found|access denied|forbidden|error|unauthorized)/i,

  /(just a moment|attention required|ddos protection|security check|cloudflare|checking your browser)/i,
  /^(sign in|log in|login|sign in to your account|google accounts)(\s*[-:|•·–—]\s*.*)?$/i,
  /^please enable (cookies|javascript)/i,
];


function isNoisyTitle(value) {
  if (!value) return true;
  const str = String(value).trim();
  if (str.length < 2) return true;
  return NOISY_TITLE_REGEXES.some((re) => re.test(str));
}

/**
 * Clean a candidate title by removing redundant brand suffixes
 * (e.g. "My Video - YouTube" -> "My Video", "Article Title | Medium" -> "Article Title")
 * while carefully preserving artist/title hyphens (e.g. "Rick Astley - Never Gonna Give You Up").
 */
function cleanCandidateTitle(raw, siteName = '', hostname = '') {
  if (!raw) return '';
  let title = String(raw).replace(/\s+/g, ' ').trim();

  // If title has a trailing site suffix separated by " - ", " | ", " • ", " — "
  const brandSegment = siteName || siteNameFromHostname(hostname);
  const brandKeywords = [
    brandSegment,
    'YouTube',
    'Google Docs',
    'Google Sheets',
    'Google Slides',
    'Google Drive',
    'Wikipedia',
    'Medium',
    'GitHub',
    'LinkedIn',
    'Reddit',
    'Facebook',
    'Twitter',
    'Instagram',
    'Amazon',
    'Netflix',
  ].filter(Boolean);

  for (const b of brandKeywords) {
    const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const suffixRegex = new RegExp(`\\s*[-|•·–—/:]\\s*${escaped}\\s*$`, 'i');
    if (suffixRegex.test(title)) {
      title = title.replace(suffixRegex, '').trim();
      break;
    }
  }

  // If title still has generic trailing site marker (e.g. "Title | Site")
  const genericTrailer = /\s+[|•·–—]\s+[A-Za-z0-9\s._-]{2,30}$/;
  if (genericTrailer.test(title)) {
    title = title.replace(genericTrailer, '').trim();
  }

  return title;
}

// ============================================================================
// PROVIDER ADAPTERS
// ============================================================================

/**
 * 1. YouTube Adapter
 */
const youtubeAdapter = {
  id: 'youtube',
  matches(urlObj) {
    const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'music.youtube.com';
  },
  async getCandidates(url) {
    const candidates = [];
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await safeFetch(oembedUrl, { timeoutMs: 5000, maxBytes: 1024 * 128 });
      if (res.ok && res.text) {
        const data = JSON.parse(res.text);
        if (data?.title) {
          candidates.push({
            value: data.title.trim(),
            source: 'provider_api',
            provider: 'youtube',
            score: 100,
            confidence: 0.98,
            author: data.author_name || null,
            thumbnail: data.thumbnail_url || null,
          });
        }
      }
    } catch {
      // Fallback
    }

    candidates.push({
      value: 'YouTube',
      source: 'hostname',
      provider: 'youtube',
      score: 30,
      confidence: 0.4,
    });

    return candidates;
  },
};

/**
 * 2. Google Workspace Adapter
 */
const googleWorkspaceAdapter = {
  id: 'google_workspace',
  matches(urlObj) {
    const host = urlObj.hostname.toLowerCase();
    return (
      host === 'docs.google.com' ||
      host === 'drive.google.com' ||
      host === 'sheets.google.com' ||
      host === 'slides.google.com' ||
      host === 'forms.google.com'
    );
  },
  async getCandidates(url, urlObj) {
    const candidates = [];
    const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = urlObj.pathname;
    let prod = productName('google', host, pathname) || 'Google Docs';
    if (prod === 'Document') prod = 'Google Docs';
    if (prod === 'Spreadsheets' || prod === 'Sheets') prod = 'Google Sheets';
    if (prod === 'Slides') prod = 'Google Slides';
    if (prod === 'Forms') prod = 'Google Forms';
    if (prod === 'Drive') prod = 'Google Drive';


    // 1. Try public document page fetch
    try {
      const fetchRes = await safeFetch(url, { timeoutMs: 4000, maxBytes: 1024 * 512 });
      if (fetchRes.ok && fetchRes.text) {
        const og = extractOpenGraph(fetchRes.text, fetchRes.finalUrl || url);
        const titleCandidate = og.title || '';
        const cleaned = cleanCandidateTitle(titleCandidate, prod, host);

        if (cleaned && !isNoisyTitle(cleaned) && cleaned.toLowerCase() !== prod.toLowerCase()) {
          candidates.push({
            value: cleaned,
            source: 'og_title',
            provider: 'google_workspace',
            score: 92,
            confidence: 0.92,
            favicon: og.favicon || '',
            description: og.description || '',
          });
        }
      }
    } catch {
      // Ignore fetch error for private docs
    }

    // 2. Product-level fallback (e.g. "Google Sheets", "Google Docs")
    candidates.push({
      value: prod,
      source: 'brand_product',
      provider: 'google_workspace',
      score: 75,
      confidence: 0.75,
    });

    return candidates;
  },
};

/**
 * 3. Spotify Adapter
 */
const spotifyAdapter = {
  id: 'spotify',
  matches(urlObj) {
    const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'open.spotify.com' || host === 'spotify.com';
  },
  async getCandidates(url) {
    const candidates = [];
    try {
      const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
      const res = await safeFetch(oembedUrl, { timeoutMs: 4000 });
      if (res.ok && res.text) {
        const data = JSON.parse(res.text);
        if (data?.title) {
          candidates.push({
            value: data.title.trim(),
            source: 'provider_api',
            provider: 'spotify',
            score: 98,
            confidence: 0.95,
            thumbnail: data.thumbnail_url || null,
          });
        }
      }
    } catch {}

    candidates.push({
      value: 'Spotify',
      source: 'hostname',
      provider: 'spotify',
      score: 30,
      confidence: 0.4,
    });

    return candidates;
  },
};

/**
 * 4. GitHub Adapter
 */
const githubAdapter = {
  id: 'github',
  matches(urlObj) {
    const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'github.com';
  },
  async getCandidates(url, urlObj) {
    const candidates = [];
    const parts = urlObj.pathname.split('/').filter(Boolean);

    // Fetch page for real title & repo description
    try {
      const fetchRes = await safeFetch(url, { timeoutMs: 5000, maxBytes: 1024 * 512 });
      if (fetchRes.ok && fetchRes.text) {
        const og = extractOpenGraph(fetchRes.text, fetchRes.finalUrl || url);
        if (og.title) {
          let clean = cleanCandidateTitle(og.title, 'GitHub', 'github.com');
          clean = clean.replace(/^GitHub\s*-\s*/i, '');
          if (clean && !isNoisyTitle(clean)) {
            candidates.push({
              value: clean,
              source: 'og_title',
              provider: 'github',
              score: 92,
              confidence: 0.9,
              description: og.description || '',
              favicon: og.favicon || '',
            });
          }
        }
      }
    } catch {}

    // Repo path candidate: e.g. /facebook/react -> "facebook/react"
    if (parts.length >= 2) {
      const repoSlug = `${parts[0]}/${parts[1]}`;
      candidates.push({
        value: repoSlug,
        source: 'url_slug',
        provider: 'github',
        score: 70,
        confidence: 0.75,
      });
    }

    candidates.push({
      value: 'GitHub',
      source: 'hostname',
      provider: 'github',
      score: 30,
      confidence: 0.4,
    });

    return candidates;
  },
};

/**
 * 5. Generic Web Adapter
 */
const genericWebAdapter = {
  id: 'generic_web',
  matches() {
    return true; // Catch-all
  },
  async getCandidates(url, urlObj) {
    const candidates = [];
    const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    const brandKey = registrableLabel(host);

    // 1. Fetch live page HTML
    let ogData = null;
    try {
      const res = await safeFetch(url, { timeoutMs: 6000, maxBytes: 1024 * 512 });
      if (res.ok && res.text) {
        const html = res.text;
        ogData = extractOpenGraph(html, res.finalUrl || url);

        // A. OpenGraph Title
        if (ogData.title) {
          const clean = cleanCandidateTitle(ogData.title, ogData.siteName, host);
          if (clean && !isNoisyTitle(clean)) {
            candidates.push({
              value: clean,
              source: 'og_title',
              provider: 'generic_web',
              score: 90,
              confidence: 0.9,
              favicon: ogData.favicon || '',
              description: ogData.description || '',
              siteName: ogData.siteName || '',
            });
          }
        }

        // B. JSON-LD title
        if (typeof extractJsonLdTitle === 'function') {
          const jsonLdTitle = extractJsonLdTitle(html);
          if (jsonLdTitle) {
            const clean = cleanCandidateTitle(jsonLdTitle, ogData.siteName, host);
            if (clean && !isNoisyTitle(clean)) {
              candidates.push({
                value: clean,
                source: 'json_ld',
                provider: 'generic_web',
                score: 85,
                confidence: 0.88,
              });
            }
          }
        }

        // C. Document <title>
        const docTitleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
        if (docTitleMatch) {
          const rawDoc = docTitleMatch[1].replace(/\s+/g, ' ').trim();
          const clean = cleanCandidateTitle(rawDoc, ogData.siteName, host);
          if (clean && !isNoisyTitle(clean)) {
            candidates.push({
              value: clean,
              source: 'html_title',
              provider: 'generic_web',
              score: 78,
              confidence: 0.82,
              favicon: ogData.favicon || '',
              description: ogData.description || '',
              siteName: ogData.siteName || '',
            });
          }
        }
      }
    } catch {
      // Network/parse error; fallback candidates below handle this
    }

    // 2. URL Path Slug Candidate (e.g. /v/dan-dangler-zac-wild-s-oiled-up-orgy-with-big-tit-brunette-milf.big-boobs)
    const slug = pathSlugName(url);
    if (slug) {
      candidates.push({
        value: slug,
        source: 'url_slug',
        provider: 'generic_web',
        score: 65,
        confidence: 0.65,
        favicon: ogData?.favicon || '',
        description: ogData?.description || '',
        siteName: ogData?.siteName || '',
      });
    }

    // 3. Multi-product brand name (e.g. AWS, Azure, iCloud)
    if (isKnownBrand(host)) {
      const prod = productName(brandKey, host, urlObj.pathname) || BRAND_NAMES[brandKey];
      if (prod) {
        candidates.push({
          value: prod,
          source: 'brand_product',
          provider: 'generic_web',
          score: 50,
          confidence: 0.55,
        });
      }
    }

    // 4. Hostname / Site Name fallback (e.g. www.theyarehuge.com -> "Theyarehuge")
    const siteFallback = siteNameFromHostname(host);
    if (siteFallback) {
      candidates.push({
        value: siteFallback,
        source: 'hostname',
        provider: 'generic_web',
        score: 30,
        confidence: 0.35,
      });
    }

    return candidates;
  },
};

const PROVIDER_REGISTRY = [
  youtubeAdapter,
  googleWorkspaceAdapter,
  spotifyAdapter,
  githubAdapter,
  genericWebAdapter,
];

/**
 * Identify the provider adapter for a URL.
 */
function identifyProvider(urlObj) {
  for (const adapter of PROVIDER_REGISTRY) {
    if (adapter.matches(urlObj)) {
      return adapter;
    }
  }
  return genericWebAdapter;
}

// ============================================================================
// MAIN DETECTION ENTRYPOINT
// ============================================================================

/**
 * Core internal resolution logic.
 */
async function resolveTitleInternal(normalizedUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return {
      ok: false,
      title: '',
      name: '',
      source: 'invalid',
      provider: 'unknown',
      confidence: 0,
      status: 'invalid',
      error: 'Invalid URL',
    };
  }

  const adapter = identifyProvider(parsedUrl);
  const candidates = await adapter.getCandidates(normalizedUrl, parsedUrl);

  // Filter out empty or whitespace candidates
  const validCandidates = candidates.filter((c) => c && typeof c.value === 'string' && c.value.trim().length > 0);

  if (!validCandidates.length) {
    const fallback = siteNameFromHostname(parsedUrl.hostname) || parsedUrl.hostname;
    return {
      ok: true,
      title: fallback,
      name: fallback,
      source: 'hostname',
      provider: adapter.id,
      confidence: 0.3,
      status: 'fallback',
      siteName: fallback,
      favicon: '',
      description: '',
      thumbnail: '',
      author: '',
      canonicalUrl: normalizedUrl,
      cached: false,
    };
  }

  // Sort by score descending
  validCandidates.sort((a, b) => b.score - a.score);
  const best = validCandidates[0];

  const status = best.score >= 70 ? 'resolved' : 'fallback';

  return {
    ok: true,
    title: best.value,
    name: best.value, // backwards-compatibility with existing frontend res.name
    source: best.source,
    provider: adapter.id,
    confidence: best.confidence || 0.5,
    status,
    siteName: best.siteName || siteNameFromHostname(parsedUrl.hostname),
    favicon: best.favicon || '',
    description: best.description || '',
    thumbnail: best.thumbnail || '',
    author: best.author || '',
    canonicalUrl: normalizedUrl,
    cached: false,
  };
}

/**
 * Detect the best title for a URL with caching and request coalescing.
 *
 * @param {string} rawUrl
 * @param {{skipCache?: boolean}} options
 */
async function detectTitle(rawUrl, options = {}) {
  const url = normalizeUrl(rawUrl);
  if (!isHttpUrl(url)) {
    return {
      ok: false,
      title: '',
      name: '',
      source: 'invalid',
      provider: 'unknown',
      confidence: 0,
      status: 'invalid',
      error: 'A valid http(s) URL is required.',
    };
  }

  const now = Date.now();

  // 1. Check in-memory cache
  if (!options.skipCache && titleCache.has(url)) {
    const cached = titleCache.get(url);
    if (cached.expiresAt > now) {
      return { ...cached.data, cached: true };
    }
    titleCache.delete(url);
  }

  // 2. Request coalescing: share in-flight promises
  if (inFlightRequests.has(url)) {
    return inFlightRequests.get(url);
  }

  const promise = (async () => {
    try {
      const result = await resolveTitleInternal(url);

      // Cache the result
      const ttl = result.status === 'resolved' ? CACHE_SUCCESS_TTL_MS : CACHE_FALLBACK_TTL_MS;
      if (titleCache.size >= CACHE_MAX_ENTRIES) {
        // Evict oldest entry
        const firstKey = titleCache.keys().next().value;
        if (firstKey) titleCache.delete(firstKey);
      }
      titleCache.set(url, { data: result, expiresAt: now + ttl });

      return result;
    } finally {
      inFlightRequests.delete(url);
    }
  })();

  inFlightRequests.set(url, promise);
  return promise;
}

function clearTitleCache() {
  titleCache.clear();
  inFlightRequests.clear();
}

module.exports = {
  detectTitle,
  identifyProvider,
  cleanCandidateTitle,
  isNoisyTitle,
  clearTitleCache,
  PROVIDER_REGISTRY,
};

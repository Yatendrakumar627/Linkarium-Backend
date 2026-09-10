const cheerio = require('cheerio');
const { getDomainWithoutSuffix, getSubdomain } = require('tldts');

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 300 * 1024; // 300 KB is more than enough for <title>/og:*
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// A small known-brand map so common sites render with their real casing
// (hostname alone cannot imply casing). Used by siteNameFromHostname.
const BRAND_NAMES = {
  chatgpt: 'ChatGPT',
  github: 'GitHub',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  google: 'Google',
  facebook: 'Facebook',
  twitter: 'Twitter',
  instagram: 'Instagram',
  wikipedia: 'Wikipedia',
  stackoverflow: 'Stack Overflow',
  reddit: 'Reddit',
  netflix: 'Netflix',
  amazon: 'Amazon',
  apple: 'Apple',
  microsoft: 'Microsoft',
  spotify: 'Spotify',
  discord: 'Discord',
  notion: 'Notion',
  figma: 'Figma',
  stripe: 'Stripe',
  vimeo: 'Vimeo',
  pinterest: 'Pinterest',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  dropbox: 'Dropbox',
  slack: 'Slack',
  medium: 'Medium',
  wordpress: 'WordPress',
  mozilla: 'Mozilla',
  nodejs: 'Node.js',
  reactjs: 'React',
  vuejs: 'Vue',
  angular: 'Angular',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
};

function splitWords(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase -> words
    .split(/[\s\-_.]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function titleCaseWord(word) {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// Extract the bare registrable label (the "brand" segment) from a hostname,
// backed by the real Public Suffix List (via tldts).
// e.g. gemini.google.com -> 'google', docs.google.com -> 'google',
//      mail.google.co.uk -> 'google', github.com -> 'github', chatgpt.com -> 'chatgpt',
//      mysite.blogspot.com -> 'mysite', foo.github.io -> 'foo'.
function registrableLabel(host) {
  if (!host) return '';
  let value = String(host).toLowerCase().trim();

  // Strip port
  value = value.replace(/:\d+$/, '');

  // Private multi-tenant suffixes (blogspot.com, github.io, appspot.com, ...)
  // are treated as subdomains so the registrable label becomes the sub-site
  // (e.g. mysite, foo) rather than the hosting platform.
  const label = getDomainWithoutSuffix(value, {
    extractHostname: false,
    allowPrivateDomains: true,
  });

  if (label) return label;

  // Fallback for localhost, IP addresses, and anything tldts can't classify.
  try {
    const first = new URL('http://' + value).hostname.split('.')[0];
    return first || '';
  } catch {
    return '';
  }
}

// Pull a clean name from a URL's readable path slug, e.g.
// https://trustmrr.com/startup/tortolitos -> 'tortolitos'.
// Returns '' when the last path segment is an id/hash/token (not a readable word).
function pathSlugName(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const segments = u.pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s).trim();
    } catch {
      return s.trim();
    }
  });
  const seg = segments.length ? segments[segments.length - 1] : '';
  if (!seg) return '';
  // Reject ids/hashes/tokens: long runs of hex/alnum, GUID-like, numeric-only.
  if (seg.length < 2 || seg.length > 40) return '';
  if (/^[0-9a-f]{8,}$/i.test(seg)) return '';
  if (/\d{4,}/.test(seg)) return '';
  if (/^[0-9]+$/.test(seg)) return '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '';
  // Must be predominantly word-like letters/digits/separators.
  if (!/^[a-z0-9][a-z0-9\-_]*$/i.test(seg)) return '';
  const words = splitWords(seg);
  if (words.length === 0) return '';
  return words.map(titleCaseWord).join(' ');
}

// Derive a clean brand/site name from a hostname.
// e.g. www.linkedin.com -> LinkedIn, chatgpt.com -> ChatGPT,
//      gemini.google.com -> Google, sub.example.co.uk -> Example.
function siteNameFromHostname(host) {
  const raw = registrableLabel(host);
  if (!raw) return '';
  const brand = BRAND_NAMES[raw];
  if (brand) return brand;
  const words = splitWords(raw);
  return words.map(titleCaseWord).join(' ');
}

// True when the hostname's registrable label is a well-known brand.
function isKnownBrand(host) {
  return Boolean(BRAND_NAMES[registrableLabel(host)]);
}

// Some brands host many distinct products under subdomains or path prefixes
// (gemini.google.com, docs.google.com/spreadsheets, aws.amazon.com...). When a
// URL matches one of these, we name the bookmark by the specific product rather
// than the generic brand name. Config is per-brand and easy to extend.
const MULTI_PRODUCT = {
  google: {
    pathProducts: {
      spreadsheets: 'Spreadsheets',
      document: 'Document',
      forms: 'Forms',
      slides: 'Slides',
      sheets: 'Sheets',
      drawings: 'Drawings',
      calendar: 'Calendar',
      mail: 'Gmail',
      drive: 'Drive',
      meet: 'Meet',
      photos: 'Photos',
      maps: 'Maps',
      translate: 'Translate',
    },
    subdomainProducts: {
      gemini: 'Gemini',
      mail: 'Gmail',
      calendar: 'Calendar',
      drive: 'Drive',
      meet: 'Meet',
      photos: 'Photos',
      maps: 'Maps',
      translate: 'Translate',
      keep: 'Keep',
      lens: 'Lens',
      earth: 'Google Earth',
      docs: 'Google Docs',
      news: 'Google News',
      scholar: 'Google Scholar',
      fonts: 'Google Fonts',
    },
    ignoreSubdomains: ['www', 'www1', 'www2', 'accounts', 'myaccount', 'support', 'developers', 'cloud', 'blog', 'tools', 'ai', 'safety', 'about', 'store'],
  },
  microsoft: {
    pathProducts: {},
    subdomainProducts: {
      azure: 'Azure',
      docs: 'Microsoft Docs',
      office: 'Microsoft 365',
      support: 'Microsoft Support',
      visualstudio: 'Visual Studio',
      learn: 'Microsoft Learn',
      developer: 'Microsoft Developer',
    },
    ignoreSubdomains: ['www', 'www1', 'www2', 'support', 'account', 'login', 'blogs', 'news', 'careers'],
  },
  amazon: {
    pathProducts: {},
    subdomainProducts: {
      aws: 'AWS',
      kindle: 'Kindle',
      music: 'Amazon Music',
      prime: 'Amazon Prime',
      photos: 'Amazon Photos',
      video: 'Amazon Video',
      games: 'Amazon Games',
    },
    ignoreSubdomains: ['www', 'www1', 'www2', 'support', 'account', 'pay', 'login'],
  },
  apple: {
    pathProducts: {},
    subdomainProducts: {
      developer: 'Apple Developer',
      support: 'Apple Support',
      icloud: 'iCloud',
      apps: 'App Store',
      music: 'Apple Music',
      tv: 'Apple TV+',
      newsroom: 'Apple Newsroom',
    },
    ignoreSubdomains: ['www', 'www1', 'www2', 'support-something', 'store'],
  },
};

// Return a brand's specific product name for a URL, or null when no product
// match applies (caller falls back to the generic brand name).
// Path prefixes win over subdomains: docs.google.com/spreadsheets/.. ->
// 'Spreadsheets' (path), while gemini.google.com/app/.. -> 'Gemini' (subdomain).
function productName(brandKey, host, pathname) {
  const cfg = MULTI_PRODUCT[brandKey];
  if (!cfg) return null;

  // 1) Path tier: first path segment maps directly to a product.
  const slug = firstPathSlug(pathname);
  if (slug && cfg.pathProducts[slug]) {
    return cfg.pathProducts[slug];
  }

  // 2) Subdomain tier: rightmost subdomain label maps to a product.
  const sub = getSubdomain(host, { extractHostname: false, allowPrivateDomains: true }) || '';
  const labels = sub.split('.').filter(Boolean);
  const label = labels.length ? labels[labels.length - 1].toLowerCase() : '';
  if (label && !cfg.ignoreSubdomains.includes(label) && cfg.subdomainProducts[label]) {
    return cfg.subdomainProducts[label];
  }

  return null;
}

function firstPathSlug(pathname) {
  if (!pathname) return '';
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  let seg;
  try {
    seg = decodeURIComponent(segments[0]).trim();
  } catch {
    seg = segments[0].trim();
  }
  seg = seg.toLowerCase();
  // Must be a short word-like slug, not an id/hash/token.
  if (seg.length < 2 || seg.length > 30) return '';
  if (!/^[a-z][a-z0-9\-_]*$/.test(seg)) return '';
  return seg;
}

// Normalize a raw <title>/og:title string into a clean single line.
function cleanTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s+/g, ' ')
    .replace(/\s*[|•·–—-]\s*.*$/i, '') // cut trailing " - Brand" / " | Site" fragments
    .trim()
    .slice(0, 120);
}

function isHttpUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('text/html') && !type.includes('application/xhtml')) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, MAX_BODY_BYTES).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

// Extract a display name for a page, or null if nothing usable was found.
async function extractName(url) {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  const ogTitle = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
  const titleTag = $('title').first().text();

  const ogClean = cleanTitle(ogTitle);
  const titleClean = cleanTitle(titleTag);

  if (ogClean) return ogClean;
  if (titleClean) return titleClean;
  return null;
}

module.exports = { extractName, siteNameFromHostname, cleanTitle, isHttpUrl, registrableLabel, pathSlugName, isKnownBrand, productName, BRAND_NAMES };

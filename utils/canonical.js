// Canonical URL engine.
//
// The canonical URL is an *identity key* for a link: two different strings
// that point at the same page must produce the same key so duplicates can be
// detected. The URL the user actually opens (`Link.url`) is never rewritten —
// only `Link.canonicalUrl` is normalised, so a site that only serves HTTP
// keeps working.
//
// Rules applied:
//   - scheme: forced to https (identity only — the stored URL keeps its scheme)
//   - host: lowercased, trailing dot removed, leading "www." stripped
//   - port: default ports removed (the WHATWG URL parser does this)
//   - path: trailing slash removed (except for the root path)
//   - query: tracking parameters removed, remaining parameters sorted
//   - hash: removed when it looks like a playback offset (t=30, #section)
//   - known redirect wrappers unwrapped (YouTube, google.com/url?q=…)

const { getDomain } = require('tldts');

// Analytics/campaign parameters that must not influence link identity.
const TRACKING_PARAM = new RegExp(
  '^(utm_[a-z_]+|utm|source|src|referrer|ref|fbclid|gclid|dclid|msclkid|twclid|yclid|igshid|mc_cid|mc_eid|' +
    'si|ved|feature|share_source|share_medium|share_id|spm|trk|trkcampaign|sc_campaign|sc_channel|' +
    'sc_content|sc_medium|sc_outcome|sc_geo|sc_country|hsa_[a-z]+|wt_[a-z]+|wtmc|__twitter_impression|' +
    'at_custom[0-9]+|ncid|s_kwcid|vero_[a-z]+|epik|cmpid|campaign_id|campaignid|_hsenc|_hsmi|igshid|is_|' +
    'mkt_tok|ttclid|wbraid|gbraid)$',
  'i'
);

// Hash fragments that only encode a playback position / scroll state.
const VOLATILE_HASH = /^(t|s|start|time|sp)([=&\-]|$)/i;

// Hosts whose URLs are wrappers around another page.
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);
const YOUTUBE_SHORT_HOST = 'youtu.be';

function isTrackingParam(key) {
  return TRACKING_PARAM.test(key);
}

function stripTrackingParams(searchParams) {
  const kept = [];
  for (const [key, value] of searchParams.entries()) {
    if (isTrackingParam(key)) continue;
    kept.push([key, value]);
  }
  // Sorting makes ?b=2&a=1 and ?a=1&b=2 the same identity.
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return kept;
}

function buildQuery(kept) {
  if (!kept.length) return '';
  const params = new URLSearchParams();
  for (const [key, value] of kept) params.append(key, value);
  return `?${params.toString()}`;
}

// youtube.com/watch?v=ID and youtube.com/shorts/ID are the same video as
// youtu.be/ID — normalising to the short form collapses the duplicates.
function canonicalYoutube(host, pathname, params) {
  if (host === YOUTUBE_SHORT_HOST) {
    const id = pathname.replace(/^\/+/, '').split('/')[0];
    if (!id) return null;
    return `https://${YOUTUBE_SHORT_HOST}/${id}`;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (pathname === '/watch') {
    const id = params.get('v');
    if (!id) return null;
    return `https://${YOUTUBE_SHORT_HOST}/${id}`;
  }
  if (pathname.startsWith('/shorts/') || pathname.startsWith('/embed/') || pathname.startsWith('/live/')) {
    const id = pathname.split('/')[2];
    if (!id) return null;
    return `https://${YOUTUBE_SHORT_HOST}/${id}`;
  }
  return null;
}

// google.com/url?q=<real url> is a redirect wrapper.
function canonicalGoogleWrapper(host, pathname, params) {
  if (!['google.com', 'www.google.com'].includes(host)) return null;
  if (!['/url', '/imgres'].includes(pathname)) return null;
  const target = params.get('q') || params.get('imgurl');
  if (!target) return null;
  return target;
}

/**
 * @param {string} input raw URL
 * @param {number} depth internal recursion guard for redirect wrappers
 * @returns {{canonical: string, host: string, hostLabel: string, path: string}|null}
 */
function canonicalizeUrl(input, depth = 0) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Credentials in a URL are a phishing/masking trick — never a real identity.
  if (url.username || url.password) return null;

  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (host.startsWith('www.')) host = host.slice(4);

  const kept = stripTrackingParams(url.searchParams);
  const params = new URLSearchParams();
  for (const [k, v] of kept) params.append(k, v);

  let path = url.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/';

  // Wrapper hosts collapse to the page they point at.
  if (depth < 3) {
    const wrapped = canonicalYoutube(host, path, params) || canonicalGoogleWrapper(host, path, params);
    if (wrapped) {
      const nested = canonicalizeUrl(wrapped, depth + 1);
      if (nested) return nested;
    }
  }

  const query = buildQuery(kept);
  const hash = url.hash && !VOLATILE_HASH.test(url.hash.slice(1)) ? url.hash : '';

  const canonical = `https://${host}${path}${query}${hash}`;

  return {
    canonical,
    host,
    hostLabel: registrableDomain(host),
    path,
  };
}

// Registrable domain ("google.com" for docs.google.com). Falls back to the
// host itself when the public suffix list does not know it.
function registrableDomain(host) {
  if (!host) return '';
  try {
    const domain = getDomain(host);
    return domain || host;
  } catch {
    return host;
  }
}

// True when two URLs point at the same page by the canonical rules.
function isSameCanonical(a, b) {
  const ca = canonicalizeUrl(a);
  const cb = canonicalizeUrl(b);
  if (!ca || !cb) return false;
  return ca.canonical === cb.canonical;
}

module.exports = { canonicalizeUrl, registrableDomain, isSameCanonical, isTrackingParam };

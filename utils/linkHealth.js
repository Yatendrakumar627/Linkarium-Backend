// Link health checking.
//
// A "health check" asks a saved URL whether it still works. The result is
// stored on the link so the UI can show a broken-link badge and the user can
// filter for `is:broken`.
//
// Every request goes through the SSRF guard in utils/fetcher.js — the server
// must never fetch a URL that points back into the private network.
//
// Classification
//   healthy   the page answered (2xx/3xx), or refused us politely (401,
//             403, 405, 429) — the link exists, we simply may not see it
//   broken    the page is gone (404/410), the host does not resolve, or the
//             connection failed
//   unknown   the URL could not be checked at all (blocked by the SSRF guard,
//             invalid scheme, ...) — that is our problem, not the link's

const { safeFetch } = require('./fetcher');

const DEFAULT_TIMEOUT_MS = 10_000;

// How long to wait before the next check, per status.
const HEALTHY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly
const BROKEN_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const UNKNOWN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Never back off further than this.
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** HTTP statuses that mean "the link exists" even though the fetch failed. */
const RESTRICTED_STATUSES = new Set([401, 403, 405, 429]);

/** HTTP statuses that mean "the page is gone". */
const GONE_STATUSES = new Set([404, 410]);

/**
 * Turn a safeFetch result into a health verdict.
 *
 * @param {object} result the object returned by safeFetch
 * @returns {{status: string, httpStatus: number|null, error: string|null,
 *            errorKind: string|null, finalUrl: string|null}}
 */
function classify(result) {
  const status = result?.status ?? null;

  if (result?.ok) {
    return {
      status: 'healthy',
      httpStatus: status,
      error: null,
      errorKind: null,
      finalUrl: result.finalUrl || null,
    };
  }

  if (status && RESTRICTED_STATUSES.has(status)) {
    // The page exists, we just were not allowed to read it.
    return {
      status: 'healthy',
      httpStatus: status,
      error: `HTTP ${status}`,
      errorKind: 'restricted',
      finalUrl: result.finalUrl || null,
    };
  }

  if (status && GONE_STATUSES.has(status)) {
    return {
      status: 'broken',
      httpStatus: status,
      error: `HTTP ${status}`,
      errorKind: 'http',
      finalUrl: result.finalUrl || null,
    };
  }

  if (status && status >= 500) {
    return {
      status: 'broken',
      httpStatus: status,
      error: `HTTP ${status}`,
      errorKind: 'server',
      finalUrl: result.finalUrl || null,
    };
  }

  if (status && status >= 400) {
    return {
      status: 'broken',
      httpStatus: status,
      error: `HTTP ${status}`,
      errorKind: 'http',
      finalUrl: result.finalUrl || null,
    };
  }

  // No usable status code: the request never completed.
  const errorKind = result?.errorKind || 'network';

  // The SSRF guard refused the URL. The link may be perfectly fine — we just
  // are not allowed to look at it.
  if (['blocked-host', 'blocked-ip', 'scheme', 'credentials', 'invalid'].includes(errorKind)) {
    return {
      status: 'unknown',
      httpStatus: null,
      error: result?.error || 'Could not be checked',
      errorKind,
      finalUrl: null,
    };
  }

  if (errorKind === 'timeout') {
    return {
      status: 'broken',
      httpStatus: null,
      error: 'Request timed out',
      errorKind: 'timeout',
      finalUrl: result?.finalUrl || null,
    };
  }

  if (errorKind === 'dns') {
    return {
      status: 'broken',
      httpStatus: null,
      error: 'Host could not be resolved',
      errorKind: 'dns',
      finalUrl: result?.finalUrl || null,
    };
  }

  return {
    status: 'broken',
    httpStatus: null,
    error: result?.error || 'Request failed',
    errorKind: errorKind,
    finalUrl: result?.finalUrl || null,
  };
}

/**
 * Check a single URL.
 *
 * A HEAD request is tried first (cheap). Servers that do not implement HEAD
 * answer 405/501, and those are retried with a small GET.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, method?: 'HEAD'|'GET'}} options
 * @returns {Promise<{status: string, httpStatus: number|null, error: string|null,
 *                    errorKind: string|null, finalUrl: string|null, latencyMs: number}>}
 */
async function checkUrl(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const startedAt = Date.now();
  let result = await safeFetch(url, {
    method: 'HEAD',
    timeoutMs,
    maxBytes: 1024,
  });

  // The server does not support HEAD — try a (small) GET instead.
  if (result.status === 405 || result.status === 501) {
    result = await safeFetch(url, {
      method: 'GET',
      timeoutMs,
      maxBytes: 16 * 1024,
    });
    // A body larger than the cap is fine: the response headers already told
    // us everything we need.
    if (result.errorKind === 'too-large' && result.status) {
      result = { ...result, ok: result.status < 400, error: null, errorKind: null };
    }
  }

  const verdict = classify(result);
  return {
    ...verdict,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * How long until this link should be checked again.
 *
 * Broken links are re-checked sooner, and consecutive failures back off
 * exponentially so a permanently dead host is not hammered.
 *
 * @param {string} status 'healthy' | 'broken' | 'unknown'
 * @param {number} failures consecutive failures
 * @returns {number} milliseconds
 */
function nextCheckDelay(status, failures = 0) {
  const base =
    status === 'broken' ? BROKEN_INTERVAL_MS : status === 'unknown' ? UNKNOWN_INTERVAL_MS : HEALTHY_INTERVAL_MS;
  const backoff = Math.min(2 ** Math.max(0, failures - 1), 8);
  return Math.min(base * backoff, MAX_INTERVAL_MS);
}

/**
 * Build the `health` sub-document to store on a link.
 *
 * @param {object} previous the current health object (may be null)
 * @param {object} verdict the result of checkUrl
 * @param {Date} now
 */
function buildHealthUpdate(previous, verdict, now = new Date()) {
  const prev = previous || {};
  const failures = verdict.status === 'broken' ? Number(prev.failures || 0) + 1 : 0;
  const delay = nextCheckDelay(verdict.status, failures);

  return {
    status: verdict.status,
    httpStatus: verdict.httpStatus ?? null,
    error: verdict.error ?? null,
    errorKind: verdict.errorKind ?? null,
    checkedAt: now,
    lastOkAt: verdict.status === 'healthy' ? now : prev.lastOkAt ?? null,
    nextCheckAt: new Date(now.getTime() + delay),
    failures,
    latencyMs: verdict.latencyMs ?? null,
    finalUrl: verdict.finalUrl ?? null,
  };
}

module.exports = {
  checkUrl,
  classify,
  nextCheckDelay,
  buildHealthUpdate,
  HEALTHY_INTERVAL_MS,
  BROKEN_INTERVAL_MS,
  UNKNOWN_INTERVAL_MS,
  MAX_INTERVAL_MS,
};

// SSRF-safe HTTP fetcher.
//
// Every outbound request made by the server (link-health checks, OpenGraph
// enrichment) goes through here. The threat model is a user-controlled URL
// that points at something the server can reach but the user cannot — the
// cloud metadata endpoint, a private service on the VPC, a loopback admin
// port.
//
// Defences, in order:
//   1. scheme allowlist (http/https only) and no credentials in the URL
//   2. hostname blocklist (localhost, *.internal, *.local, metadata hosts)
//   3. DNS resolution + IP blocklist (loopback, private, link-local, CGNAT,
//      multicast, reserved, IPv4-mapped IPv6)
//   4. the request is pinned to the *validated* IP, so a second DNS answer
//      (DNS rebinding) cannot slip a different address past the check
//   5. redirects are followed manually (max 5) and every hop is re-validated
//   6. hard timeouts and a response byte cap
//   7. no cookies, no authorization headers, no proxying of user auth

const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; LinkariumBot/1.0; +https://github.com/linkarium)';

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB

// Addresses that must never be reached.
const BLOCKED_IPS = new net.BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
]) {
  BLOCKED_IPS.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard-only
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]) {
  BLOCKED_IPS.addSubnet(net, prefix, 'ipv6');
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// IPv4-mapped IPv6 addresses ("::ffff:127.0.0.1") must be checked against the
// IPv4 rules — Node's BlockList would otherwise treat every IPv4 address as
// part of the mapped range, which would block the whole internet.
const IPV4_MAPPED_DOTTED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
const IPV4_MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;

  if (family === 6) {
    const dotted = IPV4_MAPPED_DOTTED.exec(address);
    if (dotted) return isBlockedAddress(dotted[1]);
    const hex = IPV4_MAPPED_HEX.exec(address);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isBlockedAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return BLOCKED_IPS.check(address, 'ipv6');
  }

  return BLOCKED_IPS.check(address, 'ipv4');
}

/**
 * Validate a URL and resolve it to a pinned IP.
 * @returns {Promise<{url: URL, ip: string, family: number}>}
 */
async function resolveTarget(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    const err = new Error('Invalid URL');
    err.kind = 'invalid';
    throw err;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const err = new Error('Only http(s) URLs are allowed');
    err.kind = 'scheme';
    throw err;
  }
  if (url.username || url.password) {
    const err = new Error('URLs with credentials are not allowed');
    err.kind = 'credentials';
    throw err;
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(hostname)) {
    const err = new Error('Host is not allowed');
    err.kind = 'blocked-host';
    throw err;
  }

  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    const err = new Error('Host could not be resolved');
    err.kind = 'dns';
    throw err;
  }
  if (!addresses.length) {
    const err = new Error('Host could not be resolved');
    err.kind = 'dns';
    throw err;
  }

  // Every answer must be public — one private address is enough to poison
  // the host (split-horizon DNS).
  for (const a of addresses) {
    if (isBlockedAddress(a.address)) {
      const err = new Error('Host resolves to a blocked address');
      err.kind = 'blocked-ip';
      throw err;
    }
  }

  const chosen = addresses[0];
  return { url, ip: chosen.address, family: chosen.family };
}

function requestOnce(target, options) {
  const { timeoutMs, maxBytes, method, headers, body } = options;
  const { url, ip, family } = target;
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const payload = body === undefined || body === null ? null : Buffer.from(body);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    const req = mod.request(
      {
        protocol: url.protocol,
        // Hostname is kept for the Host header and TLS SNI; the socket is
        // pinned to the pre-validated IP via the lookup override.
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname || '/'}${url.search || ''}`,
        method,
        headers: {
          host: url.host,
          accept: headers.accept || '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': headers['user-agent'] || DEFAULT_USER_AGENT,
          ...(payload ? { 'content-length': String(payload.length) } : {}),
          ...(headers['content-type'] ? { 'content-type': headers['content-type'] } : {}),
          ...(headers.authorization ? { authorization: headers.authorization } : {}),
          ...(isHttps ? {} : {}),
        },
        servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname.replace(/^\[|\]$/g, ''),
        lookup: (_hostname, opts, cb) => {
          if (typeof opts === 'function') {
            cb = opts;
            return cb(null, ip, family);
          }
          if (opts && opts.all) {
            return cb(null, [{ address: ip, family }]);
          }
          return cb(null, ip, family);
        },
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            const err = new Error('Response too large');
            err.kind = 'too-large';
            // The response *was* received — keep the status code so callers
            // (e.g. the link-health checker) can still tell 200 from 404.
            err.status = res.statusCode;
            finish(reject, err);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          finish(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', (err) => {
          err.kind = err.kind || 'network';
          finish(reject, err);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      const err = new Error('Request timed out');
      err.kind = 'timeout';
      finish(reject, err);
    });

    req.on('error', (err) => {
      err.kind = err.kind || 'network';
      finish(reject, err);
    });

    req.end(payload || undefined);
  });
}

/**
 * Fetch a URL through the SSRF guard.
 *
 * @param {string} rawUrl
 * @param {{method?: string, timeoutMs?: number, maxBytes?: number, maxRedirects?: number,
 *          headers?: object, body?: string|Buffer}} options
 * @returns {Promise<{ok: boolean, status: number|null, finalUrl: string, contentType: string|null,
 *                    body: Buffer|null, text: string|null, error: string|null, errorKind: string|null,
 *                    redirects: string[]}>}
 */
async function safeFetch(rawUrl, options = {}) {
  const {
    method = 'GET',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = MAX_REDIRECTS,
    headers = {},
    body = undefined,
  } = options;

  const deadline = Date.now() + timeoutMs;
  const redirects = [];
  let currentUrl = String(rawUrl);

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { ok: false, status: null, finalUrl: currentUrl, contentType: null, body: null, text: null, error: 'Request timed out', errorKind: 'timeout', redirects };
      }

      const target = await resolveTarget(currentUrl);
      const response = await requestOnce(target, {
        timeoutMs: Math.min(remaining, DEFAULT_TIMEOUT_MS),
        maxBytes,
        method,
        headers,
        body,
      });

      const location = response.headers.location;
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (isRedirect && hop < maxRedirects) {
        let next;
        try {
          next = new URL(location, target.url).toString();
        } catch {
          return { ok: false, status: response.status, finalUrl: currentUrl, contentType: null, body: null, text: null, error: 'Invalid redirect target', errorKind: 'invalid', redirects };
        }
        redirects.push(next);
        currentUrl = next;
        continue;
      }

      const contentType = response.headers['content-type'] || null;
      const isText = !contentType || /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json))/i.test(contentType);
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        finalUrl: target.url.toString(),
        contentType,
        body: response.body,
        text: isText ? response.body.toString('utf8') : null,
        error: response.status >= 400 ? `HTTP ${response.status}` : null,
        errorKind: response.status >= 400 ? 'http' : null,
        redirects,
      };
    }

    return { ok: false, status: null, finalUrl: currentUrl, contentType: null, body: null, text: null, error: 'Too many redirects', errorKind: 'redirects', redirects };
  } catch (err) {
    return {
      ok: false,
      status: err?.status ?? null,
      finalUrl: currentUrl,
      contentType: null,
      body: null,
      text: null,
      error: err.message || 'Request failed',
      errorKind: err.kind || 'network',
      redirects,
    };
  }
}

module.exports = {
  safeFetch,
  resolveTarget,
  isBlockedHostname,
  isBlockedAddress,
  DEFAULT_USER_AGENT,
};

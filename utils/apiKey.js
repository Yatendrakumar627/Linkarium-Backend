// Personal access tokens.
//
// A key looks like `lk_<prefix>_<secret>`. The prefix is stored in clear so
// the key can be looked up without scanning the collection; the full key is
// only ever stored as a SHA-256 hash, so a database leak does not hand out
// working tokens.

const crypto = require('crypto');

const KEY_PREFIX = 'lk';

/** Create a new API key. The secret is returned exactly once. */
function generateApiKey() {
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const key = `${KEY_PREFIX}_${prefix}_${secret}`;
  return { key, prefix, hash: hashApiKey(key) };
}

/** SHA-256 hex digest of a full API key. */
function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex');
}

/**
 * Split a key into its prefix and the rest.
 * @returns {{prefix: string, secret: string}|null}
 */
function parseApiKey(key) {
  const parts = String(key || '').split('_');
  if (parts.length < 3 || parts[0] !== KEY_PREFIX) return null;
  return { prefix: parts[1], secret: parts.slice(2).join('_') };
}

/** True when the key has the expected shape. */
function isApiKeyShape(key) {
  const parsed = parseApiKey(key);
  return Boolean(parsed && parsed.prefix && parsed.secret);
}

/** A short, human-friendly label for a key (used in the UI list). */
function maskKey(key) {
  const parsed = parseApiKey(key);
  if (!parsed) return '****';
  return `${KEY_PREFIX}_${parsed.prefix}…`;
}

module.exports = {
  generateApiKey,
  hashApiKey,
  parseApiKey,
  isApiKeyShape,
  maskKey,
  KEY_PREFIX,
};

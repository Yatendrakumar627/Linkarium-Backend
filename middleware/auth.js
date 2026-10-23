const User = require('../models/User');
const ApiKey = require('../models/ApiKey');
const {
  verifyToken,
  getCachedTokenVersion,
  setCachedTokenVersion,
} = require('../utils/helpers');
const { parseApiKey, hashApiKey } = require('../utils/apiKey');
const crypto = require('crypto');

// Fast-path auth: verifying the access token needs no database round-trip in
// the common case.
//
// The token's embedded tokenVersion is compared against the user's current
// version (bumped on password change / logout to revoke every outstanding
// token). That version is cached per user for a short TTL, so the hot path
// costs one indexed lookup per user per TTL instead of one per request.
//
// If the cached version and the token disagree we re-read the user once: the
// disagreement may simply mean the version was bumped by another server
// instance (this cache is per-process), and re-reading keeps the decision
// correct instead of rejecting a valid token.
//
// Personal access keys (`lk_…`) are also accepted. They are looked up by
// their public prefix and compared against the stored hash in constant time.

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Constant-time comparison of two hex digests. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Authenticate a personal access key.
 *
 * @returns {Promise<{userId: string, scopes: string[]}|null>}
 */
async function authenticateApiKey(token) {
  const parsed = parseApiKey(token);
  if (!parsed) return null;

  const record = await ApiKey.findOne({ prefix: parsed.prefix, revokedAt: null }).select('+hash');
  if (!record) return null;

  if (!safeEqual(hashApiKey(token), record.hash)) return null;

  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return null;

  // Remembering when the key was last used is best-effort.
  ApiKey.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});

  return { userId: String(record.user), scopes: record.scopes || ['links:read'] };
}

module.exports = async function auth(req, res, next) {
  // Accept both the standard bearer header and the `X-API-Key` header used by
  // the browser extension. The latter is the conventional way to send a
  // personal access key and does not collide with the access token.
  const header = req.headers.authorization;
  let token = header && header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    const apiKeyHeader = req.headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
      token = apiKeyHeader.trim();
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Not authorized. Missing token.' });
  }

  // --- Personal access key ---
  if (token.startsWith('lk_')) {
    try {
      const result = await authenticateApiKey(token);
      if (!result) {
        return res.status(401).json({ error: 'Not authorized. Invalid API key.' });
      }

      // A read-only key may only read.
      const canWrite = result.scopes.some((s) => s === 'links:write' || s === 'full');
      if (!canWrite && !READ_ONLY_METHODS.has(req.method)) {
        return res.status(403).json({ error: 'This API key is read-only.' });
      }

      req.userId = result.userId;
      req.apiKeyScopes = result.scopes;
      return next();
    } catch {
      return res.status(401).json({ error: 'Not authorized. Invalid API key.' });
    }
  }

  // --- Access token ---
  try {
    const payload = verifyToken(token, 'access');
    const userId = String(payload.id);
    const v = payload.v || 0;

    let cached = getCachedTokenVersion(userId);
    if (cached === undefined || cached !== v) {
      const user = await User.findById(userId).select('tokenVersion status role');
      if (!user) {
        return res.status(401).json({ error: 'Not authorized. Token invalid or expired.' });
      }
      if (user.status === 'suspended') {
        return res.status(403).json({ error: 'Your account has been suspended by an administrator.' });
      }
      cached = user.tokenVersion || 0;
      setCachedTokenVersion(userId, cached);
      req.userRole = user.role || 'user';
    } else {
      req.userRole = payload.role || 'user';
    }

    if (cached !== v) {
      return res.status(401).json({ error: 'Not authorized. Token invalid or expired.' });
    }

    req.userId = userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Not authorized. Token invalid or expired.' });
  }
};

module.exports.authenticateApiKey = authenticateApiKey;

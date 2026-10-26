const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Shared secret used to sign both short-lived access tokens and longer-lived
// refresh tokens.
function getJwtSecret() {
  return process.env.JWT_SECRET;
}

// Cached tokenVersion per userId -> { v, at }. Avoids a DB hit on every
// authenticated request; invalidated whenever we bump tokenVersion (password
// change / logout-all).
//
// The TTL also bounds how long a revocation can take to reach another server
// instance, since this cache is per-process.
const tokenVersionCache = new Map();
const TOKEN_VER_CACHE_TTL_MS = 15_000;

function getCachedTokenVersion(userId) {
  const k = String(userId);
  const c = tokenVersionCache.get(k);
  if (c && Date.now() - c.at < TOKEN_VER_CACHE_TTL_MS) return c.v;
  return undefined;
}

function setCachedTokenVersion(userId, v) {
  tokenVersionCache.set(String(userId), { v, at: Date.now() });
}

function invalidateTokenVersion(userId) {
  tokenVersionCache.delete(String(userId));
}

// Each issued token gets a unique id so that rotating a refresh token always
// produces a genuinely new token (otherwise two tokens signed within the same
// second would be byte-identical).
function signAccessToken(user) {
  return jwt.sign(
    {
      id: user._id,
      v: user.tokenVersion || 0,
      role: user.role || 'user',
      isMaster: Boolean(user.isMaster),
      typ: 'access',
      jti: crypto.randomUUID(),
    },
    getJwtSecret(),
    { expiresIn: process.env.ACCESS_TOKEN_TTL || '15m' }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    { id: user._id, v: user.tokenVersion || 0, typ: 'refresh', jti: crypto.randomUUID() },
    getJwtSecret(),
    { expiresIn: process.env.REFRESH_TOKEN_TTL || '7d' }
  );
}

function verifyToken(token, expectedType) {
  const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
  if (expectedType && payload.typ && payload.typ !== expectedType) {
    const err = new Error('Invalid token type');
    err.name = 'TokenTypeError';
    throw err;
  }
  return payload;
}

function normalizeUrl(url) {
  if (typeof url !== 'string') return '';
  const value = url.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return 'https:' + value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
  return 'https://' + value;
}

function randomColor() {
  return (
    '#' +
    Math.floor(Math.random() * 16777215)
      .toString(16)
      .padStart(6, '0')
  );
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const cleaned = [];
  for (const t of tags) {
    const tag = String(t || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-');
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      cleaned.push(tag);
    }
  }
  return cleaned.slice(0, 30);
}

function publicUser(user) {
  const prefs = user.preferences || {};
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role || 'user',
    isMaster: Boolean(user.isMaster),
    status: user.status || 'active',
    lastLoginAt: user.lastLoginAt || null,
    lastLoginIp: user.lastLoginIp || '',
    loginCount: user.loginCount || 0,
    avatarColor: user.avatarColor,
    createdAt: user.createdAt,
    // The client uses these to restore the theme, the default view and the
    // digest settings without a second round-trip.
    preferences: {
      digestEnabled: Boolean(prefs.digestEnabled),
      digestDay: prefs.digestDay !== undefined ? prefs.digestDay : 1,
      digestHour: prefs.digestHour !== undefined ? prefs.digestHour : 8,
      timezone: prefs.timezone || 'UTC',
      theme: prefs.theme || 'dark',
      defaultView: prefs.defaultView || 'dashboard',
      autoEnrich: prefs.autoEnrich !== false,
      colorMode: prefs.colorMode || 'collection',
      tagColors: prefs.tagColors
        ? (prefs.tagColors instanceof Map ? Object.fromEntries(prefs.tagColors) : typeof prefs.tagColors === 'object' ? prefs.tagColors : {})
        : {},
    },
    twoFactorEnabled: Boolean(user.totp?.enabled),
    recoveryCodesLeft: Array.isArray(user.recoveryCodes) ? user.recoveryCodes.length : 0,
  };
}

module.exports = {
  normalizeUrl,
  randomColor,
  normalizeTags,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  publicUser,
  getCachedTokenVersion,
  setCachedTokenVersion,
  invalidateTokenVersion,
};

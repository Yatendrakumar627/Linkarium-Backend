// TOTP (RFC 6238) — time-based one-time passwords.
//
// Implemented with Node's built-in crypto so the server needs no extra
// dependency for two-factor authentication. This is the standard HMAC-SHA1
// construction with a 30 second step and a 6 digit code, which is what every
// authenticator app expects.
//
// The secret is base32 encoded (the format the authenticator apps display).

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;

// The RFC 4226 test vectors use SHA-1; the step size is fixed at 30 seconds.
const DEFAULT_ALGORITHM = 'sha1';

/** Encode a buffer as base32 (no padding). */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i += 1) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/** Decode a base32 string into a buffer. Throws on invalid input. */
function base32Decode(input) {
  const clean = String(input || '')
    .toUpperCase()
    .replace(/=+$/, '')
    .replace(/\s+/g, '');

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** A fresh base32 secret (160 bits, the RFC 4226 recommendation). */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * HOTP — the counter-based one-time password (RFC 4226).
 *
 * @param {string} secret base32 secret
 * @param {number} counter
 * @param {number} digits
 */
function hotp(secret, counter, digits = DEFAULT_DIGITS) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac(DEFAULT_ALGORITHM, key).update(buf).digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const code = binary % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/**
 * TOTP — the time-based one-time password (RFC 6238).
 *
 * @param {string} secret
 * @param {{timestamp?: number, period?: number, digits?: number}} options
 */
function totp(secret, options = {}) {
  const { timestamp = Date.now(), period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS } = options;
  const counter = Math.floor(timestamp / 1000 / period);
  return hotp(secret, counter, digits);
}

/** Constant-time comparison of two codes. */
function safeEqualCode(a, b) {
  const bufA = Buffer.from(String(a || '').trim());
  const bufB = Buffer.from(String(b || '').trim());
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a TOTP code, allowing for a small clock drift.
 *
 * @param {string} secret
 * @param {string} code
 * @param {{timestamp?: number, window?: number, period?: number, digits?: number}} options
 *        `window` is the number of steps before and after the current one.
 * @returns {boolean}
 */
function verify(secret, code, options = {}) {
  const { timestamp = Date.now(), window = 1, period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS } = options;
  const candidate = String(code || '').trim();
  if (!/^\d+$/.test(candidate) || candidate.length !== digits) return false;

  const counter = Math.floor(timestamp / 1000 / period);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(secret, counter + offset, digits);
    if (safeEqualCode(expected, candidate)) return true;
  }
  return false;
}

/**
 * The `otpauth://` URI that authenticator apps scan.
 *
 * @param {string} secret
 * @param {string} account the user's login name
 * @param {string} issuer the application name shown in the app
 */
function otpauthUrl(secret, account, issuer = 'Linkarium') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Single-use recovery codes (human-friendly, unambiguous alphabet). */
function generateRecoveryCodes(count = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = crypto.randomBytes(11);
    let code = '';
    for (let j = 0; j < 11; j += 1) {
      if (j === 5) {
        code += '-';
        continue;
      }
      code += alphabet[bytes[j] % alphabet.length];
    }
    codes.push(code);
  }
  return codes;
}

/** Hash a recovery code for storage (sha256 hex). */
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  verify,
  safeEqualCode,
  otpauthUrl,
  generateRecoveryCodes,
  hashRecoveryCode,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
};

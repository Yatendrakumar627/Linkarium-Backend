const mongoose = require('mongoose');

// A device session, keyed by the refresh token's `jti`.
//
// Sessions make two things possible that the tokenVersion counter alone could
// not do:
//
//   1. "Sign out this device" — revoke a single session instead of every
//      outstanding token.
//   2. Refresh-token reuse detection — if a refresh token that was already
//      exchanged is presented again, the token was stolen. Every session of
//      that user is revoked immediately.
//
// The access token is not tracked here: it is short lived and stateless.
const sessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // The `jti` claim of the refresh token this session was created with.
    jti: {
      type: String,
      required: true,
      unique: true,
    },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    // A short human label derived from the user agent ("Chrome on Windows").
    device: { type: String, default: 'Unknown device' },
    lastUsedAt: { type: Date, default: Date.now },
    // Set the moment the refresh token is exchanged. A second presentation of
    // the same jti is reuse, not a normal flow.
    rotatedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: true,
  }
);

// Expired sessions are removed automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Listing the user's active devices.
sessionSchema.index({ user: 1, revokedAt: 1, lastUsedAt: -1 });

module.exports = mongoose.model('Session', sessionSchema);

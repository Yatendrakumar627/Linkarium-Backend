const mongoose = require('mongoose');

// A personal access token, used by the browser extension, the PWA and any
// script that wants to talk to the API without a browser session.
//
// The full secret is shown to the user exactly once, at creation. Only a
// SHA-256 hash is stored, so a database leak does not hand out working keys.
// The `prefix` is stored in clear so the key can be looked up without a
// full-collection scan.
const apiKeySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    // The public part of the key, e.g. "a1b2c3d4". Unique.
    prefix: {
      type: String,
      required: true,
      unique: true,
    },
    // sha256(full secret) - hex. Never returned by a generic read.
    hash: {
      type: String,
      required: true,
      select: false,
    },
    // e.g. ['links:read', 'links:write']
    scopes: {
      type: [String],
      default: ['links:read'],
    },
    lastUsedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

apiKeySchema.index({ user: 1, revokedAt: 1, createdAt: -1 });

module.exports = mongoose.model('ApiKey', apiKeySchema);

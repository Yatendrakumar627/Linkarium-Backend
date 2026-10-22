const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
      select: false,
    },
    avatarColor: {
      type: String,
      // Function default => a fresh random color per document (a plain string
      // would be computed once at process start and reused for every user).
      default: () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
    // --- Two-factor authentication (TOTP) ---
    totp: {
      // The shared secret. Never returned by default (select: false) so it
      // cannot leak through a generic user read.
      secret: { type: String, default: null, select: false },
      enabled: { type: Boolean, default: false },
      verifiedAt: { type: Date, default: null },
    },
    // Single-use recovery codes, stored hashed.
    recoveryCodes: { type: [String], default: [], select: false },
    // --- User preferences ---
    preferences: {
      digestEnabled: { type: Boolean, default: false },
      // 0 = Sunday .. 6 = Saturday
      digestDay: { type: Number, default: 1 },
      // Hour of day the weekly digest is sent (in the user's timezone).
      digestHour: { type: Number, default: 8 },
      // IANA timezone, e.g. "Europe/Berlin". Used for the digest and for the
      // daily activity buckets.
      timezone: { type: String, default: 'UTC' },
      theme: { type: String, default: 'dark' },
      defaultView: { type: String, default: 'dashboard' },
      // Fetch OpenGraph/article metadata when a link is saved.
      autoEnrich: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('User', userSchema);

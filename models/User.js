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
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
      index: true,
    },
    isMaster: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      index: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    lastLoginIp: {
      type: String,
      default: '',
    },
    loginCount: {
      type: Number,
      default: 0,
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
      // When the last digest email was sent. Used to avoid sending twice when
      // a scheduler run is delayed past the target hour.
      lastDigestAt: { type: Date, default: null },
      // Color classification modes:
      // - 'tag' (tag-wise): all cards sharing a tag have same color (and active tag view)
      // - 'collection' (collection-wise): all cards in collection have same collection color
      // - 'blend' (harmonic blend): shortest-arc HSL blend between collection, tag & link
      // - 'brand' (brand-wise): authentic brand & domain intelligence (YouTube, GitHub, Netlify, etc.)
      // - 'own' (independent): individually assigned link color
      colorMode: {
        type: String,
        enum: ['tag', 'collection', 'blend', 'brand', 'own', 'tag-first', 'collection-first'],
        default: 'collection',
      },
      // User-configured custom tag colors { [tagName]: '#hexColor' }
      tagColors: {
        type: Map,
        of: String,
        default: () => new Map(),
      },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('User', userSchema);

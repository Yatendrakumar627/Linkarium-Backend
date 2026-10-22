const mongoose = require('mongoose');

const collectionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    color: {
      type: String,
      // Function default => fresh random color per document.
      default: () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
    },
    // The owner. Kept as `user` so every existing query keeps working.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // --- Public sharing ---
    shared: {
      enabled: { type: Boolean, default: false },
      // The random token in the public URL (/s/<slug>).
      slug: { type: String, default: null },
      // 'read' today; 'write' is reserved for a future collaborative mode.
      permission: { type: String, enum: ['read', 'write'], default: 'read' },
      expiresAt: { type: Date, default: null },
      sharedAt: { type: Date, default: null },
    },
    // --- Workspace members ---
    members: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        role: { type: String, enum: ['viewer', 'editor'], default: 'viewer' },
        addedAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

collectionSchema.index({ user: 1, name: 1 }, { unique: true });

// Public shares are looked up by slug. Only documents with a non-null string slug are indexed.
collectionSchema.index(
  { 'shared.slug': 1 },
  { unique: true, partialFilterExpression: { 'shared.slug': { $type: 'string' } } }
);

// Membership lookups.
collectionSchema.index({ 'members.user': 1 });

module.exports = mongoose.model('Collection', collectionSchema);

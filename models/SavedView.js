const mongoose = require('mongoose');

// Saved views and automation rules share one model.
//
// A saved view is a stored query string: clicking it re-runs the same search
// the user typed by hand. A rule is a saved view that also carries actions —
// it is evaluated whenever a link is saved and applies those actions
// (auto-tag, auto-collect, star, archive).
//
// Both are powered by the query language (server/utils/querylang.js), so a
// rule can use exactly the same grammar as the search box.

const savedViewSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // 'view' = a saved search. 'rule' = a saved search with actions.
    kind: {
      type: String,
      enum: ['view', 'rule'],
      default: 'view',
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    // The query-language string, e.g. "tag:ai visits:>10".
    query: {
      type: String,
      default: '',
      maxlength: 500,
    },
    // A Tabler icon name, resolved on the client through an icon map.
    icon: {
      type: String,
      default: 'IconBookmark',
    },
    color: {
      type: String,
      default: '#8b5cf6',
    },
    order: {
      type: Number,
      default: 0,
    },
    pinned: {
      type: Boolean,
      default: false,
    },
    enabled: {
      type: Boolean,
      default: true,
    },

    // --- rule actions (kind === 'rule' only) ---
    actions: {
      addTags: { type: [String], default: [] },
      removeTags: { type: [String], default: [] },
      collectionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Collection',
        default: null,
      },
      favorite: { type: Boolean, default: false },
      archive: { type: Boolean, default: false },
    },

    // Rule bookkeeping.
    runCount: { type: Number, default: 0 },
    lastRunAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// The sidebar lists views and rules separately, each in its own order.
savedViewSchema.index({ user: 1, kind: 1, order: 1 });

// A user cannot have two saved views with the same name.
savedViewSchema.index({ user: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('SavedView', savedViewSchema);

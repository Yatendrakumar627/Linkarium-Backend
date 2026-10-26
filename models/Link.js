const mongoose = require('mongoose');
const { canonicalizeUrl } = require('../utils/canonical');
const { buildSearchTokens } = require('../utils/text');

const linkSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    collectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Collection',
      default: null,
    },
    tags: {
      type: [String],
      default: [],
    },
    favorite: {
      type: Boolean,
      default: false,
    },
    color: {
      type: String,
      required: true,
    },
    visits: {
      type: Number,
      default: 0,
    },
    lastVisitedAt: {
      type: Date,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
    // Canonical URL — the identity key used for duplicate detection. It is
    // derived from `url` and never used to open the link (the raw URL the
    // user saved is kept in `url`).
    canonicalUrl: {
      type: String,
      default: null,
    },
    // Host + registrable domain, stored so "domain:" filters are index-backed.
    host: {
      type: String,
      default: null,
    },
    hostLabel: {
      type: String,
      default: null,
    },
    // Lowercased searchable tokens (title + tags + description + URL parts).
    tokens: {
      type: [String],
      default: [],
    },
    titleLower: {
      type: String,
      default: '',
    },
    // Link health — filled in by the link-health checker.
    health: {
      status: {
        type: String,
        enum: ['unknown', 'healthy', 'broken', 'stale'],
        default: 'unknown',
      },
      httpStatus: { type: Number, default: null },
      error: { type: String, default: null },
      errorKind: { type: String, default: null },
      checkedAt: { type: Date, default: null },
      // The last time the link answered successfully. Used by the "stale"
      // filter: a link that has not been verified in a long time may be dead.
      lastOkAt: { type: Date, default: null },
      nextCheckAt: { type: Date, default: null },
      failures: { type: Number, default: 0 },
      latencyMs: { type: Number, default: null },
      finalUrl: { type: String, default: null },
    },
    // Archive: hidden from the main list but not deleted (and reversible).
    archivedAt: {
      type: Date,
      default: null,
    },
    // Set when this link was merged into another one (duplicate merge).
    mergedInto: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Link',
      default: null,
    },
    note: {
      type: String,
      default: '',
      trim: true,
      maxlength: 5000,
    },
    // OpenGraph / Twitter card metadata, fetched by the enrichment worker.
    // Empty until the link has been enriched.
    og: {
      title: { type: String, default: '' },
      description: { type: String, default: '' },
      image: { type: String, default: '' },
      favicon: { type: String, default: '' },
      siteName: { type: String, default: '' },
      type: { type: String, default: '' },
      fetchedAt: { type: Date, default: null },
      error: { type: String, default: '' },
    },
    // The main content of the page, extracted for reader mode and full-text
    // search. Capped at 20 000 characters.
    //
    // The body is excluded from normal queries (`select: false`) — shipping it
    // with every card would multiply the size of every list response. The
    // reader endpoint asks for it explicitly.
    article: {
      text: { type: String, default: '', select: false },
      wordCount: { type: Number, default: 0 },
      extractedAt: { type: Date, default: null },
    },
    // Searchable tokens built from the article body. Kept separate from
    // `tokens` so the hot metadata index stays small — an article can
    // contribute hundreds of words.
    articleTokens: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

// One active (non-trashed) link per canonical URL per user, enforced at the
// database so concurrent creates can't race past the application-level
// duplicate check. Trashed links (deletedAt set) are excluded, allowing
// re-saving a URL that sits in the trash... until it is restored (routes
// handle that E11000).
//
// The partial filter also requires canonicalUrl to be a string: documents
// written before the canonical URL engine existed have no canonicalUrl yet,
// and a unique index would treat every one of them as the same value. The
// migration script backfills them (server/scripts/migrate-v2.js).
linkSchema.index(
  { user: 1, canonicalUrl: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null, canonicalUrl: { $type: 'string' } },
  }
);

// Listing queries: user + not-deleted, ordered by creation date.
linkSchema.index({ user: 1, deletedAt: 1, createdAt: -1 });

// Sidebar counters and filtered lists. Each of these keeps a very common
// predicate (favourites, health state, collection membership) inside the
// index instead of filtering the user's whole link set after the fact.
linkSchema.index({ user: 1, deletedAt: 1, favorite: 1 });
linkSchema.index({ user: 1, deletedAt: 1, 'health.status': 1 });
linkSchema.index({ user: 1, deletedAt: 1, collectionId: 1 });

// Search: token prefix lookups and domain filters stay index-backed.
linkSchema.index({ user: 1, tokens: 1 });
linkSchema.index({ user: 1, host: 1 });
linkSchema.index({ user: 1, hostLabel: 1 });

// The link-health worker claims links whose next check is due. This index
// keeps that claim a bounded, index-backed read instead of a collection scan.
linkSchema.index({ 'health.nextCheckAt': 1 });

// The archive view: the user's archived links, newest first.
linkSchema.index({ user: 1, archivedAt: 1, deletedAt: 1, createdAt: -1 });

// Links that were merged into another one (the duplicates view).
linkSchema.index({ user: 1, mergedInto: 1 });

// Full-text search inside the extracted article body.
linkSchema.index({ user: 1, articleTokens: 1 });

// The resurfacing engine: forgotten favourites and never-opened links.
linkSchema.index({ user: 1, favorite: 1, lastVisitedAt: -1 });
linkSchema.index({ user: 1, visits: 1, createdAt: -1 });

// Keep the derived fields in sync whenever a link is written.
linkSchema.pre('validate', function syncDerivedFields() {
  const title = String(this.title || '').trim();
  if (title) this.titleLower = title.toLowerCase();

  const canonical = canonicalizeUrl(this.url);
  if (canonical) {
    this.host = canonical.host;
    this.hostLabel = canonical.hostLabel;
    // Merged links yield their canonical URL so the unique index allows them
    // to coexist with the active link they were folded into.
    this.canonicalUrl = this.mergedInto ? null : canonical.canonical;
  }

  this.tokens = buildSearchTokens({
    title: this.title,
    description: this.description,
    tags: this.tags,
    url: this.url,
    note: this.note,
  });

  // Article tokens are rebuilt from the extracted body. A link that was never
  // enriched keeps an empty array (and therefore costs nothing in the index).
  //
  // The article body is excluded from list queries (it is far too big to ship
  // with every card), so a link loaded without it must keep the tokens it
  // already has — otherwise saving a favourite would wipe the full-text index
  // of that link.
  const articleLoaded = this.isNew || this.isSelected('article.text');
  if (articleLoaded) {
    this.articleTokens = this.article?.text
      ? buildSearchTokens({ title: this.article.text }, { limit: 400 })
      : [];
  }
});

module.exports = mongoose.model('Link', linkSchema);
/**
 * Linkarium v3 migration — prepares the database for the V3 features.
 *
 *   node scripts/migrate-v3.js            # dry run (default, writes nothing)
 *   node scripts/migrate-v3.js --apply    # actually write
 *
 * What it does:
 *   1. rebuilds the search tokens so that the private note is searchable
 *   2. creates the new indexes (archive, duplicates, article search, health)
 *   3. creates the indexes of the new collections (locks, rate limits,
 *      sessions, API keys, saved views, challenges)
 *
 * The dry run prints exactly what would change and nothing is written.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Link = require('../models/Link');
const Lock = require('../models/Lock');
const RateLimit = require('../models/RateLimit');
const Session = require('../models/Session');
const ApiKey = require('../models/ApiKey');
const SavedView = require('../models/SavedView');
const Challenge = require('../models/Challenge');
const Collection = require('../models/Collection');
const User = require('../models/User');
const { buildSearchTokens } = require('../utils/text');
const { canonicalizeUrl } = require('../utils/canonical');

const APPLY = process.argv.includes('--apply');
const BATCH = 200;

// The indexes the V3 features rely on.
const LINK_INDEXES = [
  { key: { 'health.nextCheckAt': 1 }, name: 'health.nextCheckAt_1' },
  { key: { user: 1, archivedAt: 1, deletedAt: 1, createdAt: -1 }, name: 'user_1_archivedAt_1_deletedAt_1_createdAt_-1' },
  { key: { user: 1, mergedInto: 1 }, name: 'user_1_mergedInto_1' },
  { key: { user: 1, articleTokens: 1 }, name: 'user_1_articleTokens_1' },
  { key: { user: 1, favorite: 1, lastVisitedAt: -1 }, name: 'user_1_favorite_1_lastVisitedAt_-1' },
  { key: { user: 1, visits: 1, createdAt: -1 }, name: 'user_1_visits_1_createdAt_-1' },
];

/** Create an index if it does not exist yet. */
async function ensureIndex(collection, key, name, options = {}) {
  const existing = await collection.indexes();
  if (existing.some((i) => i.name === name)) {
    console.log(`  index "${name}" already exists`);
    return false;
  }
  if (APPLY) {
    await collection.createIndex(key, { ...options, name });
    console.log(`  created index "${name}"`);
  } else {
    console.log(`  would create index "${name}"`);
  }
  return true;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in server/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // --- 1. rebuild the search tokens (so the note becomes searchable) ---
  const total = await Link.countDocuments({});
  console.log(`\nLinks in database: ${total}`);

  let processed = 0;
  let changed = 0;

  let lastId = null;
  const seenCanonicalPerUser = new Set();
  let duplicateCount = 0;

  while (true) {
    const filter = lastId ? { _id: { $gt: lastId } } : {};
    const batch = await Link.find(filter)
      .sort({ _id: 1 })
      .limit(BATCH)
      .select('user url title description note tags tokens canonicalUrl host hostLabel deletedAt archivedAt mergedInto');
    if (!batch.length) break;
    lastId = batch[batch.length - 1]._id;

    const operations = [];
    for (const link of batch) {
      processed += 1;
      const canonical = canonicalizeUrl(link.url);
      const tokens = buildSearchTokens({
        title: link.title,
        description: link.description,
        note: link.note,
        tags: link.tags,
        url: link.url,
      });

      let nextCanonical = canonical ? canonical.canonical : null;
      if (nextCanonical && link.user) {
        const userKey = `${link.user}:::${nextCanonical}`;
        if (seenCanonicalPerUser.has(userKey)) {
          // Legacy duplicate for this user: keep canonicalUrl null so it doesn't collide with the unique index
          nextCanonical = null;
          duplicateCount += 1;
        } else {
          seenCanonicalPerUser.add(userKey);
        }
      }

      const rowChanged =
        JSON.stringify(link.tokens || []) !== JSON.stringify(tokens) ||
        (link.canonicalUrl || null) !== nextCanonical ||
        (link.host || null) !== (canonical ? canonical.host : null) ||
        (link.hostLabel || null) !== (canonical ? canonical.hostLabel : null);

      if (rowChanged) changed += 1;

      if (APPLY) {
        operations.push({
          updateOne: {
            filter: { _id: link._id },
            update: {
              $set: {
                canonicalUrl: nextCanonical,
                host: canonical ? canonical.host : null,
                hostLabel: canonical ? canonical.hostLabel : null,
                tokens,
                titleLower: String(link.title || '').trim().toLowerCase(),
                deletedAt: link.deletedAt !== undefined ? link.deletedAt : null,
                archivedAt: link.archivedAt !== undefined ? link.archivedAt : null,
                mergedInto: link.mergedInto !== undefined ? link.mergedInto : null,
              },
            },
          },
        });
      }
    }

    if (APPLY && operations.length) {
      await Link.bulkWrite(operations, { ordered: false });
    }

    if (batch.length < BATCH) break;
  }

  console.log(`\nProcessed: ${processed}, rows that need updating: ${changed}`);

  // --- 2. the new link indexes ---
  console.log('\nLink indexes:');
  for (const index of LINK_INDEXES) {
    await ensureIndex(Link.collection, index.key, index.name);
  }

  // --- 3. the new collections ---
  console.log('\nNew collections:');

  await ensureIndex(Lock.collection, { expiresAt: 1 }, 'expiresAt_1', { expireAfterSeconds: 0 });
  await ensureIndex(RateLimit.collection, { resetAt: 1 }, 'resetAt_1', { expireAfterSeconds: 0 });
  await ensureIndex(Session.collection, { expiresAt: 1 }, 'expiresAt_1', { expireAfterSeconds: 0 });
  await ensureIndex(Session.collection, { user: 1, revokedAt: 1, lastUsedAt: -1 }, 'user_1_revokedAt_1_lastUsedAt_-1');
  await ensureIndex(ApiKey.collection, { prefix: 1 }, 'prefix_1', { unique: true });
  await ensureIndex(ApiKey.collection, { user: 1, revokedAt: 1, createdAt: -1 }, 'user_1_revokedAt_1_createdAt_-1');
  await ensureIndex(SavedView.collection, { user: 1, kind: 1, order: 1 }, 'user_1_kind_1_order_1');
  await ensureIndex(SavedView.collection, { user: 1, name: 1 }, 'user_1_name_1', { unique: true });
  await ensureIndex(Challenge.collection, { expiresAt: 1 }, 'expiresAt_1', { expireAfterSeconds: 0 });
  await ensureIndex(Collection.collection, { 'shared.slug': 1 }, 'shared.slug_1', { unique: true, sparse: true });
  await ensureIndex(Collection.collection, { 'members.user': 1 }, 'members.user_1');
  await ensureIndex(User.collection, { email: 1 }, 'email_1', { unique: true });

  // --- 4. a report on the new state ---
  const [archived, merged, users, collections] = await Promise.all([
    Link.countDocuments({ archivedAt: { $ne: null } }),
    Link.countDocuments({ mergedInto: { $ne: null } }),
    User.countDocuments({}),
    Collection.countDocuments({}),
  ]);

  console.log('\nCurrent state:');
  console.log(`  users: ${users}`);
  console.log(`  collections: ${collections}`);
  console.log(`  archived links: ${archived}`);
  console.log(`  merged links: ${merged}`);

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to persist.');
  } else {
    console.log('\nMigration complete.');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

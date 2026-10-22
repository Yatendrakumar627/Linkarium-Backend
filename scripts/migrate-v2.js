/**
 * Linkarium v2 migration — backfills the canonical URL, host and search
 * tokens on existing links and installs the new indexes.
 *
 *   node scripts/migrate-v2.js            # dry run (default, writes nothing)
 *   node scripts/migrate-v2.js --apply    # actually write
 *
 * The dry run prints what would change, including the duplicate links the
 * canonical engine discovers — those are the candidates for the merge tool.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Link = require('../models/Link');
const { canonicalizeUrl } = require('../utils/canonical');
const { buildSearchTokens } = require('../utils/text');

const APPLY = process.argv.includes('--apply');
const BATCH = 200;

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in server/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const total = await Link.countDocuments({});
  console.log(`Links in database: ${total}`);

  let processed = 0;
  let changed = 0;
  const duplicates = new Map();

  let lastId = null;
  while (true) {
    const filter = lastId ? { _id: { $gt: lastId } } : {};
    const batch = await Link.find(filter)
      .sort({ _id: 1 })
      .limit(BATCH)
      .select('url title description tags canonicalUrl host hostLabel tokens user');
    if (!batch.length) break;
    lastId = batch[batch.length - 1]._id;

    const operations = [];
    for (const link of batch) {
      processed += 1;
      const canonical = canonicalizeUrl(link.url);
      const tokens = buildSearchTokens({
        title: link.title,
        description: link.description,
        tags: link.tags,
        url: link.url,
      });

      const nextCanonical = canonical ? canonical.canonical : null;
      const changedRow =
        (link.canonicalUrl || null) !== nextCanonical ||
        (link.host || null) !== (canonical ? canonical.host : null) ||
        (link.hostLabel || null) !== (canonical ? canonical.hostLabel : null) ||
        JSON.stringify(link.tokens || []) !== JSON.stringify(tokens);

      if (changedRow) changed += 1;

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
              },
            },
          },
        });
      }

      if (nextCanonical) {
        const key = `${link.user}:${nextCanonical}`;
        if (!duplicates.has(key)) duplicates.set(key, []);
        duplicates.get(key).push({ _id: link._id, title: link.title, url: link.url });
      }
    }

    if (APPLY && operations.length) {
      await Link.bulkWrite(operations, { ordered: false });
    }

    if (batch.length < BATCH) break;
  }

  const duplicateGroups = [...duplicates.values()].filter((group) => group.length > 1);
  console.log(`Processed: ${processed}, rows that need updating: ${changed}`);
  console.log(`Duplicate groups (same canonical URL): ${duplicateGroups.length}`);
  for (const group of duplicateGroups.slice(0, 20)) {
    console.log('  -');
    for (const item of group) console.log(`      ${item._id}  ${item.title}  ${item.url}`);
  }
  if (duplicateGroups.length > 20) {
    console.log(`  ... and ${duplicateGroups.length - 20} more groups`);
  }

  if (APPLY) {
    // Drop the legacy raw-URL unique index — the canonical index replaces it.
    try {
      await Link.collection.dropIndex('user_1_url_1');
      console.log('Dropped legacy index user_1_url_1');
    } catch (err) {
      console.log(`Legacy index user_1_url_1 not dropped (${err.code || err.message})`);
    }

    // Make sure the new indexes exist (the partial filter keeps documents
    // without a canonicalUrl out of the unique index).
    await Link.collection.createIndex(
      { user: 1, canonicalUrl: 1 },
      {
        name: 'user_1_canonicalUrl_1',
        unique: true,
        partialFilterExpression: { deletedAt: null, canonicalUrl: { $type: 'string' } },
      }
    );
    await Link.collection.createIndex({ user: 1, deletedAt: 1, createdAt: -1 });
    await Link.collection.createIndex({ user: 1, tokens: 1 });
    await Link.collection.createIndex({ user: 1, host: 1 });
    await Link.collection.createIndex({ user: 1, hostLabel: 1 });
    console.log('Indexes created.');

    // Sanity check: the unique index must be usable.
    const indexes = await Link.collection.indexes();
    console.log('Indexes now:', indexes.map((i) => i.name).join(', '));
  } else {
    console.log('\nDry run — nothing was written. Re-run with --apply to persist.');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

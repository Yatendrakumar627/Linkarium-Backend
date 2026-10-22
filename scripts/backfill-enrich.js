/**
 * Linkarium v3 — backfill enrichment script.
 *
 * Batch-enriches links that have no og.fetchedAt, with a delay between
 * requests for politeness and rate-limiting.
 *
 * Usage:
 *   node scripts/backfill-enrich.js                  # dry run by default
 *   node scripts/backfill-enrich.js --apply          # apply enrichment
 *   node scripts/backfill-enrich.js --apply --limit=100
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Link = require('../models/Link');
const { fetchAndExtract, buildEnrichment } = require('../utils/enrichment');
const { buildSearchTokens } = require('../utils/text');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) || 50 : 50;
const DELAY_MS = 250; // polite pause between requests

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in server/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}, Limit: ${LIMIT}`);

  const due = await Link.find({
    deletedAt: null,
    'og.fetchedAt': null,
  })
    .sort({ createdAt: -1 })
    .limit(LIMIT)
    .select('_id url title')
    .lean();

  console.log(`Found ${due.length} unenriched link(s) matching criteria.`);

  if (!APPLY) {
    console.log('\nDry run complete. Run with --apply to fetch and save metadata:');
    console.log('  node scripts/backfill-enrich.js --apply');
    await mongoose.disconnect();
    return;
  }

  let enriched = 0;
  let failed = 0;

  for (let i = 0; i < due.length; i++) {
    const link = due[i];
    process.stdout.write(`[${i + 1}/${due.length}] Enriching ${link.url.slice(0, 50)}... `);

    try {
      const extraction = await fetchAndExtract(link.url);
      if (!extraction.ok) {
        failed += 1;
        await Link.updateOne(
          { _id: link._id },
          {
            $set: {
              'og.fetchedAt': new Date(),
              'og.error': extraction.error || 'Could not fetch page.',
            },
          }
        );
        console.log(`FAILED (${extraction.error || 'error'})`);
      } else {
        enriched += 1;
        const { og, article } = buildEnrichment(extraction, new Date());
        const articleTokens = article.text
          ? buildSearchTokens({ title: article.text }, { limit: 400 })
          : [];

        await Link.updateOne(
          { _id: link._id },
          {
            $set: {
              og,
              article,
              articleTokens,
            },
          }
        );
        console.log(`OK ("${(og.title || link.title).slice(0, 30)}")`);
      }
    } catch (err) {
      failed += 1;
      console.log(`ERR: ${err.message}`);
    }

    if (i < due.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nFinished: ${enriched} enriched, ${failed} failed.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

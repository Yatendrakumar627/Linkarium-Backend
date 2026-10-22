// The enrichment worker.
//
// Fetches the pages of links that have not been enriched yet, so that their
// preview image, description and article text become available.
//
// Enrichment is best-effort: a page that refuses to load is simply left
// unenriched and tried again later. The worker is bounded (a fixed batch, a
// small amount of concurrency) so a run never holds the lease for long.

const Link = require('../../models/Link');
const { fetchAndExtract, buildEnrichment } = require('../../utils/enrichment');
const { buildSearchTokens } = require('../../utils/text');

const INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const BATCH_SIZE = 10;
const CONCURRENCY = 3;

// A link is re-enriched after this long, so that a page which gained a proper
// title later is picked up.
const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

async function mapWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Enrich every link that still needs it.
 *
 * @param {{limit?: number}} options
 */
async function enrichDueLinks(options = {}) {
  const limit = Math.min(options.limit || BATCH_SIZE, 50);
  const now = Date.now();

  const staleBefore = new Date(now - REFRESH_AFTER_MS);

  const due = await Link.find({
    deletedAt: null,
    $or: [
      { 'og.fetchedAt': null },
      { 'og.fetchedAt': { $lt: staleBefore } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('_id url')
    .lean();

  if (due.length === 0) return { enriched: 0, failed: 0 };

  const results = await mapWithConcurrency(due, CONCURRENCY, async (link) => {
    const extraction = await fetchAndExtract(link.url);
    return { link, extraction };
  });

  let enriched = 0;
  let failed = 0;

  const operations = [];
  for (const { link, extraction } of results) {
    if (!extraction.ok) {
      failed += 1;
      // Remember the failure so the UI can explain why there is no preview,
      // and so the worker does not retry the same page immediately.
      operations.push({
        updateOne: {
          filter: { _id: link._id },
          update: {
            $set: {
              'og.fetchedAt': new Date(),
              'og.error': extraction.error || 'Could not fetch the page.',
            },
          },
        },
      });
      continue;
    }

    enriched += 1;
    const { og, article } = buildEnrichment(extraction, new Date());

    // The full-text index is derived from the article body. A bulk write
    // bypasses the model's validation hook, so the tokens are built here.
    const articleTokens = article.text
      ? buildSearchTokens({ title: article.text }, { limit: 400 })
      : [];

    operations.push({
      updateOne: {
        filter: { _id: link._id },
        update: { $set: { og, article, articleTokens } },
      },
    });
  }

  if (operations.length) {
    await Link.bulkWrite(operations, { ordered: false });
  }

  return { enriched, failed };
}

async function run() {
  const result = await enrichDueLinks();
  if (result.enriched > 0 || result.failed > 0) {
    console.log(`🔎 Enriched ${result.enriched} link(s), ${result.failed} failed.`);
  }
  return result;
}

module.exports = {
  name: 'enrich-links',
  intervalMs: INTERVAL_MS,
  run,
  enrichDueLinks,
};

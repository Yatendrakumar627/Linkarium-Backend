// The link-health worker.
//
// Periodically asks the links that are due whether they still work and stores
// the verdict on the link.
//
// The work is bounded: at most BATCH_SIZE links per run, checked with a small
// amount of concurrency. A run therefore finishes in seconds and never holds
// the scheduler's lease for long.

const Link = require('../../models/Link');
const { checkUrl, buildHealthUpdate } = require('../../utils/linkHealth');

const INTERVAL_MS = 60 * 60 * 1000; // hourly
const BATCH_SIZE = 40;
const CONCURRENCY = 5;

/** Run `worker` over `items` with a bounded number of parallel workers. */
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
 * Check every link whose next check is due.
 *
 * @param {{limit?: number}} options
 */
async function checkDueLinks(options = {}) {
  const limit = Math.min(options.limit || BATCH_SIZE, 200);
  const now = new Date();

  const due = await Link.find({
    deletedAt: null,
    $or: [{ 'health.nextCheckAt': null }, { 'health.nextCheckAt': { $lte: now } }],
  })
    .sort({ 'health.nextCheckAt': 1 })
    .limit(limit)
    .select('_id url health user')
    .lean();

  if (due.length === 0) return { checked: 0, healthy: 0, broken: 0, unknown: 0 };

  const verdicts = await mapWithConcurrency(due, CONCURRENCY, async (link) => {
    try {
      const verdict = await checkUrl(link.url);
      return { link, verdict };
    } catch (err) {
      return { link, verdict: null, error: err.message };
    }
  });

  let healthy = 0;
  let broken = 0;
  let unknown = 0;

  const operations = [];
  for (const entry of verdicts) {
    if (!entry.verdict) continue;
    const { verdict } = entry;
    if (verdict.status === 'healthy') healthy += 1;
    else if (verdict.status === 'broken') broken += 1;
    else unknown += 1;

    const health = buildHealthUpdate(entry.link.health, verdict);
    operations.push({
      updateOne: {
        filter: { _id: entry.link._id },
        update: { $set: { health } },
      },
    });
  }

  if (operations.length) {
    await Link.bulkWrite(operations, { ordered: false });
  }

  return { checked: operations.length, healthy, broken, unknown };
}

/** The task definition consumed by the scheduler. */
async function run() {
  const result = await checkDueLinks();
  if (result.checked > 0) {
    console.log(
      `🩺 Checked ${result.checked} link(s): ${result.healthy} healthy, ${result.broken} broken, ${result.unknown} unknown.`
    );
  }
  return result;
}

module.exports = {
  name: 'link-health',
  intervalMs: INTERVAL_MS,
  run,
  checkDueLinks,
};

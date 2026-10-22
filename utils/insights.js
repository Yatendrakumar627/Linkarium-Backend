// The insights engine.
//
// Turns the raw link collection into the handful of answers that are actually
// interesting:
//
//   * which links have been forgotten (favourites that were never opened)
//   * which links were saved but never read
//   * which domains the user keeps coming back to
//   * how the collection grew over time
//
// Everything here is read-only.

const mongoose = require('mongoose');
const Link = require('../models/Link');
const Visit = require('../models/Visit');
const Collection = require('../models/Collection');
const { dayKey: dayKeyInTz, safeTimeZone } = require('./timezone');

const DAY_MS = 24 * 60 * 60 * 1000;

// A favourite that was not opened for this long is considered forgotten.
const FORGOTTEN_AFTER_DAYS = 90;

// A link saved this long ago that was never opened is "still unread".
const NEVER_OPENED_AFTER_DAYS = 14;

/**
 * Links the user probably wants to see again.
 *
 * Three groups, in the order they are returned:
 *   1. `forgotten` — favourites that have not been opened in a long time
 *   2. `unread`   — links saved a while ago that were never opened
 *   3. `stale`    — links that were opened a long time ago and not since
 *
 * @param {string} userId
 * @param {{limit?: number, now?: Date}} options
 */
async function getResurfaceCandidates(userId, options = {}) {
  const limit = Math.min(options.limit || 12, 50);
  const now = options.now ? new Date(options.now) : new Date();
  const forgottenBefore = new Date(now.getTime() - FORGOTTEN_AFTER_DAYS * DAY_MS);
  const unreadBefore = new Date(now.getTime() - NEVER_OPENED_AFTER_DAYS * DAY_MS);

  const base = { user: userId, deletedAt: null, archivedAt: null };

  const [forgotten, unread, stale] = await Promise.all([
    Link.find({ ...base, favorite: true, lastVisitedAt: { $lt: forgottenBefore } })
      .sort({ lastVisitedAt: 1 })
      .limit(limit)
      .select('title url description tags favorite lastVisitedAt createdAt og.image')
      .lean(),
    Link.find({ ...base, visits: 0, createdAt: { $lt: unreadBefore } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('title url description tags favorite lastVisitedAt createdAt og.image')
      .lean(),
    Link.find({ ...base, visits: { $gt: 0 }, lastVisitedAt: { $lt: forgottenBefore } })
      .sort({ lastVisitedAt: 1 })
      .limit(limit)
      .select('title url description tags favorite lastVisitedAt createdAt og.image')
      .lean(),
  ]);

  const seen = new Set();
  const unique = [];
  for (const link of [...forgotten, ...unread, ...stale]) {
    const key = String(link._id);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(link);
    if (unique.length >= limit) break;
  }

  return {
    groups: {
      forgotten,
      unread,
      stale,
    },
    links: unique,
  };
}

/**
 * The domains the user saves from most.
 *
 * @param {string} userId
 * @param {{limit?: number}} options
 */
async function getTopDomains(userId, options = {}) {
  const limit = Math.min(options.limit || 10, 50);

  return Link.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(userId), deletedAt: null, archivedAt: null } },
    { $match: { host: { $ne: null, $nin: ['', 'unknown'] } } },
    {
      $group: {
        _id: '$host',
        count: { $sum: 1 },
        visits: { $sum: '$visits' },
        favorites: { $sum: { $cond: [{ $ifNull: ['$favorite', false] }, 1, 0] } },
      },
    },
    { $sort: { count: -1, visits: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        host: '$_id',
        count: 1,
        visits: 1,
        favorites: 1,
      },
    },
  ]);
}

/**
 * A snapshot of the account: totals, growth and the state of the collection.
 *
 * @param {string} userId
 * @param {{now?: Date, days?: number}} options
 */
async function getOverview(userId, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const days = options.days || 30;
  const since = new Date(now.getTime() - days * DAY_MS);

  const id = new mongoose.Types.ObjectId(userId);
  const base = { user: id, deletedAt: null };

  const [total, favorites, archived, broken, untagged, addedRecently, visitsRecently] = await Promise.all([
    Link.countDocuments(base),
    Link.countDocuments({ ...base, favorite: true }),
    Link.countDocuments({ ...base, archivedAt: { $ne: null } }),
    Link.countDocuments({ ...base, 'health.status': 'broken' }),
    Link.countDocuments({ ...base, tags: { $size: 0 } }),
    Link.countDocuments({ ...base, createdAt: { $gte: since } }),
    Visit.countDocuments({ link: { $in: await linkIds(id) }, createdAt: { $gte: since } }),
  ]);

  // A simple "collection health" score in the 0-100 range.
  const scored = [
    { label: 'Saved links', value: total, weight: 1 },
    { label: 'Favourites', value: favorites, weight: 1.2 },
    { label: 'Visited recently', value: visitsRecently, weight: 1 },
    { label: 'Broken links', value: -broken, weight: 2 },
    { label: 'Untagged links', value: -untagged, weight: 0.5 },
  ];
  const positive = scored.filter((s) => s.value > 0).reduce((sum, s) => sum + s.value * s.weight, 0);
  const negative = scored
    .filter((s) => s.value < 0)
    .reduce((sum, s) => sum + Math.abs(s.value) * s.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - (negative / Math.max(positive, 1)) * 100)));

  return {
    total,
    favorites,
    archived,
    broken,
    untagged,
    addedRecently,
    visitsRecently,
    days,
    score,
  };
}

/**
 * A GitHub-style activity heatmap: one row per weekday, one column per week.
 *
 * @param {string} userId
 * @param {{weeks?: number, tz?: string, now?: Date}} options
 */
async function getVisitHeatmap(userId, options = {}) {
  const weeks = Math.min(options.weeks || 26, 53);
  const tz = safeTimeZone(options.tz || 'UTC');
  const now = options.now ? new Date(options.now) : new Date();

  const id = new mongoose.Types.ObjectId(userId);

  const since = new Date(now.getTime() - weeks * 7 * DAY_MS);
  // Visits are always scoped to the user and pruned when their link is
  // permanently deleted (see links.js / cleanupTrash), so there is no need to
  // load every link id just to check for an empty account. A user with no
  // visits simply produces an all-zero grid.
  const visits = await Visit.find({ user: id, visitedAt: { $gte: since } }).select('visitedAt').lean();

  // Bucket the visits by local day.
  const buckets = new Map();
  for (const visit of visits) {
    const key = dayKeyInTz(visit.visitedAt, tz);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  // Build the grid: the last `weeks` weeks, oldest first.
  const cells = [];
  let max = 0;
  for (let i = weeks * 7 - 1; i >= 0; i -= 1) {
    const date = new Date(now.getTime() - i * DAY_MS);
    const key = dayKeyInTz(date, tz);
    const count = buckets.get(key) || 0;
    if (count > max) max = count;
    cells.push({ date: key, count, weekday: weekdayOfKey(key) });
  }

  return {
    weeks,
    cells,
    totals: { visits: visits.length, days: buckets.size },
    max,
  };
}

/** The weekday (0 = Sunday) of a "YYYY-MM-DD" key. */
function weekdayOfKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return 0;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The health of every collection: how many links are broken, how many were
 * never opened.
 *
 * @param {string} userId
 */
async function getCollectionsHealth(userId) {
  const id = new mongoose.Types.ObjectId(userId);
  const collections = await Collection.find({ user: id })
    .sort({ name: 1 })
    .select('_id name color')
    .lean();

  const stats = await Link.aggregate([
    { $match: { user: id, deletedAt: null, archivedAt: null } },
    {
      $group: {
        _id: '$collectionId',
        total: { $sum: 1 },
        broken: { $sum: { $cond: [{ $eq: ['$health.status', 'broken'] }, 1, 0] } },
        neverVisited: { $sum: { $cond: [{ $eq: ['$visits', 0] }, 1, 0] } },
        visits: { $sum: '$visits' },
      },
    },
  ]);

  const byId = new Map(stats.map((s) => [String(s._id), s]));

  return collections.map((c) => {
    const s = byId.get(String(c._id)) || { total: 0, broken: 0, neverVisited: 0, visits: 0 };
    return {
      id: c._id,
      name: c.name,
      color: c.color,
      total: s.total,
      broken: s.broken,
      neverVisited: s.neverVisited,
      visits: s.visits,
      brokenPercent: s.total ? Math.round((s.broken / s.total) * 100) : 0,
      neverVisitedPercent: s.total ? Math.round((s.neverVisited / s.total) * 100) : 0,
    };
  });
}

/** All active link ids of a user. */
async function linkIds(id) {
  const links = await Link.find({ user: id, deletedAt: null }).select('_id').lean();
  return links.map((l) => l._id);
}

module.exports = {
  getResurfaceCandidates,
  getTopDomains,
  getOverview,
  getVisitHeatmap,
  getCollectionsHealth,
  FORGOTTEN_AFTER_DAYS,
  NEVER_OPENED_AFTER_DAYS,
};

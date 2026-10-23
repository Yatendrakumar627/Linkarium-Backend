const express = require('express');
const mongoose = require('mongoose');
const Link = require('../models/Link');
const Collection = require('../models/Collection');
const Visit = require('../models/Visit');
const auth = require('../middleware/auth');
const {
  safeTimeZone,
  makeDateFormatter,
  startOfDayInTz,
  formatDayLabel,
} = require('../utils/timezone');

const router = express.Router();

router.use(auth);

// GET /api/analytics/summary
router.get('/summary', async (req, res) => {
  try {
    const id = new mongoose.Types.ObjectId(req.userId);

    // One pass over the user's links replaces six separate countDocuments
    // round-trips. Each counter is a conditional sum, so the whole summary is a
    // single aggregation; collections still live in their own collection.
    const [countsAgg, collections] = await Promise.all([
      Link.aggregate([
        { $match: { user: id } },
        {
          $group: {
            _id: null,
            totalLinks: { $sum: { $cond: [{ $eq: ['$deletedAt', null] }, 1, 0] } },
            favoriteLinks: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$deletedAt', null] }, { $eq: ['$favorite', true] }] },
                  1,
                  0,
                ],
              },
            },
            totalVisits: {
              $sum: { $cond: [{ $eq: ['$deletedAt', null] }, { $ifNull: ['$visits', 0] }, 0] },
            },
            trashCount: { $sum: { $cond: [{ $ne: ['$deletedAt', null] }, 1, 0] } },
            uncategorizedLinks: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$deletedAt', null] }, { $eq: ['$collectionId', null] }] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      Collection.countDocuments({ user: req.userId }),
    ]);

    const counts = countsAgg[0] || {};

    res.json({
      totalLinks: counts.totalLinks || 0,
      favoriteLinks: counts.favoriteLinks || 0,
      totalVisits: counts.totalVisits || 0,
      totalCollections: collections,
      trashCount: counts.trashCount || 0,
      uncategorizedLinks: counts.uncategorizedLinks || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load analytics.' });
  }
});

// GET /api/analytics/recently-visited
router.get('/recently-visited', async (req, res) => {
  try {
    // Over-fetch a little and then trim: the limit must not be spent on
    // visits whose link has since been deleted (populate yields null for
    // those), or the sidebar can show fewer than eight recent pages.
    const visits = await Visit.find({ user: req.userId })
      .sort({ visitedAt: -1 })
      .limit(50)
      .populate({ path: 'link', match: { deletedAt: null }, select: 'title url color collectionId tags favorite' })
      .lean();

    res.json(
      visits
        .filter((v) => v.link)
        .slice(0, 8)
        .map((v) => ({
          id: v._id,
          visitedAt: v.visitedAt,
          link: v.link,
          linkId: v.link._id,
        }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load recent visits.' });
  }
});

// GET /api/analytics/top-links
router.get('/top-links', async (req, res) => {
  try {
    const links = await Link.find({ user: req.userId, deletedAt: null })
      .sort({ visits: -1, lastVisitedAt: -1 })
      .limit(5)
      .select('title url description tags favorite color visits lastVisitedAt createdAt collectionId og.image')
      .lean();
    res.json(links);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load top links.' });
  }
});

// GET /api/analytics/visits?days=14&tz=America/New_York — daily visit counts bucketed in the client's timezone
router.get('/visits', async (req, res) => {
  try {
    const days = Math.max(Math.min(parseInt(req.query.days, 10) || 14, 90), 1);
    const tz = safeTimeZone(req.query.tz);
    const fmt = makeDateFormatter(tz);
    const today = fmt(new Date());

    const dates = [];
    const cursor = startOfDayInTz(today.y, today.m, today.d, tz);
    cursor.setUTCDate(cursor.getUTCDate() - (days - 1));
    for (let i = 0; i < days; i++) {
      dates.push({ key: fmt(cursor).key, utc: cursor.getTime() });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const result = await Visit.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(req.userId),
          visitedAt: { $gte: new Date(dates[0].utc) },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$visitedAt', timezone: tz } },
          count: { $sum: 1 },
        },
      },
    ]);

    const map = {};
    for (const r of result) map[r._id] = r.count;

    const labels = dates.map((d) => formatDayLabel(new Date(d.utc), tz));
    const values = dates.map((d) => map[d.key] || 0);

    res.json({ days, labels, values });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load visit analytics.' });
  }
});

module.exports = router;
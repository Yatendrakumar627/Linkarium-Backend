const express = require('express');
const mongoose = require('mongoose');
const Link = require('../models/Link');
const Collection = require('../models/Collection');
const Visit = require('../models/Visit');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth);

// GET /api/analytics/summary
router.get('/summary', async (req, res) => {
  try {
    const id = new mongoose.Types.ObjectId(req.userId);
    const [links, favorites, visits, collections, trashCount] = await Promise.all([
      Link.countDocuments({ user: req.userId, deletedAt: null }),
      Link.countDocuments({ user: req.userId, favorite: true, deletedAt: null }),
      Link.aggregate([
        { $match: { user: id, deletedAt: null } },
        { $group: { _id: null, total: { $sum: '$visits' } } },
      ]),
      Collection.countDocuments({ user: req.userId }),
      Link.countDocuments({ user: req.userId, deletedAt: { $ne: null } }),
    ]);

    res.json({
      totalLinks: links,
      favoriteLinks: favorites,
      totalVisits: visits[0]?.total || 0,
      totalCollections: collections,
      trashCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load analytics.' });
  }
});

// GET /api/analytics/recently-visited
router.get('/recently-visited', async (req, res) => {
  try {
    const visits = await Visit.find({ user: req.userId })
      .sort({ visitedAt: -1 })
      .limit(8)
      .populate('link', 'title url color collectionId tags favorite');

    res.json(
      visits
        .filter((v) => v.link)
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
    const links = await Link.find({ user: req.userId, deletedAt: null }).sort({ visits: -1, lastVisitedAt: -1 }).limit(5);
    res.json(links);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load top links.' });
  }
});

// GET /api/analytics/visits?days=14&tz=America/New_York — daily visit counts bucketed in the client's timezone
router.get('/visits', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 14, 90);
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

function safeTimeZone(tz) {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return String(tz);
  } catch {
    return 'UTC';
  }
}

// Returns a function mapping a Date -> { y, m, d, key, utcOffsetMs } in a given IANA timezone
function makeDateFormatter(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return (date) => {
    const p = fmt.formatToParts(date);
    const get = (type) => p.find((x) => x.type === type)?.value;
    const hour = get('hour') === '24' ? '00' : get('hour');
    const y = get('year');
    const m = get('month');
    const d = get('day');
    return {
      y: Number(y),
      m: Number(m),
      d: Number(d),
      key: `${y}-${m}-${d}`,
      utcOffsetMs:
        Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hour), Number(get('minute')), Number(get('second'))) -
        date.getTime(),
    };
  };
}

function startOfDayInTz(y, m, d, tz) {
  const fmt = makeDateFormatter(tz);
  let instant = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 4; i++) {
    instant = Date.UTC(y, m - 1, d) - fmt(new Date(instant)).utcOffsetMs;
  }
  return new Date(instant);
}

function formatDayLabel(date, tz) {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, month: 'short', day: 'numeric' }).format(date);
}

module.exports = router;
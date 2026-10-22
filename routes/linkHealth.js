const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const Link = require('../models/Link');
const auth = require('../middleware/auth');
const { isObjectId, parseLimit } = require('../utils/validators');
const { checkUrl, buildHealthUpdate } = require('../utils/linkHealth');

const router = express.Router();

router.use(auth);

// Checking a link makes the server fetch it, so the endpoint is throttled
// separately from the general API limit.
const checkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `link-health:${req.userId || ipKeyGenerator(req.ip)}`,
  handler: (req, res) => res.status(429).json({ error: 'Too many link checks. Please try again in a minute.' }),
});

// GET /api/link-health/summary — how many links are healthy, broken, unknown…
router.get('/summary', async (req, res) => {
  try {
    const base = { user: req.userId, deletedAt: null, archivedAt: null };

    const [healthy, broken, unknown, stale, neverChecked, archived] = await Promise.all([
      Link.countDocuments({ ...base, 'health.status': 'healthy' }),
      Link.countDocuments({ ...base, 'health.status': 'broken' }),
      Link.countDocuments({ ...base, 'health.status': 'unknown' }),
      Link.countDocuments({
        ...base,
        $or: [
          { 'health.lastOkAt': { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
          { 'health.lastOkAt': null },
        ],
      }),
      Link.countDocuments({ ...base, 'health.checkedAt': null }),
      Link.countDocuments({ user: req.userId, deletedAt: null, archivedAt: { $ne: null } }),
    ]);

    const total = healthy + broken + unknown + neverChecked;

    res.json({ total, healthy, broken, unknown, stale, neverChecked, archived });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/link-health/links — the links that need attention.
router.get('/links', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, { def: 50, min: 1, max: 200 });
    const status = String(req.query.status || 'broken').toLowerCase();

    const base = { user: req.userId, deletedAt: null, archivedAt: null };
    const query = { ...base };

    if (status === 'stale') {
      query.$or = [
        { 'health.lastOkAt': { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
        { 'health.lastOkAt': null },
      ];
    } else if (status === 'all') {
      query.$or = [
        { 'health.status': { $in: ['broken', 'unknown'] } },
        { 'health.lastOkAt': { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
        { 'health.lastOkAt': null },
      ];
    } else if (status === 'never-checked') {
      query['health.checkedAt'] = null;
    } else {
      query['health.status'] = status;
    }

    const links = await Link.find(query)
      .sort({ 'health.checkedAt': 1, createdAt: -1 })
      .limit(limit)
      .select('title url description tags favorite health archivedAt createdAt lastVisitedAt og.image')
      .lean();

    res.json({ links });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

async function performCheckOne(userId, linkId) {
  if (!isObjectId(linkId)) {
    const err = new Error('Invalid link id.');
    err.status = 400;
    throw err;
  }
  const link = await Link.findOne({ _id: linkId, user: userId, deletedAt: null });
  if (!link) {
    const err = new Error('Link not found.');
    err.status = 404;
    throw err;
  }
  const verdict = await checkUrl(link.url);
  link.health = buildHealthUpdate(link.health, verdict);
  await link.save();
  return link.health;
}

// POST /api/link-health/:id/check — check one link right now.
router.post('/:id/check', checkLimiter, async (req, res) => {
  try {
    const health = await performCheckOne(req.userId, req.params.id);
    res.json({ health });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/link-health/check-one — check one link specified in body.
router.post('/check-one', checkLimiter, async (req, res) => {
  try {
    const { id } = req.body || {};
    const health = await performCheckOne(req.userId, id);
    res.json({ health });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/link-health/recheck or /check — schedule links for a new check.
const handleRecheck = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => isObjectId(id)) : [];

    const filter = { user: req.userId, deletedAt: null };
    if (ids.length) filter._id = { $in: ids };

    const result = await Link.updateMany(filter, { $set: { 'health.nextCheckAt': new Date(0) } });

    res.json({ scheduled: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
};

router.post('/recheck', handleRecheck);
router.post('/check', handleRecheck);

module.exports = router;

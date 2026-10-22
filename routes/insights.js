const express = require('express');
const auth = require('../middleware/auth');
const { parseLimit } = require('../utils/validators');
const {
  getOverview,
  getTopDomains,
  getResurfaceCandidates,
  getVisitHeatmap,
  getCollectionsHealth,
} = require('../utils/insights');

const router = express.Router();

router.use(auth);

// GET /api/insights/overview — the headline numbers.
router.get('/overview', async (req, res) => {
  try {
    const days = parseLimit(req.query.days, { def: 30, min: 1, max: 365 });
    const overview = await getOverview(req.userId, { days });
    res.json(overview);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/insights/domains — the sites the user saves from most.
router.get('/domains', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, { def: 10, min: 1, max: 50 });
    const domains = await getTopDomains(req.userId, { limit });
    res.json({ domains });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/insights/resurface — links worth looking at again.
router.get('/resurface', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, { def: 12, min: 1, max: 50 });
    const result = await getResurfaceCandidates(req.userId, { limit });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/insights/heatmap — a GitHub-style activity grid.
router.get('/heatmap', async (req, res) => {
  try {
    const weeks = parseLimit(req.query.weeks, { def: 26, min: 1, max: 53 });
    const heatmap = await getVisitHeatmap(req.userId, { weeks, tz: req.query.tz });
    res.json(heatmap);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/insights/collections-health — broken / never-opened per collection.
router.get('/collections-health', async (req, res) => {
  try {
    const collections = await getCollectionsHealth(req.userId);
    res.json({ collections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
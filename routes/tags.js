const express = require('express');
const mongoose = require('mongoose');
const Link = require('../models/Link');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth);

// GET /api/tags — aggregated tags with counts across user's links
router.get('/', async (req, res) => {
  try {
    const result = await Link.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(req.userId),
          deletedAt: null,
        },
      },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 100 },
    ]);

    res.json(result.map((r) => ({ tag: r._id, count: r.count })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
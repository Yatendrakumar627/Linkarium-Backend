const express = require('express');
const mongoose = require('mongoose');
const Link = require('../models/Link');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { isHexColor } = require('../utils/validators');
const { publicUser } = require('../utils/helpers');

const router = express.Router();

router.use(auth);

// GET /api/tags — aggregated tags with counts and custom colors across user's links
router.get('/', async (req, res) => {
  try {
    const [result, user] = await Promise.all([
      Link.aggregate([
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
      ]),
      User.findById(req.userId).select('preferences.tagColors'),
    ]);

    const tagColors = user?.preferences?.tagColors;
    const getColor = (tagName) => {
      if (!tagColors) return null;
      const lower = String(tagName).toLowerCase();
      if (tagColors instanceof Map) return tagColors.get(lower) || null;
      if (typeof tagColors === 'object') return tagColors[lower] || null;
      return null;
    };

    res.json(
      result.map((r) => ({
        tag: r._id,
        count: r.count,
        color: getColor(r._id),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// PATCH /api/tags/:tag/color — update or reset custom color for a tag
router.patch('/:tag/color', async (req, res) => {
  try {
    const rawTag = req.params.tag;
    const cleanTag = String(rawTag || '').toLowerCase().trim().replace(/^#/, '');
    if (!cleanTag) {
      return res.status(400).json({ error: 'Tag name is required.' });
    }

    const { color } = req.body || {};

    if (color !== null && color !== undefined && color !== '') {
      if (typeof color !== 'string' || !isHexColor(color)) {
        return res.status(400).json({ error: 'Color must be a valid 6-character hex string (e.g. #00e5ff).' });
      }
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!user.preferences) user.preferences = {};
    if (!user.preferences.tagColors || !(user.preferences.tagColors instanceof Map)) {
      user.preferences.tagColors = new Map(Object.entries(user.preferences.tagColors || {}));
    }

    if (color && isHexColor(color)) {
      user.preferences.tagColors.set(cleanTag, color.toLowerCase());
    } else {
      user.preferences.tagColors.delete(cleanTag);
    }

    user.markModified('preferences.tagColors');
    await user.save();

    res.json({
      tag: cleanTag,
      color: color && isHexColor(color) ? color.toLowerCase() : null,
      user: publicUser(user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update tag color.' });
  }
});

// PATCH /api/tags/:tag/rename — rename a tag across all links and transfer color
router.patch('/:tag/rename', async (req, res) => {
  try {
    const oldTag = String(req.params.tag || '').toLowerCase().trim().replace(/^#/, '');
    const newTag = String(req.body?.newTag || '').toLowerCase().trim().replace(/^#/, '').replace(/\s+/g, '-');

    if (!oldTag || !newTag) {
      return res.status(400).json({ error: 'Both old and new tag names are required.' });
    }

    if (oldTag === newTag) {
      return res.json({ oldTag, newTag, count: 0 });
    }

    // 1. Pull oldTag and add newTag on links
    const links = await Link.find({
      user: req.userId,
      deletedAt: null,
      tags: oldTag,
    });

    let modifiedCount = 0;
    for (const link of links) {
      const nextTags = link.tags.filter((t) => t.toLowerCase() !== oldTag);
      if (!nextTags.some((t) => t.toLowerCase() === newTag)) {
        nextTags.push(newTag);
      }
      link.tags = nextTags;
      await link.save();
      modifiedCount++;
    }

    // 2. Transfer custom tag color if exists
    const user = await User.findById(req.userId);
    if (user?.preferences?.tagColors) {
      if (!(user.preferences.tagColors instanceof Map)) {
        user.preferences.tagColors = new Map(Object.entries(user.preferences.tagColors || {}));
      }
      const existingColor = user.preferences.tagColors.get(oldTag);
      if (existingColor) {
        user.preferences.tagColors.delete(oldTag);
        user.preferences.tagColors.set(newTag, existingColor);
        user.markModified('preferences.tagColors');
        await user.save();
      }
    }

    res.json({
      oldTag,
      newTag,
      count: modifiedCount,
      user: user ? publicUser(user) : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to rename tag.' });
  }
});

// DELETE /api/tags/:tag — delete a tag from all links and remove custom color
router.delete('/:tag', async (req, res) => {
  try {
    const cleanTag = String(req.params.tag || '').toLowerCase().trim().replace(/^#/, '');
    if (!cleanTag) {
      return res.status(400).json({ error: 'Tag name is required.' });
    }

    // Remove tag from all links
    const result = await Link.updateMany(
      { user: req.userId, deletedAt: null, tags: cleanTag },
      { $pull: { tags: cleanTag } }
    );

    // Remove from user tagColors
    const user = await User.findById(req.userId);
    if (user?.preferences?.tagColors) {
      if (!(user.preferences.tagColors instanceof Map)) {
        user.preferences.tagColors = new Map(Object.entries(user.preferences.tagColors || {}));
      }
      if (user.preferences.tagColors.has(cleanTag)) {
        user.preferences.tagColors.delete(cleanTag);
        user.markModified('preferences.tagColors');
        await user.save();
      }
    }

    res.json({
      tag: cleanTag,
      removedFromLinks: result.modifiedCount,
      user: user ? publicUser(user) : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete tag.' });
  }
});

module.exports = router;
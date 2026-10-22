const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Collection = require('../models/Collection');
const Link = require('../models/Link');
const auth = require('../middleware/auth');
const { randomColor } = require('../utils/helpers');
const { isObjectId, isHexColor } = require('../utils/validators');

const router = express.Router();

router.use(auth);

// GET /api/collections — list with link counts
router.get('/', async (req, res) => {
  try {
    const collections = await Collection.find({ user: req.userId }).sort({ createdAt: -1 });

    const counts = await Link.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(req.userId),
          collectionId: { $ne: null },
          deletedAt: null,
        },
      },
      { $group: { _id: '$collectionId', count: { $sum: 1 } } },
    ]);

    const countMap = {};
    for (const c of counts) countMap[String(c._id)] = c.count;

    const result = collections.map((c) => ({
      id: c._id,
      name: c.name,
      color: c.color,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      count: countMap[String(c._id)] || 0,
      shared: c.shared?.enabled
        ? {
            enabled: true,
            slug: c.shared.slug,
            permission: c.shared.permission,
            expiresAt: c.shared.expiresAt,
            sharedAt: c.shared.sharedAt,
          }
        : { enabled: false, slug: null },
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load collections.' });
  }
});

// POST /api/collections
router.post('/', async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Collection name is required.' });
    }
    if (color !== undefined && color !== null && !isHexColor(color)) {
      return res.status(400).json({ error: 'Invalid color format.' });
    }

    const existing = await Collection.findOne({ user: req.userId, name: String(name).trim() });
    if (existing) {
      return res.status(409).json({ error: 'A collection with this name already exists.' });
    }

    const collection = await Collection.create({
      name: String(name).trim(),
      color: color || randomColor(),
      user: req.userId,
    });

    res.status(201).json({
      id: collection._id,
      name: collection.name,
      color: collection.color,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
      count: 0,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'A collection with this name already exists.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create collection.' });
  }
});

// PATCH /api/collections/:id
router.patch('/:id', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid collection id.' });
  try {
    const collection = await Collection.findOne({ _id: req.params.id, user: req.userId });
    if (!collection) return res.status(404).json({ error: 'Collection not found.' });

    const { name, color } = req.body;

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ error: 'Collection name is required.' });
      }
      if (trimmed !== collection.name) {
        const duplicate = await Collection.findOne({ user: req.userId, name: trimmed });
        if (duplicate) {
          return res.status(409).json({ error: 'A collection with this name already exists.' });
        }
      }
      collection.name = trimmed;
    }
    if (color !== undefined && color !== null) {
      if (!isHexColor(color)) {
        return res.status(400).json({ error: 'Invalid color format.' });
      }
      collection.color = color;
    }

    await collection.save();

    const count = await Link.countDocuments({ user: req.userId, collectionId: collection._id, deletedAt: null });
    res.json({
      id: collection._id,
      name: collection.name,
      color: collection.color,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
      count,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'A collection with this name already exists.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update collection.' });
  }
});

// DELETE /api/collections/:id
router.delete('/:id', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid collection id.' });
  try {
    const collection = await Collection.findOneAndDelete({ _id: req.params.id, user: req.userId });
    if (!collection) return res.status(404).json({ error: 'Collection not found.' });

    await Link.updateMany(
      { user: req.userId, collectionId: collection._id },
      { $set: { collectionId: null } }
    );

    res.json({ message: 'Collection deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete collection.' });
  }
});

// A short, URL-safe token for the public share link.
function makeSlug() {
  return crypto.randomBytes(9).toString('base64url');
}

// POST /api/collections/:id/share — turn on (or rotate) the public share link.
router.post('/:id/share', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid collection id.' });
  try {
    const collection = await Collection.findOne({ _id: req.params.id, user: req.userId });
    if (!collection) return res.status(404).json({ error: 'Collection not found.' });

    const { expiresInDays, rotate = false } = req.body || {};

    let expiresAt = null;
    if (expiresInDays !== undefined && expiresInDays !== null && expiresInDays !== '') {
      const days = Number(expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        return res.status(400).json({ error: 'The expiry must be between 1 and 3650 days.' });
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    // Rotating keeps the old slug only if it was never handed out; a rotated
    // slug always replaces the old one so the previous link stops working.
    if (!collection.shared?.enabled || rotate || !collection.shared?.slug) {
      collection.shared.slug = makeSlug();
    }

    collection.shared.enabled = true;
    collection.shared.permission = 'read';
    collection.shared.expiresAt = expiresAt;
    collection.shared.sharedAt = new Date();

    await collection.save();

    res.json({
      shared: {
        enabled: true,
        slug: collection.shared.slug,
        permission: collection.shared.permission,
        expiresAt: collection.shared.expiresAt,
        sharedAt: collection.shared.sharedAt,
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      // Extremely unlikely slug collision — try once more with a new token.
      return res.status(409).json({ error: 'Could not create a share link. Please try again.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to share the collection.' });
  }
});

// DELETE /api/collections/:id/share — stop sharing.
router.delete('/:id/share', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid collection id.' });
  try {
    const collection = await Collection.findOne({ _id: req.params.id, user: req.userId });
    if (!collection) return res.status(404).json({ error: 'Collection not found.' });

    collection.shared.enabled = false;
    collection.shared.slug = null;
    collection.shared.expiresAt = null;
    collection.shared.sharedAt = null;

    await collection.save();

    res.json({ shared: { enabled: false, slug: null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to stop sharing the collection.' });
  }
});

module.exports = router;
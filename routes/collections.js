const express = require('express');
const mongoose = require('mongoose');
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

module.exports = router;
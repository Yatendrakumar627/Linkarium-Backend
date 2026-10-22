const express = require('express');
const ApiKey = require('../models/ApiKey');
const auth = require('../middleware/auth');
const { isObjectId } = require('../utils/validators');
const { generateApiKey, maskKey } = require('../utils/apiKey');

const router = express.Router();

router.use(auth);

const MAX_NAME = 60;

// The scopes a key can carry.
const SCOPES = ['links:read', 'links:write'];

// GET /api/api-keys — the user's keys (the secret is never returned).
router.get('/', async (req, res) => {
  try {
    const keys = await ApiKey.find({ user: req.userId, revokedAt: null })
      .sort({ createdAt: -1 })
      .select('name prefix scopes lastUsedAt expiresAt createdAt')
      .lean();

    res.json({
      keys: keys.map((k) => ({
        _id: k._id,
        name: k.name,
        masked: maskKey(`lk_${k.prefix}_`),
        prefix: k.prefix,
        scopes: k.scopes,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        createdAt: k.createdAt,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/api-keys — create a key. The secret is shown exactly once.
router.post('/', async (req, res) => {
  try {
    const { name, scopes = ['links:read'], expiresInDays = null } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'A name is required.' });
    }
    if (String(name).length > MAX_NAME) {
      return res.status(400).json({ error: `The name must be ${MAX_NAME} characters or fewer.` });
    }

    const requested = Array.isArray(scopes) ? scopes : [scopes];
    const invalid = requested.filter((s) => !SCOPES.includes(s));
    if (invalid.length) {
      return res.status(400).json({ error: `Unknown scope: ${invalid.join(', ')}.` });
    }
    if (requested.length === 0) {
      return res.status(400).json({ error: 'At least one scope is required.' });
    }

    let expiresAt = null;
    if (expiresInDays !== null && expiresInDays !== undefined && expiresInDays !== '') {
      const days = Number(expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        return res.status(400).json({ error: 'The expiry must be between 1 and 3650 days.' });
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    const generated = generateApiKey();

    const key = await ApiKey.create({
      user: req.userId,
      name: String(name).trim(),
      prefix: generated.prefix,
      hash: generated.hash,
      scopes: requested,
      expiresAt,
    });

    res.status(201).json({
      key: {
        _id: key._id,
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      },
      // The only time the secret is ever available.
      secret: generated.key,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// DELETE /api/api-keys/:id — revoke a key.
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) {
      return res.status(400).json({ error: 'Invalid key id.' });
    }

    const result = await ApiKey.updateOne(
      { _id: id, user: req.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;

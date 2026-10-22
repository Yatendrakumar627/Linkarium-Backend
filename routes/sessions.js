const express = require('express');
const Session = require('../models/Session');
const auth = require('../middleware/auth');
const { isObjectId } = require('../utils/validators');
const { verifyToken } = require('../utils/helpers');
const { describeDevice } = require('../utils/device');

const router = express.Router();

router.use(auth);

const REFRESH_COOKIE_NAME = 'rt';

/** The `jti` of the refresh token in the request's cookie, if any. */
function currentSessionId(req) {
  const rt = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!rt) return null;
  try {
    const payload = verifyToken(rt, 'refresh');
    return payload.jti || null;
  } catch {
    return null;
  }
}

// GET /api/sessions — the devices that are signed in.
router.get('/', async (req, res) => {
  try {
    const sessions = await Session.find({
      user: req.userId,
      revokedAt: null,
      // A rotated token has been superseded by a newer one for the same
      // signed-in device. Listing it would show duplicate devices after every
      // refresh.
      rotatedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ lastUsedAt: -1 })
      .select('jti device userAgent ip lastUsedAt createdAt expiresAt')
      .lean();

    const current = currentSessionId(req);

    res.json({
      sessions: sessions.map((s) => ({
        _id: s._id,
        device: s.device,
        userAgent: s.userAgent,
        ip: s.ip,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        current: s.jti === current,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// DELETE /api/sessions/:id — sign out a single device.
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) {
      return res.status(400).json({ error: 'Invalid session id.' });
    }

    const result = await Session.updateOne(
      { _id: id, user: req.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/sessions/revoke-others — sign out every device except this one.
router.post('/revoke-others', async (req, res) => {
  try {
    const current = currentSessionId(req);

    const filter = { user: req.userId, revokedAt: null };
    if (current) filter.jti = { $ne: current };

    const result = await Session.updateMany(filter, { $set: { revokedAt: new Date() } });
    res.json({ revoked: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
module.exports.describeDevice = describeDevice;

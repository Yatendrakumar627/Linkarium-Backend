// Internal endpoints.
//
// These are not part of the public API: they are guarded by a shared secret
// and exist so that an external scheduler (Render Cron, GitHub Actions, an
// uptime monitor) can wake the server and make it run whatever background
// work is due.
//
// The Render free tier sleeps idle instances, so the in-process scheduler
// stops running while the instance is asleep. An external ping solves that.

const crypto = require('crypto');
const express = require('express');
const { runDueTasks, taskNames, isDue } = require('../workers/scheduler');

const router = express.Router();

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * The secret may arrive as a Bearer token, an `x-cron-secret` header or a
 * `?secret=` query parameter (some cron services can only do GET).
 */
function extractSecret(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.headers['x-cron-secret']) return String(req.headers['x-cron-secret']);
  if (req.query && req.query.secret) return String(req.query.secret);
  return '';
}

/** True when the request carries the configured CRON_SECRET. */
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const provided = extractSecret(req);
  if (!provided) return false;
  return safeEqual(provided, secret);
}

/** Guard used by every internal route. */
function requireSecret(req, res, next) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'CRON_SECRET is not configured on this server.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Invalid cron secret.' });
  }
  return next();
}

// POST /api/internal/cron  (GET is accepted too — some cron services only do GET)
router.post('/cron', requireSecret, async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const only = req.query.task ? String(req.query.task).split(',').map((t) => t.trim()) : null;

    const results = await runDueTasks({ only, force });
    const ran = results.filter((r) => r.ran).length;

    res.json({
      ok: true,
      ran,
      total: results.length,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[cron] run failed:', err.message);
    res.status(500).json({ error: 'Cron run failed.' });
  }
});

router.get('/cron', requireSecret, async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const results = await runDueTasks({ force });
    res.json({
      ok: true,
      ran: results.filter((r) => r.ran).length,
      total: results.length,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[cron] run failed:', err.message);
    res.status(500).json({ error: 'Cron run failed.' });
  }
});

// GET /api/internal/status — what the scheduler knows about its tasks.
router.get('/status', requireSecret, async (req, res) => {
  try {
    const tasks = [];
    for (const name of taskNames()) {
      tasks.push({ name, due: await isDue(name) });
    }
    res.json({ ok: true, tasks, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[cron] status failed:', err.message);
    res.status(500).json({ error: 'Could not read the scheduler status.' });
  }
});

module.exports = router;
module.exports.isAuthorized = isAuthorized;

const User = require('../models/User');

/**
 * High-Security Middleware:
 * 1. Enforces zero-cache headers so admin data and telemetry are never saved to browser disk or intermediate proxies.
 * 2. Directly verifies fresh database state (role and status) to prevent stale JWT privilege escalation.
 * 3. Uses generic error responses to prevent role probing.
 */
module.exports = async function adminAuth(req, res, next) {
  // Prevent browser disk caching, intermediate proxy caching, and CDN retention
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Not authorized.' });
    }

    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      return res.status(401).json({ error: 'Not authorized.' });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended.' });
    }

    req.adminUser = user;
    next();
  } catch (err) {
    console.error('[adminAuth] error:', err.message);
    res.status(500).json({ error: 'Authorization error.' });
  }
};


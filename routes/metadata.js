const express = require('express');
const auth = require('../middleware/auth');
const { detectTitle } = require('../utils/titleEngine');

const router = express.Router();

router.use(auth);

// POST /api/metadata — return a suggested bookmark name and rich title metadata.
// Implements the Title Detection Engine (link-title-detection-engine.md):
// - Provider-specific resolution (YouTube oEmbed, Google Workspace, GitHub, Spotify)
// - Real webpage HTML extraction (og:title, twitter:title, <title>, JSON-LD)
// - Anti-noise filtering & brand suffix cleanup
// - Readable URL path slug fallback (deep content paths & media slugs)
// - Clean hostname / brand fallback for root homepages
router.post('/', async (req, res) => {
  try {
    const rawUrl = req.body?.url;
    if (!rawUrl || typeof rawUrl !== 'string') {
      return res.status(400).json({ error: 'A valid http(s) URL is required.' });
    }

    const result = await detectTitle(rawUrl);

    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'A valid http(s) URL is required.' });
    }

    res.json(result);
  } catch (err) {
    console.error('[metadata] Title detection failed:', err);
    res.status(500).json({ error: 'Failed to read page metadata.' });
  }
});

module.exports = router;


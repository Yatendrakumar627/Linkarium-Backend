const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const auth = require('../middleware/auth');
const { normalizeUrl } = require('../utils/helpers');
const { isHttpUrl } = require('../utils/metadata');
const { fetchAndExtract } = require('../utils/enrichment');

const router = express.Router();

router.use(auth);

// Fetching a page costs the server a real HTTP request, so the preview
// endpoint gets its own budget: twenty previews a minute is plenty for a
// human typing a URL, and cheap to defend against.
const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)),
  handler: (req, res) => res.status(429).json({ error: 'Too many previews. Please try again in a minute.' }),
});

const { detectTitle, cleanCandidateTitle } = require('../utils/titleEngine');

// POST /api/enrich/preview — read a page's OpenGraph card without saving it.
//
// This is what the editor shows while the user is still typing: the real
// title, description and preview image of the destination, so they do not
// have to paste a title by hand. Nothing is written to the database.
router.post('/preview', previewLimiter, async (req, res) => {
  try {
    const url = normalizeUrl(req.body?.url);
    if (!isHttpUrl(url)) {
      return res.status(400).json({ error: 'A valid http(s) URL is required.' });
    }

    // First try standard extraction
    const extraction = await fetchAndExtract(url);

    if (extraction.ok && extraction.og?.title) {
      const og = extraction.og || {};
      const cleanTitle = cleanCandidateTitle(og.title, og.siteName, new URL(url).hostname);
      return res.json({
        ok: true,
        finalUrl: extraction.finalUrl || url,
        og: {
          title: cleanTitle || og.title || '',
          description: og.description || '',
          image: og.image || '',
          favicon: og.favicon || '',
          siteName: og.siteName || '',
          type: og.type || '',
        },
        article: {
          wordCount: extraction.article?.wordCount || 0,
        },
      });
    }

    // If extraction failed or has no title (e.g. YouTube oEmbed needed, 403 bot-blocked, or JS app),
    // leverage the Advanced Title Detection Engine as fallback
    const titleResult = await detectTitle(url);
    if (titleResult.ok && titleResult.title) {
      return res.json({
        ok: true,
        finalUrl: titleResult.canonicalUrl || url,
        og: {
          title: titleResult.title,
          description: titleResult.description || '',
          image: titleResult.thumbnail || '',
          favicon: titleResult.favicon || '',
          siteName: titleResult.siteName || '',
          type: titleResult.provider || '',
        },
        article: {
          wordCount: 0,
        },
      });
    }

    // Both failed
    return res.status(502).json({
      ok: false,
      error: extraction.error || 'Could not fetch the page.',
      errorKind: extraction.errorKind || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not read the page.' });
  }
});


module.exports = router;

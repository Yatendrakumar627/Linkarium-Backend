const express = require('express');
const auth = require('../middleware/auth');
const { normalizeUrl } = require('../utils/helpers');
const {
  siteNameFromHostname,
  registrableLabel,
  productName,
  isKnownBrand,
  isHttpUrl,
  BRAND_NAMES,
} = require('../utils/metadata');

const router = express.Router();

router.use(auth);

// POST /api/metadata — return a suggested bookmark name. The main name of a
// website is always its domain (the part right after http(s)://), so the
// suggestion is always derived from the hostname — never the page title/path.
// For known multi-product brands (Google, Microsoft, Amazon, Apple) a specific
// product name is preferred (gemini.google.com -> Gemini, docs.google.com/
// spreadsheets -> Spreadsheets). Always resolves gracefully.
router.post('/', (req, res) => {
  try {
    const raw = req.body?.url;
    if (!isHttpUrl(normalizeUrl(raw))) {
      return res.status(400).json({ error: 'A valid http(s) URL is required.' });
    }

    const url = normalizeUrl(raw);
    const host = new URL(url).hostname;
    const brandKey = registrableLabel(host);

    if (isKnownBrand(host)) {
      const pathname = new URL(url).pathname;
      const name = productName(brandKey, host, pathname) || BRAND_NAMES[brandKey];
      return res.json({ name: name || null, source: 'brand' });
    }

    const name = siteNameFromHostname(host);
    res.json({ name: name || null, source: 'hostname' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read page metadata.' });
  }
});

module.exports = router;

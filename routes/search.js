const express = require('express');
const mongoose = require('mongoose');
const Link = require('../models/Link');
const Collection = require('../models/Collection');
const auth = require('../middleware/auth');
const { parseQuery, describeAst } = require('../utils/querylang');
const { escapeRegex, tokenize } = require('../utils/text');

const router = express.Router();

router.use(auth);

const MAX_SUGGESTIONS = 10;

// GET /api/search/suggest?q=…
//
// Returns token completions for the word currently being typed plus the
// user's own tags and collection names. The token lookup is a prefix match
// on the indexed `tokens` array, so it stays index-backed.
router.get('/suggest', async (req, res) => {
  try {
    const raw = String(req.query.q || '');
    const trimmed = raw.trim();
    if (!trimmed) {
      return res.json({ suggestions: [], parsed: describeAst(parseQuery('')) });
    }

    // Only complete the last word of the query.
    const parts = trimmed.split(/\s+/);
    const partial = parts.pop() || '';
    const term = partial.toLowerCase();

    const suggestions = new Set();

    const promises = [];

    if (term.length >= 2) {
      const rx = new RegExp(`^${escapeRegex(term)}`);
      promises.push(
        Link.distinct('tokens', {
          user: req.userId,
          deletedAt: null,
          tokens: rx,
        }).catch(() => [])
      );
    } else {
      promises.push(Promise.resolve([]));
    }

    // Tags are a natural completion for "tag:" and free text alike.
    const tagRx = new RegExp(`^${escapeRegex(term)}`, 'i');
    promises.push(
      Link.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(req.userId), deletedAt: null } },
        { $unwind: '$tags' },
        { $match: { tags: tagRx } },
        { $group: { _id: '$tags', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: MAX_SUGGESTIONS },
      ]).catch(() => [])
    );

    // Collection names.
    promises.push(
      Collection.find({
        user: req.userId,
        name: new RegExp(`^${escapeRegex(term)}`, 'i'),
      })
        .select('name')
        .limit(MAX_SUGGESTIONS)
        .lean()
        .catch(() => [])
    );

    const [tokens, tags, collections] = await Promise.all(promises);

    for (const t of tokens) {
      if (t !== term && t.startsWith(term)) suggestions.add(t);
    }

    for (const t of tags) {
      suggestions.add(`tag:${t._id}`);
    }

    for (const c of collections) {
      suggestions.add(`collection:${c.name}`);
    }

    // Operator completions.
    for (const op of ['tag:', 'domain:', 'collection:', 'is:favorite', 'is:untagged', 'is:never-visited', 'is:uncategorized']) {
      if (op.toLowerCase().startsWith(term)) suggestions.add(op);
    }

    const list = [...suggestions].slice(0, MAX_SUGGESTIONS);

    res.json({
      suggestions: list,
      parsed: describeAst(parseQuery(raw)),
      prefix: term,
      tokens: tokenize(partial),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load suggestions.' });
  }
});

module.exports = router;

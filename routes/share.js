const express = require('express');
const Collection = require('../models/Collection');
const Link = require('../models/Link');

const router = express.Router();

// A public, read-only view of a shared collection.
//
// This router is intentionally unauthenticated — that is the point of a share
// link — but it is deliberately narrow: it exposes the collection's name,
// description and the links inside it, and nothing else. There is no write
// surface here at all.

/** The links of a shared collection, without the private fields. */
function publicLink(link) {
  return {
    _id: link._id,
    title: link.title,
    url: link.url,
    description: link.description,
    tags: link.tags,
    favorite: link.favorite,
    color: link.color,
    createdAt: link.createdAt,
    image: link.og?.image || '',
  };
}

// GET /api/share/:slug
router.get('/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug || slug.length > 64) {
      return res.status(404).json({ error: 'This share link does not exist.' });
    }

    const collection = await Collection.findOne({
      'shared.slug': slug,
      'shared.enabled': true,
    })
      .select('name color shared')
      .lean();

    if (!collection) {
      return res.status(404).json({ error: 'This share link does not exist.' });
    }

    // An expired share behaves exactly like a revoked one.
    if (collection.shared.expiresAt && new Date(collection.shared.expiresAt).getTime() <= Date.now()) {
      return res.status(404).json({ error: 'This share link has expired.' });
    }

    const links = await Link.find({ collectionId: collection._id, deletedAt: null, archivedAt: null })
      .sort({ createdAt: -1 })
      .limit(500)
      .select('title url description tags favorite color createdAt og.image')
      .lean();

    res.json({
      collection: {
        name: collection.name,
        color: collection.color,
        sharedAt: collection.shared.sharedAt,
        expiresAt: collection.shared.expiresAt,
      },
      links: links.map(publicLink),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;

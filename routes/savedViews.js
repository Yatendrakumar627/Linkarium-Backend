const express = require('express');
const SavedView = require('../models/SavedView');
const Collection = require('../models/Collection');
const Link = require('../models/Link');
const auth = require('../middleware/auth');
const { isObjectId, isHexColor } = require('../utils/validators');
const { parseQuery, describeAst, compileAst } = require('../utils/querylang');
const { runRule } = require('../utils/rules');
const { normalizeTags } = require('../utils/helpers');

const router = express.Router();

router.use(auth);

const MAX_NAME = 60;
const MAX_QUERY = 500;

/**
 * How many of the user's links a query matches.
 *
 * The count is computed with the same compiler the search box uses, so the
 * preview and the result never disagree.
 */
async function countMatches(userId, ast) {
  let collectionIds = null;
  if (ast.collections.length) {
    const names = ast.collections;
    const docs = await Collection.find({ user: userId, name: { $in: names } })
      .select('_id')
      .lean();
    collectionIds = docs.map((d) => String(d._id));
    // A collection that does not exist matches nothing at all.
    if (collectionIds.length === 0) return 0;
  }

  const base = { user: userId, deletedAt: null };
  const { filter } = compileAst(ast, base, { collectionIds });
  return Link.countDocuments(filter);
}

/** The name a saved view is shown under. */
function publicView(view) {
  return {
    _id: view._id,
    kind: view.kind,
    name: view.name,
    query: view.query,
    icon: view.icon,
    color: view.color,
    order: view.order,
    pinned: view.pinned,
    enabled: view.enabled,
    actions: view.kind === 'rule' ? view.actions : undefined,
    runCount: view.runCount,
    lastRunAt: view.lastRunAt,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

// GET /api/saved-views — every saved view and rule of the user.
router.get('/', async (req, res) => {
  try {
    const views = await SavedView.find({ user: req.userId }).sort({ kind: 1, order: 1, createdAt: 1 }).lean();

    res.json({
      views: views.filter((v) => v.kind === 'view').map(publicView),
      rules: views.filter((v) => v.kind === 'rule').map(publicView),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/saved-views — create a saved view or a rule.
router.post('/', async (req, res) => {
  try {
    const { name, query = '', kind = 'view', icon, color, pinned = false, enabled = true, actions } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'A name is required.' });
    }
    if (String(name).length > MAX_NAME) {
      return res.status(400).json({ error: `The name must be ${MAX_NAME} characters or fewer.` });
    }
    if (String(query).length > MAX_QUERY) {
      return res.status(400).json({ error: `The query must be ${MAX_QUERY} characters or fewer.` });
    }
    if (kind !== 'view' && kind !== 'rule') {
      return res.status(400).json({ error: 'A saved view must be either a view or a rule.' });
    }
    if (color && !isHexColor(color)) {
      return res.status(400).json({ error: 'Invalid color format.' });
    }

    // A rule that targets a collection must reference a real one.
    let collectionId = null;
    if (kind === 'rule' && actions?.collectionId) {
      if (!isObjectId(actions.collectionId)) {
        return res.status(400).json({ error: 'Invalid collection.' });
      }
      const owns = await Collection.exists({ _id: actions.collectionId, user: req.userId });
      if (!owns) {
        return res.status(400).json({ error: 'Invalid collection.' });
      }
      collectionId = actions.collectionId;
    }

    const count = await SavedView.countDocuments({ user: req.userId, kind });

    const view = await SavedView.create({
      user: req.userId,
      kind,
      name: String(name).trim(),
      query: String(query).trim(),
      icon: icon ? String(icon).slice(0, 40) : 'IconBookmark',
      color: color || '#8b5cf6',
      pinned: Boolean(pinned),
      enabled: enabled !== false,
      order: count,
      actions:
        kind === 'rule'
          ? {
              addTags: normalizeTags(actions?.addTags || []),
              removeTags: normalizeTags(actions?.removeTags || []),
              collectionId,
              favorite: Boolean(actions?.favorite),
              archive: Boolean(actions?.archive),
            }
          : undefined,
    });

    res.status(201).json({ view: publicView(view) });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'You already have a saved view with that name.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// PATCH /api/saved-views/:id
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) {
      return res.status(400).json({ error: 'Invalid view id.' });
    }

    const view = await SavedView.findOne({ _id: id, user: req.userId });
    if (!view) {
      return res.status(404).json({ error: 'Saved view not found.' });
    }

    const { name, query, icon, color, pinned, enabled, actions } = req.body || {};

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'A name is required.' });
      if (trimmed.length > MAX_NAME) {
        return res.status(400).json({ error: `The name must be ${MAX_NAME} characters or fewer.` });
      }
      view.name = trimmed;
    }
    if (query !== undefined) {
      if (String(query).length > MAX_QUERY) {
        return res.status(400).json({ error: `The query must be ${MAX_QUERY} characters or fewer.` });
      }
      view.query = String(query).trim();
    }
    if (icon !== undefined) view.icon = String(icon).slice(0, 40);
    if (color !== undefined) {
      if (!isHexColor(color)) return res.status(400).json({ error: 'Invalid color format.' });
      view.color = color;
    }
    if (pinned !== undefined) view.pinned = Boolean(pinned);
    if (enabled !== undefined) view.enabled = Boolean(enabled);

    if (actions !== undefined && view.kind === 'rule') {
      let collectionId = view.actions?.collectionId ?? null;
      if (actions.collectionId) {
        if (!isObjectId(actions.collectionId)) {
          return res.status(400).json({ error: 'Invalid collection.' });
        }
        const owns = await Collection.exists({ _id: actions.collectionId, user: req.userId });
        if (!owns) {
          return res.status(400).json({ error: 'Invalid collection.' });
        }
        collectionId = actions.collectionId;
      } else {
        collectionId = null;
      }

      view.actions = {
        addTags: normalizeTags(actions.addTags || []),
        removeTags: normalizeTags(actions.removeTags || []),
        collectionId,
        favorite: Boolean(actions.favorite),
        archive: Boolean(actions.archive),
      };
    }

    await view.save();
    res.json({ view: publicView(view) });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'You already have a saved view with that name.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// DELETE /api/saved-views/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) {
      return res.status(400).json({ error: 'Invalid view id.' });
    }

    const result = await SavedView.deleteOne({ _id: id, user: req.userId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Saved view not found.' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/saved-views/reorder — set the order of the user's views.
router.post('/reorder', async (req, res) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    const valid = order.filter((entry) => isObjectId(entry?.id));

    const operations = valid.map((entry, index) => ({
      updateOne: {
        filter: { _id: entry.id, user: req.userId },
        update: { $set: { order: index } },
      },
    }));

    if (operations.length) {
      await SavedView.bulkWrite(operations, { ordered: false });
    }

    res.json({ ok: true, updated: operations.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/saved-views/:id/run — run a rule now.
router.post('/:id/run', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) {
      return res.status(400).json({ error: 'Invalid view id.' });
    }

    const rule = await SavedView.findOne({ _id: id, user: req.userId });
    if (!rule) {
      return res.status(404).json({ error: 'Saved view not found.' });
    }
    if (rule.kind !== 'rule') {
      return res.status(400).json({ error: 'Only rules can be run.' });
    }

    const dryRun = req.body?.dryRun === true;
    const result = await runRule(rule, req.userId, { dryRun });

    res.json({ result, parsed: describeAst(parseQuery(rule.query || '')) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/saved-views/:id/preview — how many links would this saved view match?
router.post('/:id/preview', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid view id.' });
  try {
    const view = await SavedView.findOne({ _id: req.params.id, user: req.userId });
    if (!view) return res.status(404).json({ error: 'Saved view not found.' });

    const ast = parseQuery(view.query || '');
    const count = await countMatches(req.userId, ast);

    res.json({ parsed: describeAst(ast), count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/saved-views/preview — how many links would a query match?
router.post('/preview', async (req, res) => {
  try {
    const query = String(req.body?.query || '').slice(0, MAX_QUERY);
    const ast = parseQuery(query);

    // The count is the whole point of a preview: the user wants to know
    // whether the query is worth saving before saving it.
    const count = await countMatches(req.userId, ast);

    res.json({ parsed: describeAst(ast), count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;

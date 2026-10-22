// The automation rule engine.
//
// A rule is a saved query plus a set of actions. Whenever a link is saved —
// and whenever the user asks for it — every enabled rule is evaluated and its
// actions are applied to the matching links.
//
// The rules speak the same query language as the search box, so a rule can
// use `tag:ai`, `domain:github.com`, `is:favorite`, `visits:>10` and friends.
//
// Rules are evaluated in memory (utils/querylang.js `matchesQuery`) rather
// than by compiling a Mongo filter per rule: the candidate set is already in
// hand, and one filter per rule would mean one round-trip per rule.

const Link = require('../models/Link');
const Collection = require('../models/Collection');
const { parseQuery, matchesQuery } = require('./querylang');
const { normalizeTags } = require('./helpers');

const MAX_CANDIDATES = 2000;

/**
 * Resolve collection names (as written in a rule) to ids.
 *
 * @param {string} userId
 * @param {string[]} names
 * @returns {Promise<string[]>}
 */
async function resolveCollectionIds(userId, names) {
  if (!names || names.length === 0) return [];

  const collections = await Collection.find({
    user: userId,
    name: { $in: names.map((n) => new RegExp(`^${escapeRegex(n)}$`, 'i')) },
  })
    .select('_id name')
    .lean();

  const byName = new Map(collections.map((c) => [String(c.name).toLowerCase(), String(c._id)]));
  const ids = [];
  for (const name of names) {
    const id = byName.get(String(name).toLowerCase());
    if (id) ids.push(id);
  }
  return ids;
}

/** Escape a string for use inside a RegExp. */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the links a rule matches.
 *
 * @param {object} rule a saved view document with kind === 'rule'
 * @param {string} userId
 * @returns {Promise<{ast: object, collectionIds: string[], matches: object[]}>}
 */
async function findRuleMatches(rule, userId) {
  const ast = parseQuery(rule.query || '');
  const collectionIds = await resolveCollectionIds(userId, ast.collections);

  const candidates = await Link.find({ user: userId, deletedAt: null })
    .limit(MAX_CANDIDATES)
    .lean();

  const matches = candidates.filter((doc) => matchesQuery(doc, ast, { collectionIds }));
  return { ast, collectionIds, matches };
}

/**
 * Compute the changes a rule would make to a link.
 *
 * @param {object} link the link document
 * @param {object} actions the rule's actions
 * @returns {{changed: boolean, update: object, patch: object}}
 *   `update` is a Mongo update document, `patch` is the equivalent plain
 *   object for in-memory application.
 */
function computeActions(link, actions = {}) {
  const update = {};
  const patch = {};
  const $addToSet = {};
  const $pull = {};

  const current = Array.isArray(link.tags) ? link.tags.slice() : [];
  let nextTags = current;

  if (Array.isArray(actions.addTags) && actions.addTags.length) {
    const tags = normalizeTags(actions.addTags);
    nextTags = [...nextTags, ...tags.filter((t) => !nextTags.includes(t))];
  }

  if (Array.isArray(actions.removeTags) && actions.removeTags.length) {
    const remove = new Set(normalizeTags(actions.removeTags));
    nextTags = nextTags.filter((t) => !remove.has(t));
  }

  const toAdd = nextTags.filter((t) => !current.includes(t));
  const toRemove = current.filter((t) => !nextTags.includes(t));

  // Mongo refuses to update the same path with two operators ($addToSet and
  // $pull) in one update. When a rule both adds and removes tags, write the
  // computed result in a single $set instead.
  if (toAdd.length && toRemove.length) {
    update.$set = { ...(update.$set || {}), tags: nextTags };
    patch.tags = nextTags;
  } else if (toAdd.length) {
    $addToSet.tags = { $each: toAdd };
    patch.tags = nextTags;
  } else if (toRemove.length) {
    $pull.tags = { $in: toRemove };
    patch.tags = nextTags;
  }

  if (actions.collectionId) {
    const current = link.collectionId ? String(link.collectionId) : null;
    if (current !== String(actions.collectionId)) {
      update.collectionId = actions.collectionId;
      patch.collectionId = actions.collectionId;
    }
  }

  if (actions.favorite && !link.favorite) {
    update.favorite = true;
    patch.favorite = true;
  }

  if (actions.archive && !link.archivedAt) {
    update.archivedAt = new Date();
    patch.archivedAt = update.archivedAt;
  }

  if (Object.keys($addToSet).length) update.$addToSet = $addToSet;
  if (Object.keys($pull).length) update.$pull = $pull;

  return {
    changed: Object.keys(update).length > 0,
    update,
    patch,
  };
}

/**
 * Run a rule: apply its actions to every link it matches.
 *
 * @param {object} rule
 * @param {string} userId
 * @param {{dryRun?: boolean}} options
 * @returns {Promise<{matched: number, changed: number, dryRun: boolean}>}
 */
async function runRule(rule, userId, options = {}) {
  const { dryRun = false } = options;

  const { matches } = await findRuleMatches(rule, userId);

  const operations = [];
  let changed = 0;

  for (const link of matches) {
    const { changed: didChange, update } = computeActions(link, rule.actions);
    if (!didChange) continue;
    changed += 1;
    if (!dryRun) {
      operations.push({
        updateOne: {
          filter: { _id: link._id },
          update,
        },
      });
    }
  }

  if (operations.length) {
    await Link.bulkWrite(operations, { ordered: false });
  }

  if (!dryRun) {
    rule.runCount = Number(rule.runCount || 0) + 1;
    rule.lastRunAt = new Date();
    await rule.save();
  }

  return { matched: matches.length, changed, dryRun };
}

/**
 * Run every enabled rule of a user against a single link.
 *
 * Used right after a link is saved, so the rules feel instant.
 *
 * @param {object} link the link document (must have tags, collectionId, ...)
 * @param {string} userId
 * @returns {Promise<number>} the number of rules that changed the link
 */
async function applyRulesToLink(link, userId) {
  const SavedView = require('../models/SavedView');
  const rules = await SavedView.find({ user: userId, kind: 'rule', enabled: true }).lean();
  if (rules.length === 0) return 0;

  let applied = 0;

  for (const rule of rules) {
    const ast = parseQuery(rule.query || '');
    const collectionIds = await resolveCollectionIds(userId, ast.collections);

    if (!matchesQuery(link, ast, { collectionIds })) continue;

    const { changed, patch } = computeActions(link, rule.actions);
    if (!changed) continue;

    Object.assign(link, patch);
    applied += 1;
  }

  if (applied > 0) {
    await link.save();
  }

  return applied;
}

module.exports = {
  runRule,
  findRuleMatches,
  computeActions,
  applyRulesToLink,
  resolveCollectionIds,
};

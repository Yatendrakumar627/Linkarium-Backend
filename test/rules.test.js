const { describe, test } = require('node:test');
const assert = require('node:assert');
const { computeActions } = require('../utils/rules');

describe('computeActions', () => {
  test('adds tags with $addToSet', () => {
    const { changed, update, patch } = computeActions(
      { tags: ['keep'] },
      { addTags: ['new'] }
    );
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(update.$addToSet, { tags: { $each: ['new'] } });
    assert.strictEqual(update.$pull, undefined);
    assert.deepStrictEqual(patch.tags, ['keep', 'new']);
  });

  test('removes tags with $pull', () => {
    const { changed, update, patch } = computeActions(
      { tags: ['keep', 'old'] },
      { removeTags: ['old'] }
    );
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(update.$pull, { tags: { $in: ['old'] } });
    assert.strictEqual(update.$addToSet, undefined);
    assert.deepStrictEqual(patch.tags, ['keep']);
  });

  test('add and remove in one rule produces a single non-conflicting write', () => {
    const { changed, update, patch } = computeActions(
      { tags: ['keep', 'old'] },
      { addTags: ['new', 'old'], removeTags: ['old'] }
    );
    assert.strictEqual(changed, true);
    // MongoDB rejects $addToSet + $pull on the same path in one update.
    assert.strictEqual(update.$addToSet, undefined);
    assert.strictEqual(update.$pull, undefined);
    assert.deepStrictEqual(update.$set.tags.sort(), ['keep', 'new']);
    assert.deepStrictEqual(patch.tags.sort(), ['keep', 'new']);
  });

  test('does nothing when the link already matches', () => {
    const { changed, update } = computeActions(
      { tags: ['keep'] },
      { addTags: ['keep'], removeTags: ['missing'] }
    );
    assert.strictEqual(changed, false);
    assert.deepStrictEqual(update, {});
  });
});

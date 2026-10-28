const { describe, test } = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const Link = require('../models/Link');
const linksRouter = require('../routes/links');

const findDuplicateUrl = linksRouter._findDuplicateUrl;
const handleReplaceLink = linksRouter._handleReplaceLink;

describe('Duplicate Detection Across Entire Library (Active, Archived, Trash) & Replace', () => {
  const userId = new mongoose.Types.ObjectId();
  const activeId = new mongoose.Types.ObjectId();
  const archivedId = new mongoose.Types.ObjectId();
  const trashId = new mongoose.Types.ObjectId();
  const otherLinkId = new mongoose.Types.ObjectId();

  // In-memory mock link collection for isolated unit tests
  const mockDatabase = [
    {
      _id: activeId,
      user: userId,
      title: 'Active Link',
      url: 'https://github.com/facebook/react',
      canonicalUrl: 'https://github.com/facebook/react',
      deletedAt: null,
      archivedAt: null,
      visits: 5,
      favorite: true,
      color: '#6366f1',
      tags: ['react', 'dev'],
      note: 'Active note',
    },
    {
      _id: archivedId,
      user: userId,
      title: 'Archived Reference',
      url: 'https://news.ycombinator.com/item?id=12345',
      canonicalUrl: 'https://news.ycombinator.com/item?id=12345',
      deletedAt: null,
      archivedAt: new Date('2025-01-01'),
      visits: 2,
      favorite: false,
      color: '#10b981',
      tags: ['news'],
      note: 'Old reference',
    },
    {
      _id: trashId,
      user: userId,
      title: 'Trashed Resource',
      url: 'https://docs.python.org/3/library/asyncio.html',
      canonicalUrl: 'https://docs.python.org/3/library/asyncio.html',
      deletedAt: new Date('2026-02-15'),
      archivedAt: null,
      visits: 0,
      favorite: false,
      color: '#ef4444',
      tags: ['python', 'async'],
      note: 'Moved to trash',
    },
    {
      _id: otherLinkId,
      user: userId,
      title: 'Collision Target',
      url: 'https://google.com/search',
      canonicalUrl: 'https://google.com/search',
      deletedAt: null,
      archivedAt: null,
      visits: 0,
      favorite: false,
      color: '#3b82f6',
      tags: [],
    },
  ];

  // Temporarily stub Link.findOne
  let origFindOne;
  test.beforeEach(() => {
    origFindOne = Link.findOne;
    Link.findOne = (query) => {
      return {
        select: (fields) => {
          return {
            lean: async () => {
              // Match logic simulating MongoDB findOne
              const match = mockDatabase.find((doc) => {
                if (String(doc.user) !== String(query.user)) return false;
                if (query.deletedAt === null && doc.deletedAt !== null) return false;
                if (query.deletedAt && query.deletedAt.$ne !== null && doc.deletedAt === null) return false;
                if (query._id && query._id.$ne && String(doc._id) === String(query._id.$ne)) return false;
                if (query._id && !query._id.$ne && String(doc._id) !== String(query._id)) return false;

                if (query.$or) {
                  return query.$or.some((clause) => {
                    if (clause.url && clause.url === doc.url) return true;
                    if (clause.canonicalUrl && clause.canonicalUrl === doc.canonicalUrl) return true;
                    return false;
                  });
                }
                return true;
              });

              return match ? { ...match } : null;
            },
          };
        },
      };
    };
  });

  test.afterEach(() => {
    Link.findOne = origFindOne;
  });

  test('findDuplicateUrl returns null for invalid or empty url', async () => {
    assert.strictEqual(await findDuplicateUrl(userId, null), null);
    assert.strictEqual(await findDuplicateUrl(userId, ''), null);
    assert.strictEqual(await findDuplicateUrl(userId, 123), null);
  });

  test('findDuplicateUrl detects active duplicate and marks location as active', async () => {
    const dup = await findDuplicateUrl(userId, 'https://github.com/facebook/react?utm_source=twitter');
    assert.ok(dup, 'Should detect active duplicate with tracking parameters');
    assert.strictEqual(String(dup._id), String(activeId));
    assert.strictEqual(dup.location, 'active');
  });

  test('findDuplicateUrl detects archived duplicate and marks location as archived', async () => {
    const dup = await findDuplicateUrl(userId, 'https://news.ycombinator.com/item?id=12345');
    assert.ok(dup, 'Should detect archived link');
    assert.strictEqual(String(dup._id), String(archivedId));
    assert.strictEqual(dup.location, 'archived');
  });

  test('findDuplicateUrl detects trashed duplicate and marks location as trash', async () => {
    const dup = await findDuplicateUrl(userId, 'https://docs.python.org/3/library/asyncio.html');
    assert.ok(dup, 'Should detect link sitting in trash');
    assert.strictEqual(String(dup._id), String(trashId));
    assert.strictEqual(dup.location, 'trash');
  });

  test('findDuplicateUrl respects includeTrash: false', async () => {
    const dup = await findDuplicateUrl(userId, 'https://docs.python.org/3/library/asyncio.html', {
      includeTrash: false,
    });
    assert.strictEqual(dup, null, 'Should skip trash when includeTrash is false');
  });

  test('findDuplicateUrl respects excludeId', async () => {
    const dup = await findDuplicateUrl(userId, 'https://github.com/facebook/react', {
      excludeId: activeId,
    });
    assert.strictEqual(dup, null, 'Should exclude activeId from duplicate check');
  });

  test('handleReplaceLink restores trashed link and updates all fields', async () => {
    const targetDoc = mockDatabase.find((d) => String(d._id) === String(trashId));
    assert.ok(targetDoc.deletedAt !== null, 'Target starts in trash');

    let saved = false;
    const fakeDocInstance = {
      ...targetDoc,
      save: async function () {
        saved = true;
        targetDoc.deletedAt = this.deletedAt;
        targetDoc.archivedAt = this.archivedAt;
        targetDoc.title = this.title;
        targetDoc.url = this.url;
        targetDoc.tags = this.tags;
        return this;
      },
    };

    Link.findOne = (query) => {
      if (String(query._id) === String(trashId) && String(query.user) === String(userId)) {
        return Promise.resolve(fakeDocInstance);
      }
      return {
        select: () => ({ lean: async () => null }),
      };
    };

    let resultJson = null;
    const res = {
      status: () => res,
      json: (data) => {
        resultJson = data;
        return data;
      },
    };

    await handleReplaceLink(
      trashId,
      userId,
      {
        title: 'Fresh AsyncIO Documentation',
        url: 'https://docs.python.org/3/library/asyncio.html',
        description: 'Updated description',
        tags: ['python', 'concurrency'],
      },
      res
    );

    assert.ok(saved, 'Document should be saved');
    assert.strictEqual(fakeDocInstance.deletedAt, null, 'Link should be restored from trash');
    assert.strictEqual(fakeDocInstance.archivedAt, null, 'Link should be unarchived');
    assert.strictEqual(fakeDocInstance.title, 'Fresh AsyncIO Documentation');
    assert.deepStrictEqual(fakeDocInstance.tags, ['python', 'concurrency']);
    assert.strictEqual(resultJson.title, 'Fresh AsyncIO Documentation');
  });

  test('handleReplaceLink prevents collision with another link', async () => {
    const fakeDocInstance = {
      ...mockDatabase[0],
      save: async () => {},
    };

    Link.findOne = (query) => {
      if (String(query._id) === String(activeId)) {
        return Promise.resolve(fakeDocInstance);
      }
      // Return collision target for the new URL
      return {
        select: () => ({
          lean: async () => mockDatabase[3], // otherLinkId
        }),
      };
    };

    let statusCalled = null;
    let resultJson = null;
    const res = {
      status: (code) => {
        statusCalled = code;
        return res;
      },
      json: (data) => {
        resultJson = data;
        return data;
      },
    };

    await handleReplaceLink(
      activeId,
      userId,
      {
        title: 'Collision Try',
        url: 'https://google.com/search',
      },
      res
    );

    assert.strictEqual(statusCalled, 409, 'Should return 409 conflict when colliding with another link');
    assert.ok(resultJson.error.includes('Another link'));
  });
});


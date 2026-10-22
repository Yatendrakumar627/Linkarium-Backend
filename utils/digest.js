// The weekly digest.
//
// A short, plain-text-friendly summary of what happened in the account over
// the past week: what was saved, what was read, what was forgotten.
//
// The builder is pure with respect to formatting — it takes plain data and
// returns the subject, the HTML body and the text body — so it can be tested
// without a database. `collectDigestData` does the querying.

const Link = require('../models/Link');
const Visit = require('../models/Visit');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// A favourite that has not been opened for this long is "forgotten".
const FORGOTTEN_AFTER_DAYS = 90;

const MAX_ITEMS = 8;

/** Escape text for safe inclusion in HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Gather the numbers and the lists that make up a digest.
 *
 * @param {string} userId
 * @param {{now?: Date, weekMs?: number}} options
 */
async function collectDigestData(userId, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const weekMs = options.weekMs || WEEK_MS;
  const weekAgo = new Date(now.getTime() - weekMs);
  const forgottenBefore = new Date(now.getTime() - FORGOTTEN_AFTER_DAYS * DAY_MS);

  const base = { user: userId, deletedAt: null, archivedAt: null };

  const [newLinks, totalLinks, visitsThisWeek, topTags, forgotten, neverOpened] = await Promise.all([
    Link.find({ ...base, createdAt: { $gte: weekAgo } })
      .sort({ createdAt: -1 })
      .limit(MAX_ITEMS)
      .select('title url tags createdAt')
      .lean(),
    Link.countDocuments(base),
    Visit.countDocuments({ link: { $in: await linkIds(userId) }, createdAt: { $gte: weekAgo } }),
    Link.aggregate([
      { $match: { ...base, createdAt: { $gte: weekAgo } } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 6 },
    ]),
    Link.find({ ...base, favorite: true, lastVisitedAt: { $lt: forgottenBefore } })
      .sort({ lastVisitedAt: 1 })
      .limit(MAX_ITEMS)
      .select('title url lastVisitedAt')
      .lean(),
    Link.find({ ...base, visits: 0, createdAt: { $lt: weekAgo } })
      .sort({ createdAt: -1 })
      .limit(MAX_ITEMS)
      .select('title url createdAt')
      .lean(),
  ]);

  return {
    now,
    weekAgo,
    newLinks,
    totalLinks,
    visitsThisWeek,
    topTags: topTags.map((t) => ({ tag: t._id, count: t.count })),
    forgotten,
    neverOpened,
  };
}

/** All active link ids of a user (used to scope the visit count). */
async function linkIds(userId) {
  const links = await Link.find({ user: userId, deletedAt: null }).select('_id').lean();
  return links.map((l) => l._id);
}

/**
 * Render a digest from collected data.
 *
 * @param {object} data the result of collectDigestData
 * @param {{appUrl?: string}} options
 * @returns {{subject: string, html: string, text: string}}
 */
function renderDigest(data, options = {}) {
  const appUrl = (options.appUrl || process.env.CLIENT_ORIGIN || '').replace(/\/$/, '');

  const newCount = data.newLinks.length;
  const subject = `Your Linkarium week — ${newCount} new link${newCount === 1 ? '' : 's'}, ${data.visitsThisWeek} visit${
    data.visitsThisWeek === 1 ? '' : 's'
  }`;

  const textLines = [];
  textLines.push(subject);
  textLines.push('');
  textLines.push(`You have ${data.totalLinks} saved links in total.`);
  textLines.push('');

  if (data.newLinks.length) {
    textLines.push('SAVED THIS WEEK');
    for (const link of data.newLinks) {
      textLines.push(`  - ${link.title} (${link.url})`);
    }
    textLines.push('');
  }

  if (data.topTags.length) {
    textLines.push('TOP TAGS');
    textLines.push(`  ${data.topTags.map((t) => `#${t.tag} (${t.count})`).join(', ')}`);
    textLines.push('');
  }

  if (data.forgotten.length) {
    textLines.push('FORGOTTEN FAVOURITES');
    for (const link of data.forgotten) {
      textLines.push(`  - ${link.title} (${link.url})`);
    }
    textLines.push('');
  }

  if (data.neverOpened.length) {
    textLines.push('NEVER OPENED');
    for (const link of data.neverOpened) {
      textLines.push(`  - ${link.title} (${link.url})`);
    }
    textLines.push('');
  }

  if (appUrl) {
    textLines.push(`Open Linkarium: ${appUrl}`);
  }

  const htmlSections = [];
  htmlSections.push(`<h1>Your Linkarium week</h1>`);
  htmlSections.push(
    `<p>${data.newLinks.length} new link${data.newLinks.length === 1 ? '' : 's'}, ${data.visitsThisWeek} visit${
      data.visitsThisWeek === 1 ? '' : 's'
    }, ${data.totalLinks} links in total.</p>`
  );

  if (data.newLinks.length) {
    htmlSections.push('<h2>Saved this week</h2><ul>');
    for (const link of data.newLinks) {
      htmlSections.push(
        `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a></li>`
      );
    }
    htmlSections.push('</ul>');
  }

  if (data.topTags.length) {
    htmlSections.push('<h2>Top tags</h2><p>');
    htmlSections.push(
      data.topTags.map((t) => `<code>#${escapeHtml(t.tag)}</code> (${t.count})`).join(', ')
    );
    htmlSections.push('</p>');
  }

  if (data.forgotten.length) {
    htmlSections.push('<h2>Forgotten favourites</h2><ul>');
    for (const link of data.forgotten) {
      htmlSections.push(`<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a></li>`);
    }
    htmlSections.push('</ul>');
  }

  if (data.neverOpened.length) {
    htmlSections.push('<h2>Never opened</h2><ul>');
    for (const link of data.neverOpened) {
      htmlSections.push(`<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a></li>`);
    }
    htmlSections.push('</ul>');
  }

  if (appUrl) {
    htmlSections.push(`<p><a href="${escapeHtml(appUrl)}">Open Linkarium</a></p>`);
  }

  const html = [
    '<!doctype html>',
    '<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#111">',
    ...htmlSections,
    '</body></html>',
  ].join('\n');

  return { subject, html, text: textLines.join('\n') };
}

module.exports = {
  collectDigestData,
  renderDigest,
  escapeHtml,
  FORGOTTEN_AFTER_DAYS,
  WEEK_MS,
};

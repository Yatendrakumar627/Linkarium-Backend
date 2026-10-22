// Deletes links that have been in the trash longer than the retention period.
//
// This used to live as a bare setInterval in server.js. Moving it into the
// scheduler means it is guarded by a lease (so it cannot run twice on two
// instances) and can be triggered on demand after the Render instance wakes
// up from sleep.

const Link = require('../../models/Link');
const Visit = require('../../models/Visit');

const TRASH_RETENTION_DAYS = 7;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

async function cleanupExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const expiredLinks = await Link.find({ deletedAt: { $lte: cutoff } }).select('_id');
  if (expiredLinks.length === 0) return { deleted: 0 };

  const ids = expiredLinks.map((l) => l._id);
  await Visit.deleteMany({ link: { $in: ids } });
  const result = await Link.deleteMany({ _id: { $in: ids } });

  console.log(`🗑️ Cleaned up ${result.deletedCount} expired trashed link(s).`);
  return { deleted: result.deletedCount };
}

module.exports = {
  name: 'cleanup-trash',
  intervalMs: INTERVAL_MS,
  run: cleanupExpiredTrash,
};

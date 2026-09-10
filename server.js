require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const Link = require('./models/Link');
const Visit = require('./models/Visit');

const PORT = process.env.PORT || 5000;
const TRASH_RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // every 24 hours

if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set in backend/.env');
  process.exit(1);
}

async function cleanupExpiredTrash() {
  try {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const expiredLinks = await Link.find({ deletedAt: { $lte: cutoff } }).select('_id');
    if (expiredLinks.length === 0) return;

    const ids = expiredLinks.map((l) => l._id);
    await Visit.deleteMany({ link: { $in: ids } });
    const result = await Link.deleteMany({ _id: { $in: ids } });
    console.log(`🗑️ Cleaned up ${result.deletedCount} expired trashed link(s).`);
  } catch (err) {
    console.error('❌ Trash cleanup error:', err.message);
  }
}

setInterval(cleanupExpiredTrash, CLEANUP_INTERVAL_MS);

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB Atlas');
    setTimeout(cleanupExpiredTrash, 5000);
  })
  .catch((err) => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const { startScheduler } = require('./workers/scheduler');
const { initMasterAccount } = require('./utils/initMaster');

const PORT = process.env.PORT || 5000;

// Register the background tasks (trash cleanup, link health, enrichment,
// weekly digest). Registering them does not start anything — the scheduler
// only starts once the database is connected.
require('./workers/registerTasks');

if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set in server/.env');
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET is not set in server/.env');
  process.exit(1);
}

mongoose
  .connect(process.env.MONGODB_URI, {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(async () => {
    console.log('✅ Connected to MongoDB Atlas');

    // Ensure Master Admin account exists
    await initMasterAccount();

    // The background scheduler takes over the periodic work that used to live
    // in a bare setInterval here. Every task is guarded by a Mongo-backed
    // lease, so it is safe with more than one instance, and an external ping
    // to POST /api/internal/cron can run the due tasks after the Render
    // instance wakes up from sleep.
    startScheduler();
  })
  .catch((err) => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

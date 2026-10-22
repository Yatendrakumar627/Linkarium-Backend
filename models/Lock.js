const mongoose = require('mongoose');

// A lease used to make background jobs safe when more than one server
// instance is running.
//
// The scheduler takes a lease before running a task and releases it when the
// task finishes. A lease that is not released (the process died mid-task)
// expires on its own, so a crashed instance cannot block the job forever.
const lockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    expiresAt: { type: Date, default: null },
    holder: { type: String, default: '' },
  },
  { versionKey: false }
);

// Expired leases are swept away automatically; the lease check also treats an
// expired lease as free, so the sweep is only cleanup.
lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Lock', lockSchema);

const mongoose = require('mongoose');

// Shared rate-limit counters.
//
// `express-rate-limit` keeps its counters in process memory by default, which
// means every Render instance enforces its own quota and a deploy resets every
// counter. Storing them in Mongo makes the limit global.
//
// The document id is "<namespace>:<key>" so several limiters can share one
// collection without their counters colliding.
const rateLimitSchema = new mongoose.Schema(
  {
    _id: { type: String },
    count: { type: Number, default: 0 },
    resetAt: { type: Date, required: true },
  },
  { versionKey: false }
);

// Expired counters are removed by the TTL monitor; the store also treats an
// expired counter as "not found" so the TTL sweep is only a cleanup, never a
// correctness requirement.
rateLimitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimit', rateLimitSchema);

// A Mongo-backed rate-limit store for express-rate-limit.
//
// express-rate-limit v8 expects a store with this interface:
//
//   init(options)     -> void | Promise<void>
//   increment(key)    -> Promise<{ totalHits: number, resetTime: number } | undefined>
//   decrement(key)    -> Promise<void>
//   resetKey(key)     -> Promise<void>
//   resetAll()        -> Promise<void>   (optional)
//
// The default MemoryStore keeps counters in process memory: with more than one
// server instance each enforces its own quota, and every deploy resets them.
// Storing the counters in Mongo makes the limit global.
//
// Counters are namespaced ("<limiter>:<key>") so several limiters with
// different windows can share one collection without colliding.
//
// When the database is not connected (unit tests, a boot that has not
// connected yet) the store falls back to an in-process counter rather than
// buffering the request until Mongo comes up. The limits still apply; they are
// simply per-instance until the connection is established.

const mongoose = require('mongoose');
const RateLimit = require('../models/RateLimit');

/**
 * @param {string} namespace identifies the limiter (e.g. 'api', 'auth')
 * @param {number} windowMs the limiter's window; the counter resets after it
 */
function createRateLimitStore(namespace, windowMs) {
  const prefix = `${namespace}:`;

  // Fallback counters, used while the database is unreachable.
  const memory = new Map();

  const isConnected = () => mongoose.connection?.readyState === 1;

  const memoryIncrement = (key) => {
    const now = Date.now();
    const entry = memory.get(key);
    if (!entry || entry.resetTime <= now) {
      const fresh = { totalHits: 1, resetTime: now + windowMs };
      memory.set(key, fresh);
      return fresh;
    }
    entry.totalHits += 1;
    return entry;
  };
  const memoryDecrement = (key) => {
    const entry = memory.get(key);
    if (entry && entry.totalHits > 0) entry.totalHits -= 1;
  };

  return {
    async init() {
      /* nothing to prepare — the model creates its index on connect */
    },

    async increment(key) {
      const id = prefix + key;

      if (!isConnected()) {
        const result = memoryIncrement(id);
        return { totalHits: result.totalHits, resetTime: new Date(result.resetTime) };
      }

      const now = Date.now();
      const nowDate = new Date(now);
      const resetTime = now + windowMs;

      // One atomic operation handles both cases: an open window is
      // incremented, an expired (or missing) window starts at 1. The previous
      // two-step version could let two concurrent requests both reset the
      // window, so one of them was not counted.
      const pipeline = [
        {
          $set: {
            count: {
              $cond: [
                { $gt: ['$resetAt', nowDate] },
                { $add: ['$count', 1] },
                1,
              ],
            },
            resetAt: {
              $cond: [
                { $gt: ['$resetAt', nowDate] },
                '$resetAt',
                new Date(resetTime),
              ],
            },
          },
        },
      ];

      let fresh;
      try {
        fresh = await RateLimit.findOneAndUpdate(
          { _id: id },
          pipeline,
          // Mongoose only treats an array update as an aggregation pipeline
          // when this option is set.
          { upsert: true, returnDocument: 'after', updatePipeline: true }
        );
      } catch (err) {
        if (err?.code !== 11000) throw err;
        // A concurrent request inserted the counter first; increment it.
        fresh = await RateLimit.findOneAndUpdate(
          { _id: id },
          pipeline,
          { returnDocument: 'after', updatePipeline: true }
        );
      }

      return { totalHits: fresh.count, resetTime: fresh.resetAt };
    },

    async decrement(key) {
      const id = prefix + key;

      if (!isConnected()) {
        memoryDecrement(id);
        return;
      }

      await RateLimit.findOneAndUpdate(
        { _id: id, count: { $gt: 0 } },
        { $inc: { count: -1 } }
      );
    },

    async resetKey(key) {
      const id = prefix + key;
      memory.delete(id);
      if (!isConnected()) return;
      await RateLimit.deleteOne({ _id: id });
    },

    async resetAll() {
      memory.clear();
      if (!isConnected()) return;
      await RateLimit.deleteMany({ _id: { $regex: `^${prefix}` } });
    },
  };
}

module.exports = { createRateLimitStore };

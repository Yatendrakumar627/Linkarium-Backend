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

      // Fast path: the current window is still open, so just bump the counter.
      const active = await RateLimit.findOneAndUpdate(
        { _id: id, resetAt: { $gt: nowDate } },
        { $inc: { count: 1 } },
        { returnDocument: 'after' }
      );
      if (active) {
        return { totalHits: active.count, resetTime: active.resetAt };
      }

      // The window expired (or this is the first hit): start a fresh window.
      try {
        const fresh = await RateLimit.findOneAndUpdate(
          { _id: id },
          { $set: { count: 1, resetAt: new Date(resetTime) } },
          { upsert: true, returnDocument: 'after' }
        );
        return { totalHits: fresh.count, resetTime: fresh.resetAt };
      } catch (err) {
        if (err?.code === 11000) {
          // A concurrent request created the document first — bump it instead.
          const again = await RateLimit.findOneAndUpdate(
            { _id: id },
            { $inc: { count: 1 } },
            { returnDocument: 'after' }
          );
          if (again) {
            return { totalHits: again.count, resetTime: again.resetAt };
          }
        }
        throw err;
      }
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

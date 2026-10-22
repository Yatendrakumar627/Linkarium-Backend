const mongoose = require('mongoose');

// A short-lived challenge issued when a login requires a second factor.
//
// The challenge holds the fact that a password was verified, so the
// second-factor step does not have to re-check it (and cannot be used to
// distinguish "wrong password" from "missing code" in a timing or response
// difference).
const challengeSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Random id handed to the client; the code itself never leaves the server.
    code: {
      type: String,
      required: true,
      unique: true,
    },
    // How many times the challenge may be attempted.
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: true,
  }
);

challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Challenge', challengeSchema);

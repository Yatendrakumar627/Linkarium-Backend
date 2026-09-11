const mongoose = require('mongoose');

const visitSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    link: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Link',
      required: true,
      index: true,
    },
    visitedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Auto-prune visit history after 120 days (charts request at most 90 days;
// "recently visited" uses the last 8) so storage stays bounded.
visitSchema.index({ visitedAt: 1 }, { expireAfterSeconds: 120 * 24 * 60 * 60 });

// Supports recently-visited and daily visit-chart reads per user.
visitSchema.index({ user: 1, visitedAt: -1 });

module.exports = mongoose.model('Visit', visitSchema);
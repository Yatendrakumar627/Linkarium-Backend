const mongoose = require('mongoose');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isObjectId(id) {
  return mongoose.isValidObjectId(id);
}

function isEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

function isHexColor(value) {
  return typeof value === 'string' && HEX_RE.test(value.trim());
}

function parseLimit(value, { def = 50, min = 1, max = 1000 } = {}) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

module.exports = { isObjectId, isEmail, isHexColor, parseLimit };
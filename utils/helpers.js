const jwt = require('jsonwebtoken');

function normalizeUrl(url) {
  let value = (url || '').trim();
  if (!value) return value;
  if (!/^https?:\/\//i.test(value)) {
    if (!/^[a-z-]+:/i.test(value)) {
      value = 'https://' + value;
    }
  }
  return value;
}

function randomColor() {
  return (
    '#' +
    Math.floor(Math.random() * 16777215)
      .toString(16)
      .padStart(6, '0')
  );
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const cleaned = [];
  for (const t of tags) {
    const tag = String(t || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-');
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      cleaned.push(tag);
    }
  }
  return cleaned.slice(0, 30);
}

function signToken(user) {
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    avatarColor: user.avatarColor,
    createdAt: user.createdAt,
  };
}

module.exports = { normalizeUrl, randomColor, normalizeTags, signToken, publicUser };
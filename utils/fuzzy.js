// Typo-tolerant matching.
//
// The search index is a prefix index: a query for "react hoks" matches nothing
// because no token starts with "hoks". This module adds a bounded edit
// distance fallback so a single typo does not return nothing.
//
// Everything here is deliberately dependency-free and works on short strings
// only — the vocabulary is a user's own token list, not the whole web.

/**
 * Levenshtein distance with an early exit.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} max stop early once the distance is known to exceed `max`
 * @returns {number} the distance, or `max + 1` when it is known to exceed max
 */
function levenshtein(a, b, max = Infinity) {
  const s = String(a == null ? '' : a);
  const t = String(b == null ? '' : b);

  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  if (Math.abs(s.length - t.length) > max) return max + 1;

  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    // Every remaining row can only increase the distance.
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[t.length];
}

/**
 * The default edit distance for a term: 25% of its length, at least 1.
 * Short terms get a distance of 0 so "js" never matches "jsp".
 */
function defaultThreshold(term) {
  const len = String(term || '').length;
  if (len <= 3) return 0;
  return Math.max(1, Math.floor(len * 0.25));
}

/** True when `candidate` is within `threshold` edits of `term`. */
function isFuzzyMatch(term, candidate, threshold = defaultThreshold(term)) {
  if (threshold <= 0) return false;
  const t = String(term || '').toLowerCase();
  const c = String(candidate || '').toLowerCase();
  if (!t || !c) return false;
  if (t === c) return true;
  if (Math.abs(c.length - t.length) > threshold) return false;
  return levenshtein(t, c, threshold) <= threshold;
}

/**
 * How close two tokens are. 1 is an exact match, lower is better. Used to
 * order fuzzy results so the closest spelling comes first.
 */
function fuzzyTokenScore(term, candidate) {
  const t = String(term || '').toLowerCase();
  const c = String(candidate || '').toLowerCase();
  if (!t || !c) return 0;
  if (t === c) return 1;
  const threshold = defaultThreshold(t);
  const distance = levenshtein(t, c, threshold);
  if (distance > threshold) return 0;
  return 1 - distance / (t.length + 1);
}

/**
 * Find every vocabulary token within the edit distance of `term`.
 *
 * @param {string} term
 * @param {string[]} vocabulary
 * @param {{maxDistance?: number}} options
 * @returns {string[]} the matching vocabulary entries (original casing)
 */
function expandFuzzyTokens(term, vocabulary, options = {}) {
  const t = String(term || '').toLowerCase();
  if (!t) return [];
  const list = Array.isArray(vocabulary) ? vocabulary : [];
  const maxDistance =
    options.maxDistance !== undefined ? options.maxDistance : defaultThreshold(t);

  const out = [];
  for (const candidate of list) {
    const c = String(candidate || '').toLowerCase();
    if (!c) continue;
    if (c === t) {
      out.push(candidate);
      continue;
    }
    if (maxDistance <= 0) continue;
    if (Math.abs(c.length - t.length) > maxDistance) continue;
    if (levenshtein(t, c, maxDistance) <= maxDistance) out.push(candidate);
  }
  return out;
}

/** True when any token in `tokens` is a fuzzy match for `term`. */
function tokenFuzzyMatch(term, tokens, options = {}) {
  const list = Array.isArray(tokens) ? tokens : [];
  const threshold =
    options.maxDistance !== undefined ? options.maxDistance : defaultThreshold(term);
  if (threshold <= 0) return false;
  for (const token of list) {
    if (isFuzzyMatch(term, token, threshold)) return true;
  }
  return false;
}

module.exports = {
  levenshtein,
  isFuzzyMatch,
  fuzzyTokenScore,
  expandFuzzyTokens,
  tokenFuzzyMatch,
  defaultThreshold,
};

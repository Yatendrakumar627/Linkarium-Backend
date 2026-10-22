// Query language.
//
// One grammar powers the search box, the saved views, the command palette and
// (later) the smart-view rules — every surface compiles down to the same
// Mongo filter, so behaviour can never drift between them.
//
// Grammar
//   free text          "react hooks"        -> every word must match
//   phrase             "state management"   -> the exact phrase must appear
//   exclusion          -draft               -> must NOT match
//   tag:ai             tag:"two words"      -> tag filter
//   domain:youtube.com                     -> host / registrable domain filter
//   collection:Work                         -> collection by name or id
//   is:favorite is:untagged is:never-visited is:broken is:stale ...
//   is:archived is:unarchived is:merged is:noted is:with-og is:readable
//   visits:>10 visits:<5 visits:10
//   after:2026-01-01 before:2026-02-01  (also 7d / 2w / 3m relative)
//   any unknown "key:value" pair degrades to free text instead of erroring.
//
// The parser never throws: a malformed query always falls back to plain text
// search so the UI can never be blocked by a typo.
//
// Two evaluators share this grammar:
//   compileAst(ast)  -> a Mongo filter, used by the search routes
//   matchesQuery(doc) -> an in-memory predicate, used by the automation rules
// Both understand the same `is:` flags, so a rule and a search can never
// disagree about what a flag means.

const { tokenize, escapeRegex } = require('./text');
const { tokenFuzzyMatch } = require('./fuzzy');

const OPERATOR_KEYS = new Set(['tag', 'domain', 'collection', 'is', 'visits', 'after', 'before']);

// Known `is:` flags -> the filter they compile to.
//
// A flag is either a plain condition object or a function returning one.
// Functions are re-evaluated on every use, which matters for the
// date-relative flags ("recent", "stale"): a constant computed at module load
// would drift as the process stays alive.
//
// Every flag here has a matching branch in `matchesCondition` below, so the
// Mongo filter and the in-memory evaluator can never disagree about what a
// flag means.
const FLAGS = {
  favorite: { favorite: true },
  fav: { favorite: true },
  broken: { 'health.status': 'broken' },
  healthy: { 'health.status': 'healthy' },
  // "Stale" means "no successful check in the last 30 days" — the link may
  // well be dead, it just has not been verified recently.
  stale: () => ({
    $or: [
      { 'health.lastOkAt': { $lt: daysAgo(STALE_AFTER_DAYS) } },
      { 'health.lastOkAt': null },
    ],
  }),
  untagged: { tags: { $size: 0 } },
  'no-tags': { tags: { $size: 0 } },
  uncategorized: { collectionId: null },
  'no-collection': { collectionId: null },
  'never-visited': { visits: 0 },
  unvisited: { visits: 0 },
  visited: { visits: { $gt: 0 } },
  archived: { archivedAt: { $ne: null } },
  duplicate: { mergedInto: { $ne: null } },
  merged: { mergedInto: { $ne: null } },
  unarchived: { archivedAt: null },
  noted: { note: { $exists: true, $ne: '' } },
  'with-og': { 'og.title': { $exists: true, $ne: '' } },
  readable: { 'article.wordCount': { $gte: 200 } },
  recent: () => ({ createdAt: { $gte: daysAgo(30) } }),
  old: () => ({ createdAt: { $lte: daysAgo(365) } }),
};

// A link that has not been verified successfully for this long is "stale".
const STALE_AFTER_DAYS = 30;

/**
 * Resolve a flag name to the Mongo condition it stands for.
 * @param {string} name
 * @returns {object|null}
 */
function resolveFlag(name) {
  const flag = FLAGS[name];
  if (!flag) return null;
  return typeof flag === 'function' ? flag() : flag;
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Split a query into tokens, keeping quotes and source offsets. */
function splitTokens(input) {
  const source = String(input || '');
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i += 1;
      continue;
    }
    const start = i;
    let value = '';
    let quoted = false;
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      quoted = true;
      i += 1;
      while (i < source.length && source[i] !== ch) {
        value += source[i];
        i += 1;
      }
      if (i < source.length) i += 1; // closing quote
    } else {
      while (i < source.length && !/\s/.test(source[i])) {
        value += source[i];
        i += 1;
      }
    }
    if (value) {
      tokens.push({ value, quoted, raw: source.slice(start, i), start, end: i });
    }
  }
  return tokens;
}

// "youtube.com/watch?v=x" -> "youtube.com"
function normalizeDomain(value) {
  let v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (v.includes('://')) {
    try {
      v = new URL(v).hostname;
    } catch {
      return '';
    }
  } else {
    v = v.split('/')[0];
  }
  v = v.replace(/^www\./, '').replace(/\.$/, '');
  return v;
}

// "Two Words" -> "two-words" (same normalisation the tag field uses)
function normalizeTagValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

// "2026-01-31" | "7d" | "2w" | "3m" -> Date | null
function parseDate(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;

  const rel = /^(\d+)\s*([dwm])$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const days = unit === 'd' ? n : unit === 'w' ? n * 7 : n * 30;
    return daysAgo(days);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}$/.test(v)) {
    const d = new Date(`${v}-01T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}$/.test(v)) {
    const d = new Date(`${v}-01-01T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ">10" | ">=10" | "<5" | "<=5" | "=3" | "3" -> { op, value }
function parseComparison(value) {
  const v = String(value || '').trim();
  const m = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec(v);
  if (!m) return null;
  const op = m[1] || '=';
  return { op, value: Number(m[2]) };
}

function emptyAst() {
  return {
    terms: [],
    phrases: [],
    exclude: [],
    tags: [],
    domains: [],
    collections: [],
    flags: [],
    visits: [],
    after: null,
    before: null,
    operators: [],
    unknown: [],
  };
}

/**
 * Parse a raw query string into a rule AST.
 * @param {string} input
 * @returns {object} AST
 */
function parseQuery(input) {
  const ast = emptyAst();
  const tokens = splitTokens(input);

  for (const token of tokens) {
    const { value, quoted, raw } = token;

    if (quoted) {
      ast.phrases.push(value.toLowerCase());
      ast.operators.push({ key: 'phrase', value, raw, label: `"${value}"` });
      continue;
    }

    // Exclusion: -term
    if (value.length > 1 && value.startsWith('-') && !/^-[a-z]+:/i.test(value)) {
      const term = value.slice(1).toLowerCase();
      if (term) {
        ast.exclude.push(term);
        ast.operators.push({ key: 'exclude', value: term, raw, label: `-${term}` });
      }
      continue;
    }

    const opMatch = /^([a-zA-Z][a-zA-Z0-9_-]*):([\s\S]+)$/.exec(value);
    if (opMatch) {
      const key = opMatch[1].toLowerCase();
      const rawValue = opMatch[2];

      if (!OPERATOR_KEYS.has(key)) {
        // Unknown "key:value" — treat the whole thing as free text so that
        // searching for a URL or "time:12" still works.
        for (const word of tokenize(value)) ast.terms.push(word);
        ast.unknown.push(key);
        continue;
      }

      switch (key) {
        case 'tag': {
          const tag = normalizeTagValue(rawValue);
          if (tag) {
            ast.tags.push(tag);
            ast.operators.push({ key: 'tag', value: tag, raw, label: `tag:${tag}` });
          }
          break;
        }
        case 'domain': {
          const domain = normalizeDomain(rawValue);
          if (domain) {
            ast.domains.push(domain);
            ast.operators.push({ key: 'domain', value: domain, raw, label: `domain:${domain}` });
          }
          break;
        }
        case 'collection': {
          const name = String(rawValue).trim().toLowerCase();
          if (name) {
            ast.collections.push(name);
            ast.operators.push({ key: 'collection', value: name, raw, label: `collection:${name}` });
          }
          break;
        }
        case 'is': {
          const flag = String(rawValue).trim().toLowerCase();
          if (FLAGS[flag]) {
            ast.flags.push(flag);
            ast.operators.push({ key: 'is', value: flag, raw, label: `is:${flag}` });
          } else {
            ast.unknown.push(`is:${flag}`);
            ast.operators.push({ key: 'unknown', value: flag, raw, label: `is:${flag}` });
          }
          break;
        }
        case 'visits': {
          const cmp = parseComparison(rawValue);
          if (cmp) {
            ast.visits.push(cmp);
            ast.operators.push({ key: 'visits', value: rawValue, raw, label: `visits:${rawValue}` });
          } else {
            ast.unknown.push('visits');
          }
          break;
        }
        case 'after': {
          const date = parseDate(rawValue);
          if (date) {
            ast.after = date;
            ast.operators.push({ key: 'after', value: rawValue, raw, label: `after:${rawValue}` });
          } else {
            ast.unknown.push('after');
          }
          break;
        }
        case 'before': {
          const date = parseDate(rawValue);
          if (date) {
            ast.before = date;
            ast.operators.push({ key: 'before', value: rawValue, raw, label: `before:${rawValue}` });
          } else {
            ast.unknown.push('before');
          }
          break;
        }
        default:
          break;
      }
      continue;
    }

    // Plain free text.
    for (const word of tokenize(value)) {
      ast.terms.push(word);
      ast.operators.push({ key: 'term', value: word, raw, label: word });
    }
  }

  return ast;
}

/**
 * A Mongo filter matching a token prefix in either the metadata tokens or the
 * tokens extracted from the article body.
 */
function tokenPrefixFilter(term) {
  const re = `^${escapeRegex(term)}`;
  return {
    $or: [{ tokens: { $regex: re } }, { articleTokens: { $regex: re } }],
  };
}

/**
 * Compile an AST into a Mongo filter.
 *
 * @param {object} ast
 * @param {object} base base filter (user, deletedAt, legacy query params)
 * @param {{collectionIds?: string[]|null, skipText?: boolean}} options
 *   `skipText` leaves out the free-text token filters. The fuzzy fallback
 *   uses it to widen the candidate set: Mongo cannot match a misspelled token
 *   with a prefix regex, so the text conditions are evaluated in memory
 *   instead.
 * @returns {{filter: object, hasText: boolean, terms: string[], phrases: string[]}}
 */
function compileAst(ast, base = {}, options = {}) {
  const { collectionIds = null, skipText = false } = options;
  const and = [];

  if (ast.tags.length) {
    // Every tag in the query must be present — the same semantics as the
    // in-memory matcher used by automation rules. `$in` would OR them.
    and.push({ tags: { $all: ast.tags } });
  }

  if (ast.domains.length) {
    // A domain query matches the exact host and any subdomain of it.
    and.push({
      $or: [{ host: { $in: ast.domains } }, { hostLabel: { $in: ast.domains } }],
    });
  }

  if (ast.collections.length) {
    if (collectionIds) {
      and.push({ collectionId: { $in: collectionIds } });
    }
  }

  for (const flag of ast.flags) {
    const cond = resolveFlag(flag);
    if (cond) and.push(cond);
  }

  if (ast.visits.length) {
    const visits = {};
    for (const { op, value } of ast.visits) {
      if (op === '>') visits.$gt = value;
      else if (op === '>=') visits.$gte = value;
      else if (op === '<') visits.$lt = value;
      else if (op === '<=') visits.$lte = value;
      else visits.$eq = value;
    }
    and.push({ visits });
  }

  if (ast.after || ast.before) {
    const range = {};
    if (ast.after) range.$gte = ast.after;
    if (ast.before) range.$lte = ast.before;
    and.push({ createdAt: range });
  }

  // Free text: every term must be present as a token prefix.
  //
  // A term may match either the metadata tokens (title, tags, description,
  // note, url) or the tokens extracted from the article body, so the same
  // query works before and after a page has been enriched.
  for (const term of ast.terms) {
    if (skipText) break;
    and.push(tokenPrefixFilter(term));
  }
  // Phrases: every word must be present (exact adjacency is verified later,
  // on the small candidate set, because Mongo cannot match it directly).
  for (const phrase of ast.phrases) {
    if (skipText) break;
    for (const word of tokenize(phrase, { stopwords: false })) {
      and.push(tokenPrefixFilter(word));
    }
  }

  for (const term of ast.exclude) {
    // Excluded: the term must appear in neither token set.
    and.push({
      $nor: [
        { tokens: { $regex: `^${escapeRegex(term)}` } },
        { articleTokens: { $regex: `^${escapeRegex(term)}` } },
      ],
    });
  }

  const filter = and.length ? { $and: [base, ...and] } : base;

  return {
    filter,
    hasText: ast.terms.length > 0 || ast.phrases.length > 0,
    terms: ast.terms,
    phrases: ast.phrases,
  };
}

/**
 * Score a candidate document against the AST. Higher is better.
 * Title matches outrank tag matches, which outrank URL matches, which outrank
 * description matches. Recency and visit count only act as tie-breakers.
 */
function scoreLink(doc, ast, now = Date.now()) {
  const title = String(doc.title || '').toLowerCase();
  const description = String(doc.description || '').toLowerCase();
  const url = String(doc.url || '').toLowerCase();
  const tags = Array.isArray(doc.tags) ? doc.tags.map((t) => String(t).toLowerCase()) : [];

  let score = 0;

  for (const term of ast.terms) {
    if (title.includes(term)) score += 10;
    if (tags.some((t) => t.includes(term))) score += 8;
    if (url.includes(term)) score += 5;
    if (description.includes(term)) score += 3;
  }

  for (const phrase of ast.phrases) {
    if (title.includes(phrase)) score += 20;
    else if (description.includes(phrase)) score += 8;
    else if (url.includes(phrase)) score += 6;
  }

  // Exact tag match is a strong signal.
  for (const tag of ast.tags) {
    if (tags.includes(tag)) score += 12;
  }

  const created = doc.createdAt ? new Date(doc.createdAt).getTime() : now;
  const ageDays = Math.max((now - created) / 86400000, 0);
  score += 1.5 * Math.exp(-ageDays / 30);
  score += 0.3 * Math.log1p(Number(doc.visits) || 0);
  if (doc.favorite) score += 0.5;

  return score;
}

/** Exact phrase containment check (applied to the small candidate set). */
function matchesPhrases(doc, phrases) {
  if (!phrases.length) return true;
  const haystack = `${doc.title || ''} ${doc.description || ''} ${doc.url || ''} ${doc.note || ''} ${
    (doc.article && doc.article.text) || ''
  }`.toLowerCase();
  return phrases.every((phrase) => haystack.includes(phrase));
}

// --- in-memory evaluation -------------------------------------------------
//
// The automation rules run on the server, against individual documents that
// have already been fetched from Mongo. Rather than compiling an AST into a
// second Mongo query (which would need a fresh round-trip per document), the
// AST is evaluated directly in memory.
//
// `matchesCondition` understands exactly the operator shapes that appear in
// FLAGS, so the in-memory evaluator and the compiled Mongo filter always agree.

/** Read a possibly dotted path from a plain object. */
function readPath(doc, path) {
  let current = doc;
  for (const part of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Coerce a value to a number for comparison.
 * Dates become epoch milliseconds; date-like strings are parsed; anything
 * unparseable becomes NaN (which makes every comparison false).
 */
function toComparable(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  if (value === null || value === undefined) return NaN;
  return Number(value);
}

/**
 * Evaluate a Mongo-style condition against a plain document.
 *
 * Supports the subset used by FLAGS: null, booleans, numbers, strings, dates,
 * `$size`, `$exists`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, and the
 * boolean combinators `$or`, `$and` and `$nor`.
 */
function matchesCondition(doc, cond) {
  if (!cond || typeof cond !== 'object') return true;

  // Boolean combinators first — they are not field names.
  if (Array.isArray(cond.$or)) {
    if (!cond.$or.some((c) => matchesCondition(doc, c))) return false;
  }
  if (Array.isArray(cond.$and)) {
    if (!cond.$and.every((c) => matchesCondition(doc, c))) return false;
  }
  if (Array.isArray(cond.$nor)) {
    if (cond.$nor.some((c) => matchesCondition(doc, c))) return false;
  }

  for (const [field, expected] of Object.entries(cond)) {
    if (field.startsWith('$')) continue; // handled above
    const actual = readPath(doc, field);

    if (expected === null) {
      // Mongo's `{ field: null }` matches both null and missing.
      if (actual !== null && actual !== undefined) return false;
      continue;
    }

    if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
      if ('$size' in expected) {
        if (!Array.isArray(actual) || actual.length !== expected.$size) return false;
      }
      if ('$exists' in expected) {
        const exists = actual !== undefined && actual !== null;
        if (exists !== expected.$exists) return false;
      }
      if ('$ne' in expected) {
        const ne = expected.$ne;
        if (ne === null) {
          // `{ field: { $ne: null } }` is Mongo's idiom for "the field exists
          // and is not null" — a missing field does NOT match.
          if (actual === null || actual === undefined) return false;
        } else if (actual === ne) {
          return false;
        }
      }
      if ('$gt' in expected && !(toComparable(actual) > toComparable(expected.$gt))) return false;
      if ('$gte' in expected && !(toComparable(actual) >= toComparable(expected.$gte))) return false;
      if ('$lt' in expected && !(toComparable(actual) < toComparable(expected.$lt))) return false;
      if ('$lte' in expected && !(toComparable(actual) <= toComparable(expected.$lte))) return false;
      if ('$in' in expected && !expected.$in.includes(actual)) return false;
      continue;
    }

    if (actual !== expected) return false;
  }

  return true;
}

/** Compare a number against a parsed comparison ({ op, value }). */
function compareNumber(actual, cmp) {
  const n = Number(actual) || 0;
  switch (cmp.op) {
    case '>':
      return n > cmp.value;
    case '>=':
      return n >= cmp.value;
    case '<':
      return n < cmp.value;
    case '<=':
      return n <= cmp.value;
    case '=':
    default:
      return n === cmp.value;
  }
}

/**
 * Evaluate a query AST against a single document.
 *
 * This is the in-memory twin of `compileAst`. It is used by the automation
 * rules, which already hold the candidate documents.
 *
 * @param {object} doc a link document (plain object or Mongoose doc)
 * @param {object} ast the parsed AST
 * @param {{collectionIds?: string[]|null, fuzzy?: boolean}} ctx
 * @returns {boolean} whether the document satisfies the query
 */
function matchesQuery(doc, ast, ctx = {}) {
  if (!doc || !ast) return false;

  const { collectionIds = null, fuzzy = false } = ctx;

  // Tags: every requested tag must be present.
  if (ast.tags.length) {
    const docTags = Array.isArray(doc.tags) ? doc.tags.map((t) => String(t).toLowerCase()) : [];
    for (const tag of ast.tags) {
      if (!docTags.includes(tag)) return false;
    }
  }

  // Domains: the exact host, the registrable label, or any subdomain.
  if (ast.domains.length) {
    const host = String(doc.host || '').toLowerCase();
    const hostLabel = String(doc.hostLabel || '').toLowerCase();
    const ok = ast.domains.some(
      (d) => host === d || hostLabel === d || host.endsWith(`.${d}`)
    );
    if (!ok) return false;
  }

  // Collections: resolved to ids by the caller.
  if (ast.collections.length) {
    if (!collectionIds) return false;
    const id = doc.collectionId ? String(doc.collectionId) : null;
    if (!id) return false;
    if (!collectionIds.some((cid) => String(cid) === id)) return false;
  }

  // Flags.
  for (const flag of ast.flags) {
    const cond = resolveFlag(flag);
    if (cond && !matchesCondition(doc, cond)) return false;
  }

  // Visit counts.
  for (const cmp of ast.visits) {
    if (!compareNumber(doc.visits, cmp)) return false;
  }

  // Date range.
  if (ast.after) {
    const created = doc.createdAt ? new Date(doc.createdAt).getTime() : 0;
    if (created < ast.after.getTime()) return false;
  }
  if (ast.before) {
    const created = doc.createdAt ? new Date(doc.createdAt).getTime() : 0;
    if (created > ast.before.getTime()) return false;
  }

  // Free text: every term must match a token prefix (or, when fuzzy search is
  // enabled, a token within the edit distance).
  const docTokens = Array.isArray(doc.tokens) ? doc.tokens : [];
  const articleTokens = Array.isArray(doc.articleTokens) ? doc.articleTokens : [];
  for (const term of ast.terms) {
    const hit =
      docTokens.some((t) => String(t).startsWith(term)) ||
      articleTokens.some((t) => String(t).startsWith(term)) ||
      (fuzzy && tokenFuzzyMatch(term, docTokens));
    if (!hit) return false;
  }

  // Phrases.
  if (!matchesPhrases(doc, ast.phrases)) return false;

  // Exclusions.
  for (const term of ast.exclude) {
    const hit =
      docTokens.some((t) => String(t).startsWith(term)) ||
      articleTokens.some((t) => String(t).startsWith(term));
    if (hit) return false;
  }

  return true;
}

/** A JSON-safe summary of the parsed query (used by the client for chips). */
function describeAst(ast) {
  return {
    terms: ast.terms,
    phrases: ast.phrases,
    tags: ast.tags,
    domains: ast.domains,
    collections: ast.collections,
    flags: ast.flags,
    exclude: ast.exclude,
    visits: ast.visits,
    after: ast.after ? ast.after.toISOString() : null,
    before: ast.before ? ast.before.toISOString() : null,
    operators: ast.operators,
    unknown: ast.unknown,
  };
}

module.exports = {
  parseQuery,
  compileAst,
  scoreLink,
  matchesPhrases,
  matchesQuery,
  matchesCondition,
  describeAst,
  splitTokens,
  normalizeDomain,
  normalizeTagValue,
  tokenPrefixFilter,
  resolveFlag,
  FLAGS,
  STALE_AFTER_DAYS,
};

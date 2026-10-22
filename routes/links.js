const express = require('express');
const mongoose = require('mongoose');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const Link = require('../models/Link');
const Visit = require('../models/Visit');
const Collection = require('../models/Collection');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const { normalizeUrl, randomColor, normalizeTags } = require('../utils/helpers');
const { isObjectId, isHexColor, parseLimit } = require('../utils/validators');
const { isHttpUrl } = require('../utils/metadata');
const { canonicalizeUrl } = require('../utils/canonical');
const { parseQuery, compileAst, scoreLink, matchesPhrases, matchesQuery, describeAst } = require('../utils/querylang');
const { escapeRegex } = require('../utils/text');
const { applyRulesToLink } = require('../utils/rules');
const { fetchAndExtract, buildEnrichment } = require('../utils/enrichment');

const router = express.Router();

router.use(auth);

// Upper bound on the candidate set pulled in for relevance ranking. Keeps a
// pathological query (a single letter) from loading an entire account into
// memory.
const MAX_RANK_CANDIDATES = 1000;

// Legacy query parameters (tag/collection/favorite/deleted) still work and
// are merged with the parsed query language.
function buildBaseFilter(req) {
  const { tag, collection, favorite, deleted, archived, view } = req.query;
  const base = { user: req.userId };

  if (deleted === 'true') {
    base.deletedAt = { $ne: null };
  } else {
    base.deletedAt = null;
  }

  // The archive view asks for archived links explicitly. Everywhere else the
  // archive scope is added after the query is parsed (see applyArchiveScope),
  // because the `is:archived` / `is:unarchived` flags speak about archiving
  // too and the two must not contradict each other.
  if (deleted !== 'true' && (archived === 'true' || view === 'archived')) {
    base.archivedAt = { $ne: null };
  }

  if (tag) base.tags = String(tag).toLowerCase().trim();
  if (collection) {
    base.collectionId = String(collection) === 'none' ? null : String(collection);
  }
  if (favorite === 'true') base.favorite = true;

  return base;
}

/**
 * Hide archived links from the regular list.
 *
 * Skipped when the query itself talks about archiving (`is:archived`,
 * `is:unarchived`) or when the archive view was requested — otherwise the two
 * constraints would contradict each other and match nothing.
 */
function applyArchiveScope(filter, ast, base) {
  if (base.archivedAt !== undefined) return filter;
  if (
    ast.flags.includes('archived') ||
    ast.flags.includes('unarchived') ||
    ast.flags.includes('duplicate') ||
    ast.flags.includes('merged')
  ) {
    return filter;
  }
  return { $and: [filter, { archivedAt: null }] };
}

// Collections referenced by name inside a query ("collection:Work") are
// resolved to ids so the filter stays index-backed.
async function resolveCollectionNames(userId, names) {
  const conditions = [];
  for (const name of names) {
    if (isObjectId(name)) conditions.push({ _id: name });
    else conditions.push({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  }
  if (!conditions.length) return [];
  const collections = await Collection.find({ user: userId, $or: conditions }).select('_id');
  return collections.map((c) => c._id);
}

function sortOption(value) {
  switch (value) {
    case 'oldest':
      return { createdAt: 1 };
    case 'visits':
      return { visits: -1 };
    case 'favorite':
      return { favorite: -1, createdAt: -1 };
    case 'name':
      return { title: 1 };
    default:
      return { createdAt: -1 };
  }
}

// Comparator used to re-order an already relevance-ranked list when the user
// explicitly picked a sort (an explicit choice always wins over relevance).
function sortComparator(sort) {
  const time = (d) => (d.createdAt ? new Date(d.createdAt).getTime() : 0);
  switch (sort) {
    case 'oldest':
      return (a, b) => time(a) - time(b);
    case 'visits':
      return (a, b) => (b.visits || 0) - (a.visits || 0);
    case 'favorite':
      return (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || time(b) - time(a);
    case 'name':
      return (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
    default:
      return null;
  }
}

async function ownsCollection(collectionId, userId) {
  if (!collectionId) return true;
  if (!isObjectId(collectionId)) return false;
  return Boolean(await Collection.exists({ _id: collectionId, user: userId }));
}

// Duplicate detection runs on the *canonical* URL, so "http://x.com",
// "https://x.com/" and "https://x.com/?utm_source=twitter" all resolve to the
// same link. The raw URL is compared as well so links written before the
// canonical engine existed are still caught.
async function findDuplicateUrl(userId, url, excludeId = null) {
  const canonical = canonicalizeUrl(url);
  const or = [];
  if (canonical) or.push({ canonicalUrl: canonical.canonical });
  or.push({ url });

  const q = { user: userId, deletedAt: null, $or: or };
  if (excludeId) q._id = { $ne: excludeId };
  return Link.findOne(q).select(
    '_id title url description note tags collectionId favorite visits createdAt canonicalUrl'
  );
}

// Per-user throttle on the visit endpoint so a single account cannot hammer the
// server or inflate analytics. Keyed by userId (many users sit behind one IP).
const visitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)),
  handler: (req, res) => res.status(429).json({ error: 'Too many requests. Please try again later.' }),
});

// Import/export are heavy (spreadsheet parsing, full-table workbook builds) —
// throttle them separately from the general API limiter.
const importLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many imports. Please try again later.' }),
});

const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many exports. Please try again later.' }),
});

// Enriching makes the server fetch the page, so it gets its own budget.
const enrichLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)),
  handler: (req, res) => res.status(429).json({ error: 'Too many enrichments. Please try again in a minute.' }),
});

// A 5 MB spreadsheet can hold hundreds of thousands of rows; importing that
// many (one DB round-trip per row) is a cheap resource-exhaustion vector.
const MAX_IMPORT_ROWS = 5000;

// Collapse repeated opens of the same link within a short window into one visit.
// In-memory per process — exact on a single instance, best-effort if scaled out.
const VISIT_DEBOUNCE_MS = 60 * 1000;
const visitDebounce = new Map();

// --- IMPORT / EXPORT ---

function parseImportRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  return rows.map((r) => {
    const title = String(r.Title || r.title || '').trim();
    const url = String(r.URL || r.url || r.Hyperlink || r.hyperlink || '').trim();
    const tagsRaw = String(r.Tags || r.tags || '');
    const description = String(r.Description || r.description || '').trim();
    const collection = String(r.Collection || r.collection || '').trim();
    const hyperlink = String(r.Hyperlink || r.hyperlink || '').trim();
    return { title, url: url || hyperlink, tagsRaw, description, collection };
  });
}

// POST /api/links/import
router.post('/import', importLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    const rows = parseImportRows(req.file.buffer);
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({
        error: `File contains too many rows (max ${MAX_IMPORT_ROWS}).`,
      });
    }
    const errors = [];
    let imported = 0;
    let skipped = 0;
    const seenUrls = new Set();

    // Pre-load or create collections by name
    const collectionMap = {};
    const existingCollections = await Collection.find({ user: req.userId });
    for (const c of existingCollections) {
      collectionMap[c.name.toLowerCase()] = c._id;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      if (!row.url) {
        errors.push(`Row ${rowNum}: Missing URL.`);
        continue;
      }

      // Resolve collection
      let collectionId = null;
      if (row.collection) {
        const key = row.collection.toLowerCase();
        if (collectionMap[key]) {
          collectionId = collectionMap[key];
        } else {
          const created = await Collection.create({
            name: row.collection,
            color: randomColor(),
            user: req.userId,
          });
          collectionId = created._id;
          collectionMap[key] = created._id;
        }
      }

      // Parse tags
      const tags = row.tagsRaw
        ? row.tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
        : [];

      const url = normalizeUrl(row.url);
      if (!url || !isHttpUrl(url)) {
        errors.push(`Row ${rowNum}: Invalid URL (only http/https links can be imported).`);
        continue;
      }
      if (seenUrls.has(url)) {
        skipped++;
        continue;
      }
      const duplicate = await findDuplicateUrl(req.userId, url);
      if (duplicate) {
        skipped++;
        continue;
      }
      seenUrls.add(url);

      try {
        await Link.create({
          user: req.userId,
          title: row.title || row.url,
          url,
          description: row.description || '',
          collectionId,
          tags: normalizeTags(tags),
          favorite: false,
          color: randomColor(),
        });
        imported++;
      } catch (err) {
        errors.push(`Row ${rowNum}: ${err?.code === 11000 ? 'Duplicate URL.' : err.message}`);
      }
    }

    res.json({ imported, skipped, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to import links.' });
  }
});

// Neutralize spreadsheet formula injection: a cell starting with =, +, -, @,
// tab or CR is interpreted as a formula by Excel/Sheets when the CSV is opened.
function sanitizeCsvCell(value) {
  const s = String(value ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// GET /api/links/export
router.get('/export', exportLimiter, async (req, res) => {
  try {
    const format = (req.query.format || 'xlsx').toLowerCase();

    const filter = { user: req.userId, deletedAt: null };
    // Optional ids filter (comma-separated) — used by "Export selected".
    if (req.query.ids !== undefined) {
      const ids = String(req.query.ids).split(',').filter(isObjectId);
      if (ids.length === 0) return res.status(400).json({ error: 'No valid link ids provided.' });
      filter._id = { $in: ids };
    }

    const links = await Link.find(filter).sort({ createdAt: -1 });
    const collections = await Collection.find({ user: req.userId });
    const collectionNameMap = {};
    for (const c of collections) {
      collectionNameMap[String(c._id)] = c.name;
    }

    // --- CSV export (keep using XLSX library — lightweight, works fine for plain text) ---
    if (format === 'csv') {
      const data = links.map((l) => ({
        Title: sanitizeCsvCell(l.title),
        URL: sanitizeCsvCell(l.url),
        Tags: sanitizeCsvCell((l.tags || []).join(', ')),
        Description: sanitizeCsvCell(l.description || ''),
        Collection: sanitizeCsvCell(l.collectionId ? collectionNameMap[String(l.collectionId)] || '' : ''),
        Hyperlink: sanitizeCsvCell(l.url),
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      const csv = XLSX.utils.sheet_to_csv(ws);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="links-export.csv"');
      return res.send(csv);
    }

    // --- XLSX export using ExcelJS for reliable native hyperlinks ---
    // The SheetJS (xlsx) community edition cannot reliably write clickable hyperlinks
    // for URLs with query parameters (?tab=t.0, ?usp=sharing, etc.) — Google Docs,
    // Google Sheets, and similar URLs all fail. ExcelJS writes proper OOXML
    // relationships which Excel opens correctly without any security prompt.
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'LinkUniverse';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Links');

    // Define columns with headers and widths
    sheet.columns = [
      { header: 'Title',      key: 'title',      width: 35 },
      { header: 'URL',        key: 'url',        width: 65 },
      { header: 'Tags',       key: 'tags',       width: 28 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Collection', key: 'collection', width: 22 },
      { header: 'Hyperlink',  key: 'hyperlink',  width: 35 },
    ];

    // Style the header row
    sheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B3F72' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    });
    sheet.getRow(1).height = 20;

    // Add each link as a row
    for (const l of links) {
      const collectionName = l.collectionId ? collectionNameMap[String(l.collectionId)] || '' : '';
      const row = sheet.addRow({
        title:      l.title || '',
        url:        l.url   || '',
        tags:       (l.tags || []).join(', '),
        description: l.description || '',
        collection: collectionName,
        hyperlink:  l.title || l.url || '',   // display text — set as hyperlink below
      });

      // Apply HYPERLINK formula on the Hyperlink cell (column E).
      //
      // ROOT CAUSE OF GOOGLE LINKS NOT OPENING:
      // When Excel opens a hyperlink, Windows runs a background "User Agent" 
      // pre-check on the URL before sending it to the browser. Google detects this
      // pre-checker as an outdated browser and redirects to support.google.com/drive/answer/6283888
      // instead of the actual document.
      //
      // FIX: Split the URL at `?` into two string parts joined with Excel's `&`
      // concatenation operator. This prevents the pre-checker from recognizing the
      // full Google URL pattern, forcing it to pass the link straight to Chrome.
      // e.g. =HYPERLINK("https://docs.google.com/...?" & "gid=123#gid=123", "Title")
      if (l.url) {
        const hyperlinkCell = row.getCell('hyperlink');
        const safeTitle = (l.title || l.url).replace(/"/g, '""');

        let formula;
        const qIndex = l.url.indexOf('?');
        if (qIndex !== -1) {
          // Split at `?` — the two-part concatenation bypasses the Microsoft pre-checker
          const beforeQ = l.url.slice(0, qIndex).replace(/"/g, '""');
          const afterQ  = l.url.slice(qIndex + 1).replace(/"/g, '""');
          formula = `HYPERLINK("${beforeQ}?" & "${afterQ}", "${safeTitle}")`;
        } else {
          // No query string — safe to use as-is
          const safeUrl = l.url.replace(/"/g, '""');
          formula = `HYPERLINK("${safeUrl}", "${safeTitle}")`;
        }

        hyperlinkCell.value = { formula, result: l.title || l.url };
        hyperlinkCell.font  = { color: { argb: 'FF4472C4' }, underline: true };
      }

      // Zebra striping for readability
      if (row.number % 2 === 0) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5FA' } };
        });
      }
    }

    // Freeze the header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // Stream the workbook directly into the response
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="links-export.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    if (res.headersSent) return; // stream already started — just close it
    res.status(500).json({ error: 'Failed to export links.' });
  }
});

// POST /api/links/bulk-delete
router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No link ids provided.' });
    }
    const validIds = ids.filter((id) => isObjectId(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'No valid link ids provided.' });
    }

    const result = await Link.updateMany(
      { _id: { $in: validIds }, user: req.userId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );

    res.json({ moved: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move links to trash.' });
  }
});

// POST /api/links/bulk-move
router.post('/bulk-move', async (req, res) => {
  try {
    const { ids, collectionId } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No link ids provided.' });
    }
    if (collectionId !== null && collectionId !== undefined && !(await ownsCollection(collectionId, req.userId))) {
      return res.status(400).json({ error: 'Invalid collection.' });
    }

    const validIds = ids.filter((id) => isObjectId(id));
    const targetCollection = collectionId || null;

    const result = await Link.updateMany(
      { _id: { $in: validIds }, user: req.userId },
      { $set: { collectionId: targetCollection } }
    );

    res.json({ moved: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move links.' });
  }
});

// POST /api/links/bulk-restore — restore multiple links from trash
router.post('/bulk-restore', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No link ids provided.' });
    }
    const validIds = ids.filter((id) => isObjectId(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'No valid link ids provided.' });
    }

    const result = await Link.updateMany(
      { _id: { $in: validIds }, user: req.userId, deletedAt: { $ne: null } },
      { $set: { deletedAt: null } }
    );

    res.json({ restored: result.modifiedCount });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'Some links could not be restored — a saved link already uses the same URL.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to restore links.' });
  }
});

// POST /api/links/bulk-permanent-delete — permanently delete multiple links from trash
router.post('/bulk-permanent-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No link ids provided.' });
    }
    const validIds = ids.filter((id) => isObjectId(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'No valid link ids provided.' });
    }

    const links = await Link.find({ _id: { $in: validIds }, user: req.userId, deletedAt: { $ne: null } }).select('_id');
    const linkIds = links.map((l) => l._id);

    await Link.deleteMany({ _id: { $in: validIds }, user: req.userId, deletedAt: { $ne: null } });
    if (linkIds.length > 0) {
      await Visit.deleteMany({ link: { $in: linkIds }, user: req.userId });
    }

    res.json({ deleted: linkIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to permanently delete links.' });
  }
});

// GET /api/links — server-side search, filter, sort and pagination.
//
// The `q` parameter is parsed with the query language (server/utils/querylang.js):
// free text, "phrases", -exclusions and operators such as tag:, domain:,
// collection:, is:, visits:, after: and before:.
//
// Free-text queries match on the indexed `tokens` array (prefix match), then
// the candidate set is ranked in process by relevance — title matches beat tag
// matches, which beat URL matches, which beat description matches. Recency and
// visit count only break ties.
router.get('/', async (req, res) => {
  try {
    const base = buildBaseFilter(req);
    const ast = parseQuery(req.query.q || '');

    let collectionIds = null;
    if (ast.collections.length) {
      collectionIds = await resolveCollectionNames(req.userId, ast.collections);
    }

    const { filter, hasText, phrases } = compileAst(ast, base, { collectionIds });
    const scoped = applyArchiveScope(filter, ast, base);

    const limit = parseLimit(req.query.limit, { def: 50 });
    const skip = Math.min(Math.max(parseInt(req.query.skip, 10) || 0, 0), 100000);
    const sort = req.query.sort;

    if (!hasText) {
      const total = await Link.countDocuments(scoped);
      const links = await Link.find(scoped).sort(sortOption(sort)).skip(skip).limit(limit);
      return res.json({ links, total, parsed: describeAst(ast) });
    }

    // Text search: pull the matching candidates (index-backed), rank them and
    // paginate the ranked list.
    const candidates = await Link.find(scoped).sort({ createdAt: -1 }).limit(MAX_RANK_CANDIDATES);

    let ranked = candidates
      .filter((doc) => matchesPhrases(doc, phrases))
      .map((doc) => ({ doc, score: scoreLink(doc, ast) }))
      .sort((a, b) => b.score - a.score);

    // Fuzzy fallback: the strict pass found nothing, so the query is probably
    // misspelled. Widen the candidate set (Mongo cannot match a typo with a
    // prefix regex) and evaluate the whole AST in memory with a tolerance of
    // one edit per quarter of the term's length.
    let fuzzy = false;
    if (!ranked.length && ast.terms.length) {
      const relaxed = compileAst(ast, base, { collectionIds, skipText: true }).filter;
      const relaxedScope = applyArchiveScope(relaxed, ast, base);
      const pool = await Link.find(relaxedScope)
        .sort({ createdAt: -1 })
        .limit(MAX_RANK_CANDIDATES);

      const fuzzyRanked = pool
        .filter((doc) => matchesQuery(doc, ast, { collectionIds, fuzzy: true }))
        .map((doc) => ({ doc, score: scoreLink(doc, ast) }))
        .sort((a, b) => b.score - a.score);

      if (fuzzyRanked.length) {
        ranked = fuzzyRanked;
        fuzzy = true;
      }
    }

    const comparator = sortComparator(sort);
    if (comparator) ranked.sort((a, b) => comparator(a.doc, b.doc));

    const total = ranked.length;
    const page = ranked.slice(skip, skip + limit).map((r) => r.doc);

    res.json({
      links: page,
      total,
      truncated: candidates.length >= MAX_RANK_CANDIDATES,
      parsed: {
        ...describeAst(ast),
        fuzzy,
        fuzzyQuery: fuzzy ? ast.terms.join(' ') : undefined,
        fuzzyOriginal: fuzzy ? String(req.query.q || '') : undefined,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load links.' });
  }
});

// POST /api/links
router.post('/', async (req, res) => {
  try {
    let { title, url, description, note, collectionId, tags, favorite, color } = req.body;
    if (!title || !url) {
      return res.status(400).json({ error: 'Title and URL are required.' });
    }
    if (!(await ownsCollection(collectionId, req.userId))) {
      return res.status(400).json({ error: 'Invalid collection.' });
    }
    if (color !== undefined && color !== null && !isHexColor(color)) {
      return res.status(400).json({ error: 'Invalid color format.' });
    }

    url = normalizeUrl(url);
    if (!isHttpUrl(url)) {
      return res.status(400).json({ error: 'Only http(s) URLs can be saved.' });
    }
    const existing = await findDuplicateUrl(req.userId, url);
    if (existing) {
      return res.status(409).json({
        error: 'A link with this URL already exists.',
        existing: {
          _id: existing._id,
          title: existing.title,
          url: existing.url,
          description: existing.description,
          note: existing.note,
          tags: existing.tags,
          collectionId: existing.collectionId,
          favorite: existing.favorite,
          visits: existing.visits,
          createdAt: existing.createdAt,
          canonicalUrl: existing.canonicalUrl,
        },
      });
    }

    const link = await Link.create({
      user: req.userId,
      title: String(title).trim(),
      url,
      description: typeof description === 'string' ? description.trim() : '',
      note: typeof note === 'string' ? note.trim() : '',
      collectionId: collectionId || null,
      tags: normalizeTags(tags),
      favorite: Boolean(favorite),
      color: color || randomColor(),
    });

    // Automation rules run right after the link is saved, so a rule that
    // tags or files a link feels instant.
    try {
      await applyRulesToLink(link, req.userId);
    } catch (ruleErr) {
      console.error('[rules] could not be applied:', ruleErr.message);
    }

    // Instantly enrich the link in background (extract og:image, description, article text)
    // so it doesn't have to wait for the periodic cron worker.
    setImmediate(async () => {
      try {
        const extraction = await fetchAndExtract(link.url);
        if (extraction.ok) {
          const { og, article } = buildEnrichment(extraction, new Date());
          const update = { og, article };
          // If user didn't write a custom description, auto-fill with the extracted summary
          if (!link.description && og.description) {
            update.description = og.description;
          }
          await Link.updateOne({ _id: link._id }, { $set: update });
        }
      } catch (enrichErr) {
        // Best-effort; background worker will catch it later
      }
    });

    res.status(201).json(link);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'A link with this URL already exists.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create link.' });
  }
});

// GET /api/links/trash — list links currently in the trash
router.get('/trash', async (req, res) => {
  try {
    const base = { user: req.userId, deletedAt: { $ne: null } };
    const ast = parseQuery(req.query.q || '');
    const { filter } = compileAst(ast, base);

    const total = await Link.countDocuments(filter);
    const sort = sortOption(req.query.sort);
    const limit = parseLimit(req.query.limit, { def: 50 });
    const skip = Math.min(Math.max(parseInt(req.query.skip, 10) || 0, 0), 100000);
    const links = await Link.find(filter).sort(sort).skip(skip).limit(limit);
    res.json({ links, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load trashed links.' });
  }
});

// POST /api/links/trash/empty — permanently delete every trashed link
router.post('/trash/empty', async (req, res) => {
  try {
    const links = await Link.find({ user: req.userId, deletedAt: { $ne: null } }).select('_id');
    const ids = links.map((l) => l._id);
    const result = await Link.deleteMany({ user: req.userId, deletedAt: { $ne: null } });
    if (ids.length > 0) {
      await Visit.deleteMany({ link: { $in: ids }, user: req.userId });
    }
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to empty trash.' });
  }
});

// GET /api/links/archived — the links the user archived.
router.get('/archived', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, { def: 50 });
    const skip = Math.min(Math.max(parseInt(req.query.skip, 10) || 0, 0), 100000);

    const filter = { user: req.userId, deletedAt: null, archivedAt: { $ne: null } };
    const total = await Link.countDocuments(filter);
    const links = await Link.find(filter).sort({ archivedAt: -1 }).skip(skip).limit(limit);

    res.json({ links, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load archived links.' });
  }
});

// GET /api/links/merged — the links that were merged into another one.
router.get('/merged', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, { def: 50 });
    const skip = Math.min(Math.max(parseInt(req.query.skip, 10) || 0, 0), 100000);

    const filter = { user: req.userId, deletedAt: null, mergedInto: { $ne: null } };
    const total = await Link.countDocuments(filter);
    const links = await Link.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('mergedInto', 'title url');

    res.json({ links, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load merged links.' });
  }
});

// GET /api/links/duplicates — groups of links that look like the same page.
//
// The database forbids two *active* links with the same canonical URL, so the
// duplicates that can still exist are the ones the canonical engine did not
// catch: links saved before it existed, and links that share a host and a
// title (the same article reached through two different URLs).
router.get('/duplicates', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, { def: 25, min: 1, max: 100 });
    const userObjectId = new mongoose.Types.ObjectId(req.userId);
    const match = { user: userObjectId, deletedAt: null, archivedAt: null };

    const [sameUrl, sameTitle] = await Promise.all([
      Link.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $toLower: '$url' },
            count: { $sum: 1 },
            links: {
              $push: {
                _id: '$_id',
                title: '$title',
                url: '$url',
                tags: '$tags',
                collectionId: '$collectionId',
                favorite: '$favorite',
                visits: '$visits',
                createdAt: '$createdAt',
              },
            },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
        { $project: { _id: 0, reason: 'same-url', key: '$_id', count: 1, links: 1 } },
      ]),
      Link.aggregate([
        { $match: match },
        {
          $group: {
            _id: { host: '$host', title: '$titleLower' },
            count: { $sum: 1 },
            links: {
              $push: {
                _id: '$_id',
                title: '$title',
                url: '$url',
                tags: '$tags',
                collectionId: '$collectionId',
                favorite: '$favorite',
                visits: '$visits',
                createdAt: '$createdAt',
              },
            },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
        { $project: { _id: 0, reason: 'same-title', key: '$_id', count: 1, links: 1 } },
      ]),
    ]);

    res.json({ groups: [...sameUrl, ...sameTitle] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to find duplicates.' });
  }
});

// POST /api/links/bulk-archive — hide links from the main list.
router.post('/bulk-archive', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No link ids provided.' });
    }
    const validIds = ids.filter((id) => isObjectId(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'No valid link ids provided.' });
    }

    const result = await Link.updateMany(
      { _id: { $in: validIds }, user: req.userId, deletedAt: null, archivedAt: null },
      { $set: { archivedAt: new Date() } }
    );

    res.json({ archived: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to archive links.' });
  }
});

// POST /api/links/bulk-unarchive — bring archived links back.
router.post('/bulk-unarchive', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No link ids provided.' });
    }
    const validIds = ids.filter((id) => isObjectId(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'No valid link ids provided.' });
    }

    // Trashed links can be unarchived too: a link that was archived before
    // it was thrown away would come back hidden from every list.
    const result = await Link.updateMany(
      { _id: { $in: validIds }, user: req.userId, archivedAt: { $ne: null } },
      { $set: { archivedAt: null } }
    );

    res.json({ unarchived: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to unarchive links.' });
  }
});

// POST /api/links/:id/archive — hide one link from the main list.
router.post('/:id/archive', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOneAndUpdate(
      { _id: req.params.id, user: req.userId, deletedAt: null },
      { $set: { archivedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!link) return res.status(404).json({ error: 'Link not found.' });
    res.json({ link });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to archive link.' });
  }
});

// POST /api/links/:id/unarchive — bring an archived link back.
router.post('/:id/unarchive', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOneAndUpdate(
      { _id: req.params.id, user: req.userId },
      { $set: { archivedAt: null } },
      { returnDocument: 'after' }
    );
    if (!link) return res.status(404).json({ error: 'Link not found.' });
    res.json({ link });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to unarchive link.' });
  }
});

// Fold source link into target link.
async function mergeLinkDocs(userId, sourceId, targetId) {
  if (!isObjectId(sourceId) || !isObjectId(targetId)) {
    const err = new Error('Invalid source or target link id.');
    err.status = 400;
    throw err;
  }
  if (String(targetId) === String(sourceId)) {
    const err = new Error('A link cannot be merged into itself.');
    err.status = 400;
    throw err;
  }

  const source = await Link.findOne({ _id: sourceId, user: userId, deletedAt: null });
  if (!source) {
    const err = new Error('Source link not found.');
    err.status = 404;
    throw err;
  }

  const target = await Link.findOne({ _id: targetId, user: userId, deletedAt: null });
  if (!target) {
    const err = new Error('Target link not found.');
    err.status = 404;
    throw err;
  }

  // Fold the source into the target.
  const mergedTags = Array.from(new Set([...(target.tags || []), ...(source.tags || [])]));
  target.tags = mergedTags;
  if (!target.description && source.description) target.description = source.description;
  if (!target.note && source.note) target.note = source.note;
  target.visits = (target.visits || 0) + (source.visits || 0);
  if (source.favorite) target.favorite = true;

  // The canonical URL is unique across live links. If the target never got
  // one (a link saved before the canonical engine existed) it can inherit
  // the source's — but only after the source gives it up, otherwise the
  // unique index rejects the save.
  if (!target.canonicalUrl && source.canonicalUrl) {
    target.canonicalUrl = source.canonicalUrl;
    source.canonicalUrl = null;
  }

  source.mergedInto = target._id;
  source.archivedAt = new Date();
  await source.save();
  await target.save();

  return { merged: source._id, target: target._id, link: source, targetLink: target };
}

// POST /api/links/merge — fold one link into another.
router.post('/merge', async (req, res) => {
  try {
    const { sourceId, targetId, source, target } = req.body || {};
    const sId = sourceId || source;
    const tId = targetId || target;
    const result = await mergeLinkDocs(req.userId, sId, tId);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to merge links.' });
  }
});

// POST /api/links/:id/merge — fold this link into another one.
router.post('/:id/merge', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const { targetId, target } = req.body || {};
    const tId = targetId || target;
    const result = await mergeLinkDocs(req.userId, req.params.id, tId);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to merge links.' });
  }
});

// POST /api/links/:id/unmerge — undo a merge.
//
// The source comes back out of the archive. The tags and visit count that
// were folded into the target stay there — they are useful in their own right
// and cannot be told apart from the target's own data afterwards.
router.post('/:id/unmerge', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOneAndUpdate(
      { _id: req.params.id, user: req.userId, deletedAt: null, mergedInto: { $ne: null } },
      { $set: { mergedInto: null, archivedAt: null } },
      { returnDocument: 'after' }
    );
    if (!link) return res.status(404).json({ error: 'No merged link found.' });
    res.json({ link });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to undo the merge.' });
  }
});

// POST /api/links/:id/enrich — fetch the page's metadata and article now.
router.post('/:id/enrich', enrichLimiter, async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOne({ _id: req.params.id, user: req.userId, deletedAt: null })
      // The article body is excluded by default — it is needed here to rebuild
      // the full-text index after the extraction.
      .select('+article.text');
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    const extraction = await fetchAndExtract(link.url);

    if (!extraction.ok) {
      link.og = {
        ...(link.og?.toObject ? link.og.toObject() : link.og),
        fetchedAt: new Date(),
        error: extraction.error || 'Could not fetch the page.',
      };
      await link.save();
      return res.status(502).json({ error: extraction.error || 'Could not fetch the page.', link });
    }

    const { og, article } = buildEnrichment(extraction, new Date());
    link.og = og;
    link.article = article;
    await link.save();

    res.json({ link });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to enrich link.' });
  }
});

// POST /api/links/apply-rules — run every enabled rule against several links.
router.post('/apply-rules', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => isObjectId(id)) : [];
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No link ids provided.' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ error: 'Please run the rules on at most 200 links at a time.' });
    }

    const links = await Link.find({ _id: { $in: ids }, user: req.userId, deletedAt: null });
    let changed = 0;

    for (const link of links) {
      const applied = await applyRulesToLink(link, req.userId);
      if (applied > 0) changed += 1;
    }

    res.json({ processed: links.length, changed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to apply the rules.' });
  }
});

// POST /api/links/:id/apply-rules — run every enabled rule against one link.
router.post('/:id/apply-rules', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOne({ _id: req.params.id, user: req.userId, deletedAt: null });
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    const applied = await applyRulesToLink(link, req.userId);

    res.json({ link, applied });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to apply the rules.' });
  }
});

// POST /api/links/bulk-tag — add or remove tags on several links at once.
router.post('/bulk-tag', async (req, res) => {
  try {
    const { ids, tags, mode = 'add' } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No link ids provided.' });
    }
    const validIds = ids.filter((id) => isObjectId(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'No valid link ids provided.' });
    }

    const normalized = normalizeTags(tags || []);
    if (normalized.length === 0) {
      return res.status(400).json({ error: 'No tags provided.' });
    }

    const filter = { _id: { $in: validIds }, user: req.userId, deletedAt: null };
    const update =
      mode === 'remove'
        ? { $pull: { tags: { $in: normalized } } }
        : { $addToSet: { tags: { $each: normalized } } };

    const result = await Link.updateMany(filter, update);

    res.json({ updated: result.modifiedCount, tags: normalized });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update the tags.' });
  }
});

// POST /api/links/enrich-batch — fetch the metadata of several links.
router.post('/enrich-batch', enrichLimiter, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => isObjectId(id)) : [];
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No link ids provided.' });
    }
    if (ids.length > 20) {
      return res.status(400).json({ error: 'Please enrich at most 20 links at a time.' });
    }

    const links = await Link.find({ _id: { $in: ids }, user: req.userId, deletedAt: null })
      .select('+article.text');
    const results = [];

    for (const link of links) {
      const extraction = await fetchAndExtract(link.url);
      if (!extraction.ok) {
        results.push({ id: link._id, ok: false, error: extraction.error });
        continue;
      }
      const { og, article } = buildEnrichment(extraction, new Date());
      link.og = og;
      link.article = article;
      await link.save();
      results.push({ id: link._id, ok: true });
    }

    res.json({ results, enriched: results.filter((r) => r.ok).length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to enrich the links.' });
  }
});

// GET /api/links/:id/article — the extracted page body, for reader mode.
//
// The body is deliberately kept out of the normal link payload: it is big,
// and a list of fifty cards would ship half a megabyte of prose. This
// endpoint asks for it explicitly, and only when the reader is opened.
router.get('/:id/article', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOne({ _id: req.params.id, user: req.userId, deletedAt: null })
      .select('+article.text');
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    res.json({
      id: link._id,
      title: link.title,
      url: link.url,
      og: link.og || null,
      article: {
        text: link.article?.text || '',
        wordCount: link.article?.wordCount || 0,
        extractedAt: link.article?.extractedAt || null,
      },
      // The reader can fetch the page itself when the stored copy is empty.
      empty: !link.article?.text,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load the article.' });
  }
});

// GET /api/links/:id
router.get('/:id', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOne({ _id: req.params.id, user: req.userId, deletedAt: null });
    if (!link) return res.status(404).json({ error: 'Link not found.' });
    res.json(link);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load link.' });
  }
});

// PATCH /api/links/:id
router.patch('/:id', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOne({ _id: req.params.id, user: req.userId, deletedAt: null });
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    const { title, url, description, note, collectionId, tags, favorite, color } = req.body;

    if (collectionId !== undefined && collectionId) {
      if (!(await ownsCollection(collectionId, req.userId))) {
        return res.status(400).json({ error: 'Invalid collection.' });
      }
    }
    if (color !== undefined && color !== null && !isHexColor(color)) {
      return res.status(400).json({ error: 'Invalid color format.' });
    }

    if (title !== undefined) link.title = String(title).trim();
    if (url !== undefined) {
      const newUrl = normalizeUrl(url);
      if (!isHttpUrl(newUrl)) {
        return res.status(400).json({ error: 'Only http(s) URLs can be saved.' });
      }
      // Duplicate check runs on the canonical URL, so editing a link to a
      // variant of an existing one is caught too.
      const existing = await findDuplicateUrl(req.userId, newUrl, link._id);
      if (existing) {
        return res.status(409).json({
          error: 'Another saved link already uses this URL.',
          existing: {
            _id: existing._id,
            title: existing.title,
            url: existing.url,
            description: existing.description,
            note: existing.note,
            tags: existing.tags,
            collectionId: existing.collectionId,
            favorite: existing.favorite,
            visits: existing.visits,
            createdAt: existing.createdAt,
            canonicalUrl: existing.canonicalUrl,
          },
        });
      }
      link.url = newUrl;
    }
    if (description !== undefined) link.description = String(description).trim();
    // The private note. Separate from `description` (a short public summary):
    // the note is long-form and never shown in a share.
    if (note !== undefined) link.note = String(note).trim();
    if (color !== undefined && color !== null) link.color = color; // null => keep current
    if (favorite !== undefined) link.favorite = Boolean(favorite);
    if (collectionId !== undefined) link.collectionId = collectionId || null;
    if (tags !== undefined) link.tags = normalizeTags(tags);

    await link.save();
    res.json(link);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'Another saved link already uses this URL.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update link.' });
  }
});

// DELETE /api/links/:id — move a link to the trash (soft delete)
router.delete('/:id', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOneAndUpdate(
      { _id: req.params.id, user: req.userId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    res.json({ message: 'Link moved to trash successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move link to trash.' });
  }
});

// POST /api/links/:id/restore — restore a link from the trash
router.post('/:id/restore', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOneAndUpdate(
      { _id: req.params.id, user: req.userId, deletedAt: { $ne: null } },
      { $set: { deletedAt: null } },
      { returnDocument: 'after' }
    );
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    res.json({ message: 'Link restored successfully', link });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'Another saved link already uses this URL.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to restore link.' });
  }
});

// DELETE /api/links/:id/permanent — permanently delete a link from the trash
router.delete('/:id/permanent', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const link = await Link.findOneAndDelete({
      _id: req.params.id,
      user: req.userId,
      deletedAt: { $ne: null },
    });
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    await Visit.deleteMany({ link: link._id, user: req.userId });
    res.json({ message: 'Link permanently deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to permanently delete link.' });
  }
});

// POST /api/links/:id/visit
router.post('/:id/visit', visitLimiter, async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid link id.' });
  try {
    const key = `${req.userId}:${req.params.id}`;
    const now = Date.now();
    const last = visitDebounce.get(key);
    if (last && now - last < VISIT_DEBOUNCE_MS) {
      return res.status(204).end();
    }
    if (visitDebounce.size > 50000) {
      // Evict only expired entries — clearing the whole map would reset every
      // user's debounce window at once and let duplicate visits through.
      for (const [k, t] of visitDebounce) {
        if (now - t >= VISIT_DEBOUNCE_MS) visitDebounce.delete(k);
      }
    }
    visitDebounce.set(key, now);

    const link = await Link.findOneAndUpdate(
      { _id: req.params.id, user: req.userId, deletedAt: null },
      { $inc: { visits: 1 }, $set: { lastVisitedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    await Visit.create({ user: req.userId, link: link._id });

    res.json(link);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record visit.' });
  }
});

module.exports = router;
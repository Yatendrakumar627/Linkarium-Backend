const express = require('express');
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

const router = express.Router();

router.use(auth);

function buildQuery(req) {
  const { q, tag, collection, favorite, deleted } = req.query;
  const query = { user: req.userId };

  if (deleted === 'true') {
    query.deletedAt = { $ne: null };
  } else {
    query.deletedAt = null;
  }

  if (q) {
    const rx = new RegExp(escapeRegex(String(q)), 'i');
    query.$or = [{ title: rx }, { url: rx }, { tags: rx }];
  }
  if (tag) query.tags = String(tag).toLowerCase().trim();
  if (collection) {
    query.collectionId = String(collection) === 'none' ? null : String(collection);
  }
  if (favorite === 'true') query.favorite = true;

  return query;
}

function sortOption(value) {
  switch (value) {
    case 'oldest':
      return { createdAt: 1 };
    case 'visits':
      return { visits: -1 };
    case 'favorite':
      return { favorite: -1, createdAt: -1 };
    default:
      return { createdAt: -1 };
  }
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ownsCollection(collectionId, userId) {
  if (!collectionId) return true;
  if (!isObjectId(collectionId)) return false;
  return Boolean(await Collection.exists({ _id: collectionId, user: userId }));
}

async function findDuplicateUrl(userId, url, excludeId = null) {
  const q = { user: userId, deletedAt: null, url };
  if (excludeId) q._id = { $ne: excludeId };
  return Link.findOne(q).select('_id title url createdAt');
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

// Collapse repeated opens of the same link within a short window into one visit.
// In-memory per process — exact on a single instance, best-effort if scaled out.
const VISIT_DEBOUNCE_MS = 60 * 1000;
const visitDebounce = new Map();

// --- IMPORT / EXPORT ---

function parseImportRows(buffer, originalname) {
  const ext = (originalname || '').toLowerCase().split('.').pop();
  let rows;

  if (ext === 'csv') {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  } else {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  }

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
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    const rows = parseImportRows(req.file.buffer, req.file.originalname);
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
        errors.push(`Row ${rowNum}: ${err.message}`);
      }
    }

    res.json({ imported, skipped, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to import links.' });
  }
});

// GET /api/links/export
router.get('/export', async (req, res) => {
  try {
    const format = (req.query.format || 'xlsx').toLowerCase();

    const links = await Link.find({ user: req.userId, deletedAt: null }).sort({ createdAt: -1 });
    const collections = await Collection.find({ user: req.userId });
    const collectionNameMap = {};
    for (const c of collections) {
      collectionNameMap[String(c._id)] = c.name;
    }

    // --- CSV export (keep using XLSX library — lightweight, works fine for plain text) ---
    if (format === 'csv') {
      const data = links.map((l) => ({
        Title: l.title,
        URL: l.url,
        Tags: (l.tags || []).join(', '),
        Description: l.description || '',
        Collection: l.collectionId ? collectionNameMap[String(l.collectionId)] || '' : '',
        Hyperlink: l.url,
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

// GET /api/links — server-side search, filter, sort and pagination
router.get('/', async (req, res) => {
  try {
    const filter = buildQuery(req);
    const total = await Link.countDocuments(filter);
    const sort = sortOption(req.query.sort);
    const limit = parseLimit(req.query.limit, { def: 50 });
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const links = await Link.find(filter).sort(sort).skip(skip).limit(limit);
    res.json({ links, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load links.' });
  }
});

// POST /api/links
router.post('/', async (req, res) => {
  try {
    let { title, url, description, collectionId, tags, favorite, color } = req.body;
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
    const existing = await findDuplicateUrl(req.userId, url);
    if (existing) {
      return res.status(409).json({
        error: 'A link with this URL already exists.',
        existing: { _id: existing._id, title: existing.title, url: existing.url, createdAt: existing.createdAt },
      });
    }

    const link = await Link.create({
      user: req.userId,
      title: String(title).trim(),
      url,
      description: typeof description === 'string' ? description.trim() : '',
      collectionId: collectionId || null,
      tags: normalizeTags(tags),
      favorite: Boolean(favorite),
      color: color || randomColor(),
    });

    res.status(201).json(link);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create link.' });
  }
});

// GET /api/links/trash — list links currently in the trash
router.get('/trash', async (req, res) => {
  try {
    const { q } = req.query;
    const query = { user: req.userId, deletedAt: { $ne: null } };

    if (q) {
      const rx = new RegExp(escapeRegex(String(q)), 'i');
      query.$or = [{ title: rx }, { url: rx }, { tags: rx }];
    }

    const total = await Link.countDocuments(query);
    const sort = sortOption(req.query.sort);
    const limit = parseLimit(req.query.limit, { def: 50 });
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const links = await Link.find(query).sort(sort).skip(skip).limit(limit);
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

    const { title, url, description, collectionId, tags, favorite, color } = req.body;

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
      if (newUrl !== link.url) {
        const existing = await findDuplicateUrl(req.userId, newUrl, link._id);
        if (existing) {
          return res.status(409).json({
            error: 'Another saved link already uses this URL.',
            existing: { _id: existing._id, title: existing.title, url: existing.url, createdAt: existing.createdAt },
          });
        }
      }
      link.url = newUrl;
    }
    if (description !== undefined) link.description = String(description).trim();
    if (color !== undefined) link.color = color;
    if (favorite !== undefined) link.favorite = Boolean(favorite);
    if (collectionId !== undefined) link.collectionId = collectionId || null;
    if (tags !== undefined) link.tags = normalizeTags(tags);

    await link.save();
    res.json(link);
  } catch (err) {
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
      { new: true }
    );
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    res.json({ message: 'Link restored successfully', link });
  } catch (err) {
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
    if (visitDebounce.size > 50000) visitDebounce.clear();
    visitDebounce.set(key, now);

    const link = await Link.findOneAndUpdate(
      { _id: req.params.id, user: req.userId, deletedAt: null },
      { $inc: { visits: 1 }, $set: { lastVisitedAt: new Date() } },
      { new: true }
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
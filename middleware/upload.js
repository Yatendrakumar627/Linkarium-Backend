const path = require('path');
const multer = require('multer');

const ALLOWED_MIMES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/csv',
  'text/plain',
];

const ALLOWED_EXTS = ['.csv', '.xls', '.xlsx'];

const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  // Sanitize originalname: prevent directory traversal and null-byte attacks
  file.originalname = path.basename(file.originalname || '').replace(/[^\w.-]/g, '_');

  // Require BOTH an allowed extension and an allowed mime type (either one
  // alone is trivially spoofable by the client).
  if (ALLOWED_MIMES.includes(file.mimetype) && ALLOWED_EXTS.includes(ext)) {
    cb(null, true);
  } else {
    const err = new Error('Only CSV and Excel (.xlsx, .xls) files are allowed.');
    err.status = 400;
    cb(err);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

/**
 * Deep buffer inspection middleware: validates magic bytes / binary signatures
 * to prevent disguised executables or malicious polyglots.
 */
function validateUploadSignature(req, res, next) {
  if (!req.file || !req.file.buffer) return next();

  const buf = req.file.buffer;
  const ext = path.extname(req.file.originalname || '').toLowerCase();

  // Executable / malicious binary signatures to reject immediately
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
    // 'MZ' DOS/Windows executable
    return res.status(400).json({ error: 'Executable files are prohibited.' });
  }
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    // ELF executable
    return res.status(400).json({ error: 'Executable files are prohibited.' });
  }

  if (ext === '.xlsx') {
    // OpenXML format must start with PK zip signature
    const isZip =
      buf.length >= 4 &&
      buf[0] === 0x50 &&
      buf[1] === 0x4b &&
      (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
    if (!isZip) {
      return res.status(400).json({ error: 'Corrupt or invalid .xlsx file structure.' });
    }
  } else if (ext === '.xls') {
    // Legacy Excel OLE Compound File Header: D0 CF 11 E0 A1 B1 1A E1
    const isOle =
      buf.length >= 8 &&
      buf[0] === 0xd0 &&
      buf[1] === 0xcf &&
      buf[2] === 0x11 &&
      buf[3] === 0xe0 &&
      buf[4] === 0xa1 &&
      buf[5] === 0xb1 &&
      buf[6] === 0x1a &&
      buf[7] === 0xe1;
    if (!isOle) {
      return res.status(400).json({ error: 'Corrupt or invalid legacy .xls file structure.' });
    }
  } else if (ext === '.csv') {
    // CSV must be printable text: reject if null bytes exist in the first 1KB
    const sampleSize = Math.min(buf.length, 1024);
    for (let i = 0; i < sampleSize; i++) {
      if (buf[i] === 0x00) {
        return res.status(400).json({ error: 'Binary data detected in CSV upload.' });
      }
    }
  }

  next();
}

upload.validateUploadSignature = validateUploadSignature;

module.exports = upload;
module.exports.upload = upload;
module.exports.validateUploadSignature = validateUploadSignature;

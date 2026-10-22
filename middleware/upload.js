const path = require('path');
const multer = require('multer');

const ALLOWED_MIMES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/csv',
];

const ALLOWED_EXTS = ['.csv', '.xls', '.xlsx'];

const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
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

module.exports = upload;

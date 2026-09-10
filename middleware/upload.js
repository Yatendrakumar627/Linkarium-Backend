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
  const ext = (file.originalname || '').slice('.').toLowerCase();
  if (ALLOWED_MIMES.includes(file.mimetype) || ALLOWED_EXTS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV and Excel (.xlsx, .xls) files are allowed.'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

module.exports = upload;

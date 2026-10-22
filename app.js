require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const collectionRoutes = require('./routes/collections');
const tagRoutes = require('./routes/tags');
const analyticsRoutes = require('./routes/analytics');
const userRoutes = require('./routes/user');
const metadataRoutes = require('./routes/metadata');
const enrichRoutes = require('./routes/enrich');
const searchRoutes = require('./routes/search');
const linkHealthRoutes = require('./routes/linkHealth');
const savedViewRoutes = require('./routes/savedViews');
const insightsRoutes = require('./routes/insights');
const sessionRoutes = require('./routes/sessions');
const apiKeyRoutes = require('./routes/apiKeys');
const shareRoutes = require('./routes/share');
const internalRoutes = require('./routes/internal');
const { createRateLimitStore } = require('./utils/rateLimitStore');

const app = express();

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const ALLOWED_ORIGINS = CLIENT_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);

app.set('trust proxy', 1);
app.use(compression({
  threshold: 1024,
  level: 6,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true, exposedHeaders: ['Content-Disposition'] }));
app.use(cookieParser());
app.use(express.json({ limit: '100kb' })); // Throws a 413 via error handler when exceeded

const limiterHandler = (req, res) => res.status(429).json({ error: 'Too many requests. Please try again later.' });

// The counters live in MongoDB, so the limits are global: every server
// instance shares them and a deploy does not reset them. Each limiter gets
// its own namespace so two limiters can never share a counter.
const API_WINDOW_MS = 15 * 60 * 1000;

// Baseline protection for the whole API (import/export add tighter per-endpoint
// limits in routes/links.js).
const apiLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('api', API_WINDOW_MS),
  handler: limiterHandler,
  validate: { default: true, singleCount: false },
});

// Brute-force guard for auth endpoints
const authLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('auth', API_WINDOW_MS),
  handler: (req, res) => res.status(429).json({ error: 'Too many attempts. Please try again later.' }),
  validate: { default: true, singleCount: false },
});

// Much stricter throttle on the two credential-testing endpoints
const strictAuthLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('strict-auth', API_WINDOW_MS),
  handler: (req, res) => res.status(429).json({ error: 'Too many attempts. Please try again later.' }),
  validate: { default: true, singleCount: false },
});

app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/auth/login', strictAuthLimiter);
app.use('/api/auth/register', strictAuthLimiter);

// --- API ROUTES ---
app.use('/api/auth', authRoutes);
app.use('/api/links', linkRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/user', userRoutes);
app.use('/api/metadata', metadataRoutes);
app.use('/api/enrich', enrichRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/link-health', linkHealthRoutes);
app.use('/api/saved-views', savedViewRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/internal', internalRoutes);

// Public, read-only collection shares. These are intentionally *not* under
// /api/collections: they have their own, unauthenticated surface.
app.use('/api/share', shareRoutes);
app.use('/api/shared', shareRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// JSON 404 for unknown API routes (the frontend expects JSON bodies)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large.' });
  }
  if (err?.name === 'MulterError') {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res
      .status(tooLarge ? 413 : 400)
      .json({ error: tooLarge ? 'File is too large (max 5 MB).' : `Upload error: ${err.message}` });
  }
  // Client errors tagged upstream (e.g. the upload fileFilter sets status 400)
  if (err?.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  // Response already streaming (e.g. export failed mid-write) — let Express
  // tear down the connection instead of trying to send JSON headers again.
  if (err?.headersSent) return next(err);
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

module.exports = app;

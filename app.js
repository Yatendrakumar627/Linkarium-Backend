require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const collectionRoutes = require('./routes/collections');
const tagRoutes = require('./routes/tags');
const analyticsRoutes = require('./routes/analytics');
const userRoutes = require('./routes/user');
const metadataRoutes = require('./routes/metadata');

const app = express();

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: '100kb' })); // Throws a 413 via error handler when exceeded

// Brute-force guard for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many attempts. Please try again later.' }),
});
app.use('/api/auth', authLimiter);

// --- API ROUTES ---
app.use('/api/auth', authRoutes);
app.use('/api/links', linkRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/user', userRoutes);
app.use('/api/metadata', metadataRoutes);

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
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

module.exports = app;
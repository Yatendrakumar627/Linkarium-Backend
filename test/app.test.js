const { describe, test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../app');

// These smoke tests exercise the Express wiring and request validation only.
// They do NOT touch MongoDB, so they run without a database.

describe('App wiring', () => {
  test('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { status: 'ok' });
  });

  test('unknown /api route returns JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(typeof res.body.error, 'string');
  });

  test('malformed JSON body returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid JSON body.');
  });

  test('protected route rejects missing token', async () => {
    const res = await request(app).get('/api/links');
    assert.strictEqual(res.status, 401);
  });
});

describe('Auth validation', () => {
  test('register requires fields', async () => {
    const res = await request(app).post('/api/auth/register').send({});
    assert.strictEqual(res.status, 400);
  });

  test('register rejects an invalid email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada Lovelace', email: 'not-an-email', password: 'secret123' });
    assert.strictEqual(res.status, 400);
  });

  test('register rejects a short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada Lovelace', email: 'ada@example.com', password: '123' });
    assert.strictEqual(res.status, 400);
  });

  test('register rejects an over-long name', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'x'.repeat(61), email: 'ada@example.com', password: 'secret123' });
    assert.strictEqual(res.status, 400);
  });

  test('login requires fields', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: '', password: '' });
    assert.strictEqual(res.status, 400);
  });
});
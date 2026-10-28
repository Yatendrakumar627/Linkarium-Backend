const { describe, test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../app');
const {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  getCachedTokenVersion,
  setCachedTokenVersion,
} = require('../utils/helpers');

describe('Security & Isolation Controls', () => {
  test('API keys are prohibited from accessing user account endpoints', async () => {
    const res = await request(app)
      .get('/api/user/me')
      .set('Authorization', 'Bearer lk_testprefix_secret1234567890');
    assert.strictEqual(res.status, 403);
    assert.ok(res.body.error.includes('Personal API keys are restricted'));
  });

  test('API keys are prohibited from accessing session endpoints', async () => {
    const res = await request(app)
      .get('/api/sessions')
      .set('X-API-Key', 'lk_testprefix_secret1234567890');
    assert.strictEqual(res.status, 403);
    assert.ok(res.body.error.includes('Personal API keys are restricted'));
  });

  test('API keys are prohibited from accessing API key management endpoints', async () => {
    const res = await request(app)
      .get('/api/api-keys')
      .set('X-API-Key', 'lk_testprefix_secret1234567890');
    assert.strictEqual(res.status, 403);
    assert.ok(res.body.error.includes('Personal API keys are restricted'));
  });

  test('Token version caching correctly stores and validates user status', () => {
    const testUserId = 'test_user_status_123';
    setCachedTokenVersion(testUserId, 1, 'active');
    const cachedActive = getCachedTokenVersion(testUserId);
    assert.ok(cachedActive);
    assert.strictEqual(cachedActive.v, 1);
    assert.strictEqual(cachedActive.status, 'active');

    setCachedTokenVersion(testUserId, 2, 'suspended');
    const cachedSuspended = getCachedTokenVersion(testUserId);
    assert.ok(cachedSuspended);
    assert.strictEqual(cachedSuspended.v, 2);
    assert.strictEqual(cachedSuspended.status, 'suspended');
  });

  test('Access tokens cannot be used as refresh tokens', () => {
    const fakeUser = {
      _id: '507f1f77bcf86cd799439011',
      tokenVersion: 0,
      role: 'user',
    };
    const accessTok = signAccessToken(fakeUser);
    assert.throws(() => {
      verifyToken(accessTok, 'refresh');
    }, /Invalid token type/);
  });

  test('Refresh tokens cannot be used as access tokens', () => {
    const fakeUser = {
      _id: '507f1f77bcf86cd799439011',
      tokenVersion: 0,
      role: 'user',
    };
    const refreshTok = signRefreshToken(fakeUser);
    assert.throws(() => {
      verifyToken(refreshTok, 'access');
    }, /Invalid token type/);
  });
});

const { describe, test } = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { isObjectId, isEmail, isHexColor, parseLimit } = require('../utils/validators');

describe('Validators', () => {
  describe('isObjectId', () => {
    test('accepts valid 24-character hex ObjectId strings', () => {
      const validId = new mongoose.Types.ObjectId().toString();
      assert.strictEqual(isObjectId(validId), true);
      assert.strictEqual(isObjectId('507f1f77bcf86cd799439011'), true);
    });

    test('rejects non-ObjectId strings', () => {
      assert.strictEqual(isObjectId(''), false);
      assert.strictEqual(isObjectId('12345'), false);
      assert.strictEqual(isObjectId('invalid-hex-id-that-is-not-24-chars'), false);
      assert.strictEqual(isObjectId(null), false);
      assert.strictEqual(isObjectId(undefined), false);
    });
  });

  describe('isEmail', () => {
    test('accepts standard valid email addresses', () => {
      assert.strictEqual(isEmail('user@example.com'), true);
      assert.strictEqual(isEmail('john.doe+linkarium@domain.co.uk'), true);
      assert.strictEqual(isEmail('admin_123@sub.host.org'), true);
    });

    test('rejects invalid email formats', () => {
      assert.strictEqual(isEmail('not-an-email'), false);
      assert.strictEqual(isEmail('missing@domain'), false);
      assert.strictEqual(isEmail('@missinguser.com'), false);
      assert.strictEqual(isEmail('spaces in@domain.com'), false);
      assert.strictEqual(isEmail(''), false);
      assert.strictEqual(isEmail(null), false);
      assert.strictEqual(isEmail(undefined), false);
    });
  });

  describe('isHexColor', () => {
    test('accepts valid 6-character hex colors prefixed with hash', () => {
      assert.strictEqual(isHexColor('#ffffff'), true);
      assert.strictEqual(isHexColor('#000000'), true);
      assert.strictEqual(isHexColor('#ff00aa'), true);
      assert.strictEqual(isHexColor('#ABCDEF'), true);
      assert.strictEqual(isHexColor('#123456'), true);
    });

    test('rejects invalid hex color formats', () => {
      assert.strictEqual(isHexColor('ffffff'), false); // missing hash
      assert.strictEqual(isHexColor('#fff'), false); // 3-char not accepted by strict 6-char validator
      assert.strictEqual(isHexColor('#fffffff'), false); // 7 chars
      assert.strictEqual(isHexColor('#gggggg'), false); // non-hex letters
      assert.strictEqual(isHexColor(''), false);
      assert.strictEqual(isHexColor(null), false);
    });
  });

  describe('parseLimit', () => {
    test('returns parsed integer within min and max boundaries', () => {
      assert.strictEqual(parseLimit('25'), 25);
      assert.strictEqual(parseLimit(100), 100);
    });

    test('clamps values below min or above max', () => {
      assert.strictEqual(parseLimit('-10', { min: 1, max: 100 }), 1);
      assert.strictEqual(parseLimit('500', { min: 1, max: 100 }), 100);
      assert.strictEqual(parseLimit('0', { def: 20, min: 5, max: 50 }), 5);
    });

    test('returns default when value is NaN or missing', () => {
      assert.strictEqual(parseLimit('invalid'), 50);
      assert.strictEqual(parseLimit(null, { def: 30 }), 30);
      assert.strictEqual(parseLimit(undefined, { def: 15 }), 15);
      assert.strictEqual(parseLimit('', { def: 40 }), 40);
    });
  });
});


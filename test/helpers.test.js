const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeUrl,
  randomColor,
  normalizeTags,
  publicUser,
  setCachedTokenVersion,
  getCachedTokenVersion,
  invalidateTokenVersion,
} = require('../utils/helpers');

describe('Helpers utility', () => {
  describe('normalizeUrl', () => {
    test('preserves valid http and https urls', () => {
      assert.strictEqual(normalizeUrl('https://example.com/test'), 'https://example.com/test');
      assert.strictEqual(normalizeUrl('http://example.com'), 'http://example.com');
    });

    test('adds https:// to schemeless urls', () => {
      assert.strictEqual(normalizeUrl('example.com/article'), 'https://example.com/article');
      assert.strictEqual(normalizeUrl('sub.domain.org/path?k=v'), 'https://sub.domain.org/path?k=v');
    });

    test('converts protocol-relative urls to https', () => {
      assert.strictEqual(normalizeUrl('//cdn.example.com/lib.js'), 'https://cdn.example.com/lib.js');
    });

    test('rejects unsafe schemes like javascript: or mailto:', () => {
      assert.strictEqual(normalizeUrl('javascript:alert(1)'), '');
      assert.strictEqual(normalizeUrl('data:text/html,<script>alert(1)</script>'), '');
      assert.strictEqual(normalizeUrl('mailto:user@example.com'), '');
    });

    test('handles empty and non-string inputs', () => {
      assert.strictEqual(normalizeUrl(''), '');
      assert.strictEqual(normalizeUrl('   '), '');
      assert.strictEqual(normalizeUrl(null), '');
      assert.strictEqual(normalizeUrl(undefined), '');
    });
  });

  describe('randomColor', () => {
    test('generates valid 6-digit hex color with hash prefix', () => {
      for (let i = 0; i < 20; i++) {
        const color = randomColor();
        assert.match(color, /^#[0-9a-f]{6}$/);
      }
    });
  });

  describe('normalizeTags', () => {
    test('converts tags to lowercase, trims whitespace and replaces spaces with hyphens', () => {
      const input = [' Web Dev ', 'REACT JS', 'Machine   Learning'];
      const output = normalizeTags(input);
      assert.deepStrictEqual(output, ['web-dev', 'react-js', 'machine-learning']);
    });

    test('deduplicates tags', () => {
      const input = ['react', 'React', 'REACT', 'dev'];
      const output = normalizeTags(input);
      assert.deepStrictEqual(output, ['react', 'dev']);
    });

    test('caps tag list at maximum 30 tags', () => {
      const input = Array.from({ length: 45 }, (_, i) => `tag-${i}`);
      const output = normalizeTags(input);
      assert.strictEqual(output.length, 30);
      assert.strictEqual(output[0], 'tag-0');
      assert.strictEqual(output[29], 'tag-29');
    });

    test('handles invalid inputs safely', () => {
      assert.deepStrictEqual(normalizeTags(null), []);
      assert.deepStrictEqual(normalizeTags(undefined), []);
      assert.deepStrictEqual(normalizeTags(['', null, undefined, '   ']), []);
    });
  });

  describe('publicUser', () => {
    test('sanitizes user object and shapes public fields and preferences', () => {
      const fakeDbUser = {
        _id: 'user123',
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'hashed-secret-password-should-not-leak',
        totp: { enabled: true, secret: 'JBSWY3DPEHPK3PXP' },
        recoveryCodes: ['code1', 'code2'],
        role: 'user',
        isMaster: false,
        status: 'active',
        loginCount: 5,
        avatarColor: '#123456',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        preferences: {
          theme: 'dark',
          defaultView: 'links',
          colorMode: 'brand',
          autoEnrich: true,
          tagColors: { react: '#61dafb' },
        },
      };

      const pub = publicUser(fakeDbUser);
      assert.strictEqual(pub.id, 'user123');
      assert.strictEqual(pub.name, 'Jane Doe');
      assert.strictEqual(pub.email, 'jane@example.com');
      assert.strictEqual(pub.role, 'user');
      assert.strictEqual(pub.twoFactorEnabled, true);
      assert.strictEqual(pub.recoveryCodesLeft, 2);
      assert.strictEqual(pub.preferences.theme, 'dark');
      assert.strictEqual(pub.preferences.colorMode, 'brand');
      assert.deepStrictEqual(pub.preferences.tagColors, { react: '#61dafb' });

      // Ensure secret fields are NOT leaked
      assert.strictEqual(pub.password, undefined);
      assert.strictEqual(pub.totp, undefined);
      assert.strictEqual(pub.recoveryCodes, undefined);
    });
  });

  describe('tokenVersionCache', () => {
    test('invalidates cached token version on demand', () => {
      const uid = 'cache_test_user_789';
      setCachedTokenVersion(uid, 1, 'active');
      assert.ok(getCachedTokenVersion(uid));
      invalidateTokenVersion(uid);
      assert.strictEqual(getCachedTokenVersion(uid), undefined);
    });
  });
});


const { describe, test } = require('node:test');
const assert = require('node:assert');
const totp = require('../utils/totp');

describe('base32', () => {
  test('round-trips a buffer', () => {
    const buffer = Buffer.from('hello world');
    const encoded = totp.base32Encode(buffer);
    assert.deepStrictEqual(totp.base32Decode(encoded), buffer);
  });

  test('decodes the RFC 4226 test secret', () => {
    // "Hello!\xDE\xAD\xBE\xEF"
    assert.strictEqual(
      totp.base32Decode('JBSWY3DPEHPK3PXP').toString('latin1'),
      'Hello!\xDE\xAD\xBE\xEF'
    );
  });

  test('throws on an invalid character', () => {
    assert.throws(() => totp.base32Decode('JBSW!Y3DP'));
  });
});

describe('generateSecret', () => {
  test('produces a 32 character base32 secret', () => {
    const secret = totp.generateSecret();
    assert.strictEqual(secret.length, 32);
    assert.match(secret, /^[A-Z2-7]+$/);
  });

  test('produces a different secret every time', () => {
    assert.notStrictEqual(totp.generateSecret(), totp.generateSecret());
  });
});

describe('hotp', () => {
  test('matches the RFC 4226 test vectors', () => {
    // The RFC secret is the ASCII string "12345678901234567890".
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.strictEqual(totp.hotp(secret, 0), '755224');
    assert.strictEqual(totp.hotp(secret, 1), '287082');
    assert.strictEqual(totp.hotp(secret, 2), '359152');
    assert.strictEqual(totp.hotp(secret, 3), '969429');
    assert.strictEqual(totp.hotp(secret, 4), '338314');
    assert.strictEqual(totp.hotp(secret, 5), '254676');
    assert.strictEqual(totp.hotp(secret, 6), '287922');
    assert.strictEqual(totp.hotp(secret, 7), '162583');
    assert.strictEqual(totp.hotp(secret, 8), '399871');
    assert.strictEqual(totp.hotp(secret, 9), '520489');
  });
});

describe('totp', () => {
  test('is the hotp of the current 30 second step', () => {
    const secret = totp.generateSecret();
    const timestamp = 1_700_000_000_000;
    const expected = totp.hotp(secret, Math.floor(timestamp / 1000 / 30));
    assert.strictEqual(totp.totp(secret, { timestamp }), expected);
  });

  test('is stable within a step', () => {
    const secret = totp.generateSecret();
    const a = totp.totp(secret, { timestamp: 1_700_000_000_000 });
    const b = totp.totp(secret, { timestamp: 1_700_000_005_000 });
    assert.strictEqual(a, b);
  });

  test('changes in the next step', () => {
    const secret = totp.generateSecret();
    const a = totp.totp(secret, { timestamp: 1_700_000_000_000 });
    const b = totp.totp(secret, { timestamp: 1_700_000_060_000 });
    assert.notStrictEqual(a, b);
  });
});

describe('verify', () => {
  test('accepts the current code', () => {
    const secret = totp.generateSecret();
    const timestamp = 1_700_000_000_000;
    const code = totp.totp(secret, { timestamp });
    assert.strictEqual(totp.verify(secret, code, { timestamp }), true);
  });

  test('accepts a code from the previous step', () => {
    const secret = totp.generateSecret();
    const timestamp = 1_700_000_000_000;
    const code = totp.totp(secret, { timestamp: timestamp - 30_000 });
    assert.strictEqual(totp.verify(secret, code, { timestamp }), true);
  });

  test('rejects a code from too far away', () => {
    const secret = totp.generateSecret();
    const timestamp = 1_700_000_000_000;
    const code = totp.totp(secret, { timestamp: timestamp - 300_000 });
    assert.strictEqual(totp.verify(secret, code, { timestamp }), false);
  });

  test('rejects nonsense', () => {
    const secret = totp.generateSecret();
    assert.strictEqual(totp.verify(secret, 'abcdef'), false);
    assert.strictEqual(totp.verify(secret, ''), false);
    assert.strictEqual(totp.verify(secret, '123'), false);
  });
});

describe('otpauthUrl', () => {
  test('contains the secret and the issuer', () => {
    const url = totp.otpauthUrl('JBSWY3DPEHPK3PXP', 'me@example.com', 'Linkarium');
    assert.ok(url.startsWith('otpauth://totp/'));
    assert.ok(url.includes('secret=JBSWY3DPEHPK3PXP'));
    assert.ok(url.includes('issuer=Linkarium'));
  });
});

describe('recovery codes', () => {
  test('generates the requested number of codes', () => {
    const codes = totp.generateRecoveryCodes(10);
    assert.strictEqual(codes.length, 10);
    assert.ok(codes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)));
  });

  test('the hash is stable and case insensitive', () => {
    const hash = totp.hashRecoveryCode('ABCDE-FGHIJ');
    assert.strictEqual(hash, totp.hashRecoveryCode('abcde-fghij'));
    assert.notStrictEqual(hash, totp.hashRecoveryCode('ABCDE-FGHIK'));
  });
});

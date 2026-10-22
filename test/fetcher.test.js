const { describe, test } = require('node:test');
const assert = require('node:assert');
const { safeFetch, isBlockedHostname, isBlockedAddress } = require('../utils/fetcher');

describe('isBlockedHostname', () => {
  test('blocks loopback and internal hostnames', () => {
    assert.ok(isBlockedHostname('localhost'));
    assert.ok(isBlockedHostname('api.localhost'));
    assert.ok(isBlockedHostname('db.internal'));
    assert.ok(isBlockedHostname('printer.local'));
    assert.ok(isBlockedHostname('metadata.google.internal'));
  });

  test('allows public hostnames', () => {
    assert.ok(!isBlockedHostname('example.com'));
    assert.ok(!isBlockedHostname('docs.google.com'));
  });
});

describe('isBlockedAddress', () => {
  test('blocks private, loopback and link-local ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.4.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      assert.ok(isBlockedAddress(ip), `${ip} should be blocked`);
    }
  });

  test('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      assert.ok(!isBlockedAddress(ip), `${ip} should be allowed`);
    }
  });
});

describe('safeFetch', () => {
  test('refuses non-http schemes', async () => {
    const res = await safeFetch('file:///etc/passwd');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorKind, 'scheme');
  });

  test('refuses credentials in the URL', async () => {
    const res = await safeFetch('http://user:pass@example.com/');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorKind, 'credentials');
  });

  test('refuses loopback targets (SSRF guard)', async () => {
    const res = await safeFetch('http://127.0.0.1:5000/api/health');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorKind, 'blocked-ip');
  });

  test('refuses hosts that resolve to private addresses', async () => {
    const res = await safeFetch('http://localhost:5000/api/health');
    assert.strictEqual(res.ok, false);
    assert.ok(['blocked-host', 'blocked-ip'].includes(res.errorKind));
  });

  test('refuses invalid URLs', async () => {
    const res = await safeFetch('not a url');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorKind, 'invalid');
  });
});

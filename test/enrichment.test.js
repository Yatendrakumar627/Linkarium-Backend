const { describe, test } = require('node:test');
const assert = require('node:assert');
const { fetchAndExtract } = require('../utils/enrichment');

describe('Enrichment - fetchAndExtract', () => {
  test('rejects non-http schemes via SSRF protection', async () => {
    const res = await fetchAndExtract('file:///etc/passwd');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorKind, 'scheme');
    assert.strictEqual(res.og, null);
    assert.strictEqual(res.article, null);
  });

  test('rejects loopback and private IPs via SSRF protection', async () => {
    const res = await fetchAndExtract('http://127.0.0.1:8080/secret');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorKind, 'blocked-ip');
  });

  test('rejects credentials in url', async () => {
    const res = await fetchAndExtract('https://admin:secret@malicious.com');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorKind, 'credentials');
  });
});

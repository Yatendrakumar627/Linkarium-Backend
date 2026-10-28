const { describe, test } = require('node:test');
const assert = require('node:assert');
const { describeDevice } = require('../utils/device');

describe('Device description', () => {
  test('returns Unknown device for empty or null user agents', () => {
    assert.strictEqual(describeDevice(''), 'Unknown device');
    assert.strictEqual(describeDevice(null), 'Unknown device');
    assert.strictEqual(describeDevice(undefined), 'Unknown device');
  });

  test('identifies Chrome on Windows', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    assert.strictEqual(describeDevice(ua), 'Chrome on Windows');
  });

  test('identifies Edge on Windows (prioritizing Edge over Chrome)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
    assert.strictEqual(describeDevice(ua), 'Edge on Windows');
  });

  test('identifies Firefox on macOS', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/119.0';
    assert.strictEqual(describeDevice(ua), 'Firefox on macOS');
  });

  test('identifies Safari on iOS', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    assert.strictEqual(describeDevice(ua), 'Safari on iOS');
  });

  test('identifies Chrome on Android', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36';
    assert.strictEqual(describeDevice(ua), 'Chrome on Android');
  });

  test('identifies Opera on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0';
    assert.strictEqual(describeDevice(ua), 'Opera on Linux');
  });

  test('identifies developer tools and CLIs', () => {
    assert.strictEqual(describeDevice('curl/8.4.0'), 'curl on Unknown platform');
    assert.strictEqual(describeDevice('PostmanRuntime/7.36.0'), 'Postman on Unknown platform');
    assert.strictEqual(describeDevice('node-fetch/1.0 (+https://github.com/bitinn/node-fetch)'), 'Node on Unknown platform');
  });

  test('handles unknown browser but known platform', () => {
    const ua = 'CustomApp/1.0 (Windows NT 10.0)';
    assert.strictEqual(describeDevice(ua), 'Browser on Windows');
  });
});


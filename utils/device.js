// A short, human-readable description of the device a request came from.
//
// Used by the session list ("Chrome on Windows") so the user can tell their
// devices apart at a glance.

const BROWSERS = [
  { name: 'Edge', test: /Edg\//i },
  { name: 'Opera', test: /OPR\//i },
  { name: 'Brave', test: /Brave\//i },
  { name: 'Chrome', test: /Chrome\//i },
  { name: 'Firefox', test: /Firefox\//i },
  { name: 'Safari', test: /Safari\//i },
  { name: 'curl', test: /curl\//i },
  { name: 'Postman', test: /PostmanRuntime\//i },
  { name: 'Node', test: /node/i },
];

const PLATFORMS = [
  { name: 'iOS', test: /iPhone|iPad|iPod/i },
  { name: 'Android', test: /Android/i },
  { name: 'Windows', test: /Windows/i },
  { name: 'macOS', test: /Mac OS X|Macintosh/i },
  { name: 'Linux', test: /Linux/i },
];

/**
 * Turn a user agent string into "Chrome on Windows".
 *
 * @param {string} userAgent
 * @returns {string}
 */
function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Unknown device';

  const browser = BROWSERS.find((b) => b.test.test(ua));
  const platform = PLATFORMS.find((p) => p.test.test(ua));

  const browserName = browser ? browser.name : 'Browser';
  const platformName = platform ? platform.name : 'Unknown platform';
  return `${browserName} on ${platformName}`;
}

module.exports = { describeDevice };

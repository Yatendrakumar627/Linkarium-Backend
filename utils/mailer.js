// Transactional email.
//
// Uses the Resend REST API. The request goes through the SSRF guard like
// every other outbound call, so there is exactly one code path for talking to
// the network.
//
// The digest is opt-in and the API key is optional: without RESEND_API_KEY the
// mailer reports "not configured" instead of throwing, and the worker simply
// skips the run.

const { safeFetch } = require('./fetcher');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Send one email.
 *
 * @param {{to: string|string[], subject: string, html: string, text?: string, from?: string}} message
 * @returns {Promise<{ok: boolean, id: string|null, error: string|null}>}
 */
async function sendEmail(message) {
  const { to, subject, html, text = '', from } = message;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, id: null, error: 'RESEND_API_KEY is not configured.' };
  }

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) {
    return { ok: false, id: null, error: 'No recipient.' };
  }

  const fromAddress = from || process.env.DIGEST_FROM || 'Linkarium <onboarding@resend.dev>';

  const payload = {
    from: fromAddress,
    to: recipients,
    subject,
    html,
    text: text || '',
  };

  const result = await safeFetch(RESEND_ENDPOINT, {
    method: 'POST',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!result.ok) {
    return { ok: false, id: null, error: result.error || `HTTP ${result.status}` };
  }

  let id = null;
  try {
    id = JSON.parse(result.text || '{}').id || null;
  } catch {
    /* the API always returns JSON, but never let a parse error hide a success */
  }

  return { ok: true, id, error: null };
}

/** True when the mailer is configured and can actually send. */
function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

module.exports = {
  sendEmail,
  isConfigured,
  RESEND_ENDPOINT,
};

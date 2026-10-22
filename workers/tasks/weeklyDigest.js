// The weekly digest worker.
//
// Sends the weekly summary to every user who opted in. The task itself runs
// daily; each user decides on which weekday and at which hour (in their own
// timezone) the email arrives.
//
// The mailer is optional: without RESEND_API_KEY the run is skipped rather
// than failing.

const User = require('../../models/User');
const { sendEmail, isConfigured } = require('../../utils/mailer');
const { collectDigestData, renderDigest } = require('../../utils/digest');
const { safeTimeZone, dayOfWeek, hourOfDay } = require('../../utils/timezone');

const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

/**
 * Send the digest to every opted-in user whose schedule is due.
 */
async function sendDueDigests(options = {}) {
  if (!isConfigured()) {
    return { sent: 0, skipped: 0, reason: 'not-configured' };
  }

  const now = options.now ? new Date(options.now) : new Date();
  const users = await User.find({ 'preferences.digestEnabled': true })
    .select('email name preferences')
    .lean();

  let sent = 0;
  let skipped = 0;

  for (const user of users) {
    const prefs = user.preferences || {};
    const tz = safeTimeZone(prefs.timezone);

    const wantedDay = Number.isInteger(prefs.digestDay) ? prefs.digestDay : 1;
    const wantedHour = Number.isInteger(prefs.digestHour) ? prefs.digestHour : 8;

    if (dayOfWeek(now, tz) !== wantedDay) {
      skipped += 1;
      continue;
    }
    // The task runs every six hours, so the exact hour rarely matches. Accept
    // any run inside the target hour.
    if (hourOfDay(now, tz) !== wantedHour) {
      skipped += 1;
      continue;
    }

    try {
      const data = await collectDigestData(user._id, { now });
      const message = renderDigest(data);
      const result = await sendEmail({
        to: user.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      if (result.ok) sent += 1;
      else skipped += 1;
    } catch (err) {
      console.error(`[digest] could not send to ${user.email}:`, err.message);
      skipped += 1;
    }
  }

  return { sent, skipped };
}

async function run() {
  const result = await sendDueDigests();
  if (result.sent > 0) {
    console.log(`📬 Sent ${result.sent} digest(s).`);
  }
  return result;
}

module.exports = {
  name: 'weekly-digest',
  intervalMs: INTERVAL_MS,
  run,
  sendDueDigests,
};

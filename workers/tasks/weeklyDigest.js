// The weekly digest worker.
//
// Sends the weekly summary to every user who opted in. The task itself runs
// every six hours; each user decides on which weekday and at which hour (in
// their own timezone) the email arrives, and the due window stays open for a
// day so a late tick still delivers it.
//
// The mailer is optional: without RESEND_API_KEY the run is skipped rather
// than failing.

const User = require('../../models/User');
const { sendEmail, isConfigured } = require('../../utils/mailer');
const { collectDigestData, renderDigest } = require('../../utils/digest');
const {
  safeTimeZone,
  makeDateFormatter,
  startOfDayInTz,
  dayOfWeek,
} = require('../../utils/timezone');

const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// The digest window stays open for a day after the configured time, so a
// six-hour scheduler tick that lands late still delivers it.
const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Is a user's digest due on this scheduler run?
 *
 * Requiring an exact hour match meant most users never received anything: a
 * six-hourly task has to land in the same clock hour as their preference.
 * Instead, find the most recent scheduled window (day + hour in the user's
 * timezone), accept runs inside the following 24 hours, and only send once
 * per window.
 */
function isDigestDue(prefs, now) {
  const tz = safeTimeZone(prefs.timezone);

  const wantedDay = Number.isInteger(prefs.digestDay) ? prefs.digestDay : 1;
  const wantedHour = Number.isInteger(prefs.digestHour) ? prefs.digestHour : 8;

  const local = makeDateFormatter(tz)(now);
  const today = dayOfWeek(now, tz);
  const daysSinceWanted = (today - wantedDay + 7) % 7;

  const windowStart = (daysAgo) => {
    // Calendar arithmetic on the local date; startOfDayInTz resolves DST.
    const date = new Date(Date.UTC(local.y, local.m - 1, local.d - daysAgo));
    const midnight = startOfDayInTz(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      tz
    );
    return new Date(midnight.getTime() + wantedHour * 60 * 60 * 1000);
  };

  let start = windowStart(daysSinceWanted);
  if (now.getTime() < start.getTime()) {
    // Today is the chosen day but the hour has not arrived yet, so the most
    // recent window was last week's.
    start = windowStart(daysSinceWanted + 7);
  }

  const end = start.getTime() + DIGEST_WINDOW_MS;
  if (now.getTime() < start.getTime() || now.getTime() >= end) return false;

  const last = prefs.lastDigestAt ? new Date(prefs.lastDigestAt).getTime() : 0;
  return last < start.getTime();
}

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

    if (!isDigestDue(prefs, now)) {
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
      if (result.ok) {
        sent += 1;
        await User.updateOne(
          { _id: user._id },
          { $set: { 'preferences.lastDigestAt': now } }
        );
      } else {
        skipped += 1;
      }
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
  isDigestDue,
};

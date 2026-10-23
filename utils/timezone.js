// Timezone helpers shared by the analytics and insights routes.
//
// Visit charts are bucketed in the *client's* timezone, not the server's, so
// "today" means the user's today. The helpers here are deliberately extracted
// from routes/analytics.js so both routes bucket identically.

/** Validate an IANA timezone name, falling back to UTC. */
function safeTimeZone(tz) {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return String(tz);
  } catch {
    return 'UTC';
  }
}

// `Intl.DateTimeFormat` construction is expensive (tens of microseconds) and
// the analytics/insights code paths format hundreds or thousands of dates per
// request. Formatters are immutable, so cache one per timezone/locale.
const FORMATTER_CACHE_LIMIT = 96;
const formatterCache = new Map();

function cachedFormatter(key, create) {
  const hit = formatterCache.get(key);
  if (hit) return hit;
  const created = create();
  if (formatterCache.size >= FORMATTER_CACHE_LIMIT) formatterCache.clear();
  formatterCache.set(key, created);
  return created;
}

/**
 * Returns a function mapping a Date -> { y, m, d, key, utcOffsetMs } in a given
 * IANA timezone.
 */
function makeDateFormatter(tz) {
  return cachedFormatter(`parts:${tz}`, () => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    return (date) => {
      const p = fmt.formatToParts(date);
      const get = (type) => p.find((x) => x.type === type)?.value;
      const hour = get('hour') === '24' ? '00' : get('hour');
      const y = get('year');
      const m = get('month');
      const d = get('day');
      return {
        y: Number(y),
        m: Number(m),
        d: Number(d),
        key: `${y}-${m}-${d}`,
        utcOffsetMs:
          Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hour), Number(get('minute')), Number(get('second'))) -
          date.getTime(),
      };
    };
  });
}

/** The UTC instant of midnight at the start of the given calendar day in `tz`. */
function startOfDayInTz(y, m, d, tz) {
  const fmt = makeDateFormatter(tz);
  let instant = Date.UTC(y, m - 1, d);
  // Iterate: the offset at the guessed instant may itself shift the day
  // boundary (DST), so re-resolve a couple of times until it stabilises.
  for (let i = 0; i < 4; i++) {
    instant = Date.UTC(y, m - 1, d) - fmt(new Date(instant)).utcOffsetMs;
  }
  return new Date(instant);
}

/** Human label for a day ("Oct 21") in the given timezone. */
function formatDayLabel(date, tz) {
  const fmt = cachedFormatter(`label:${tz}`, () =>
    new Intl.DateTimeFormat(undefined, { timeZone: tz, month: 'short', day: 'numeric' })
  );
  return fmt.format(date);
}

/** "2026-10-21" for a Date in the given timezone. */
function dayKey(date, tz) {
  return makeDateFormatter(tz)(date).key;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The day of the week (0 = Sunday .. 6 = Saturday) in the given timezone.
 */
function dayOfWeek(date, tz) {
  const fmt = cachedFormatter(`weekday:${tz}`, () =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
  );
  const name = fmt.format(date);
  return WEEKDAY_NAMES.indexOf(name);
}

/** The hour of the day (0-23) in the given timezone. */
function hourOfDay(date, tz) {
  const fmt = cachedFormatter(`hour:${tz}`, () =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false })
  );
  const hour = fmt.formatToParts(date).find((p) => p.type === 'hour')?.value;
  return Number(hour === '24' ? '00' : hour);
}

module.exports = {
  safeTimeZone,
  makeDateFormatter,
  startOfDayInTz,
  formatDayLabel,
  dayKey,
  dayOfWeek,
  hourOfDay,
};

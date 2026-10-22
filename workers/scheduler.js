// Background job scheduler.
//
// Every background task in Linkarium (trash cleanup, link health checks,
// enrichment, the weekly digest) runs through this scheduler so that:
//
//   1. it is safe to run with more than one server instance — a task is
//      guarded by a Mongo-backed lease, so exactly one instance runs it;
//   2. it survives a restart — the next-run time is stored in the database,
//      not in process memory;
//   3. it can be triggered on demand — the Render free tier sleeps idle
//      instances, so an external cron ping (POST /api/internal/cron) can wake
//      the app and run whatever is due.
//
// The lease doubles as the schedule: a Lock document holds `expiresAt`, which
// is the moment the task becomes due again. A task that is not yet due has a
// future `expiresAt` and is skipped.

const os = require('os');
const crypto = require('crypto');
const Lock = require('../models/Lock');

const TASKS = new Map();

// How often the scheduler looks for work. A minute is fine: the lease keeps
// the actual work to once per interval.
const TICK_MS = 60 * 1000;

// Default lease length. Must comfortably exceed the task's runtime, or a
// second instance could start the same task while the first is still running.
const DEFAULT_LEASE_MS = 15 * 60 * 1000;

// When a task fails, wait this long before trying again.
const DEFAULT_RETRY_MS = 5 * 60 * 1000;

let ticker = null;

/**
 * Register a background task.
 *
 * @param {string} name unique task name (used as the lock id)
 * @param {{intervalMs: number, run: () => any, leaseMs?: number,
 *          retryMs?: number, enabled?: () => boolean}} options
 */
function registerTask(name, options) {
  if (!name || typeof options?.run !== 'function') {
    throw new Error(`Invalid task registration: ${name}`);
  }
  TASKS.set(name, {
    name,
    intervalMs: options.intervalMs,
    run: options.run,
    leaseMs: options.leaseMs || DEFAULT_LEASE_MS,
    retryMs: options.retryMs || DEFAULT_RETRY_MS,
    enabled: options.enabled || (() => true),
  });
}

/** All registered task names. */
function taskNames() {
  return Array.from(TASKS.keys());
}

/** True when the task is due (no lock, or the lock has expired). */
async function isDue(name) {
  const doc = await Lock.findById(name).lean();
  if (!doc) return true;
  if (!doc.expiresAt) return true;
  return new Date(doc.expiresAt).getTime() <= Date.now();
}

/**
 * Take the lease for a task.
 *
 * @returns {Promise<{holder: string}|null>} null when another instance holds it
 */
async function acquireLease(name, leaseMs) {
  const holder = `${os.hostname()}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);

  // The lock already exists and its lease has expired: steal it. The update
  // is atomic, so only one instance wins the race.
  const stolen = await Lock.findOneAndUpdate(
    { _id: name, expiresAt: { $lte: now } },
    { $set: { holder, expiresAt } },
    { returnDocument: 'after' }
  );
  if (stolen) return { holder };

  // No lock document yet — try to create it.
  try {
    await Lock.create({ _id: name, holder, expiresAt });
    return { holder };
  } catch (err) {
    if (err?.code === 11000) return null; // another instance got there first
    throw err;
  }
}

/**
 * Release the lease and schedule the next run.
 *
 * @param {string} name
 * @param {string} holder the lease holder id (guards against releasing a
 *   lease that another instance has since stolen)
 * @param {number} nextDelayMs delay until the task is due again
 */
async function releaseLease(name, holder, nextDelayMs) {
  await Lock.updateOne(
    { _id: name, holder },
    { $set: { holder: null, expiresAt: new Date(Date.now() + nextDelayMs) } }
  );
}

/**
 * Run a single task if it is due.
 *
 * @param {string} name
 * @param {{force?: boolean}} options `force` ignores the schedule
 * @returns {Promise<{name: string, ran: boolean, reason?: string}>}
 */
async function runTask(name, options = {}) {
  const { force = false } = options;
  const task = TASKS.get(name);
  if (!task) return { name, ran: false, reason: 'unknown-task' };

  if (!force && !task.enabled()) {
    return { name, ran: false, reason: 'disabled' };
  }

  if (!force && !(await isDue(name))) {
    return { name, ran: false, reason: 'not-due' };
  }

  const lease = await acquireLease(name, task.leaseMs);
  if (!lease) return { name, ran: false, reason: 'locked' };

  const startedAt = Date.now();
  try {
    const detail = await task.run();
    await releaseLease(name, lease.holder, task.intervalMs);
    console.log(`[scheduler] "${name}" finished in ${Date.now() - startedAt}ms`);
    return { name, ran: true, durationMs: Date.now() - startedAt, detail };
  } catch (err) {
    // Leave the task due again shortly so a transient failure (e.g. the
    // database was briefly unreachable) does not cost a whole interval.
    await releaseLease(name, lease.holder, task.retryMs).catch(() => {});
    console.error(`[scheduler] "${name}" failed:`, err.message);
    return { name, ran: false, reason: 'error', error: err.message };
  }
}

/**
 * Run every task that is due.
 *
 * @param {{only?: string[], force?: boolean}} options
 */
async function runDueTasks(options = {}) {
  const { only = null, force = false } = options;
  const results = [];

  for (const name of TASKS.keys()) {
    if (only && !only.includes(name)) continue;
    try {
      results.push(await runTask(name, { force }));
    } catch (err) {
      console.error(`[scheduler] "${name}" could not be started:`, err.message);
      results.push({ name, ran: false, reason: 'error', error: err.message });
    }
  }

  return results;
}

/**
 * Start the in-process scheduler.
 *
 * The scheduler is best-effort: if the Render instance is asleep, an external
 * cron ping (POST /api/internal/cron) will run the same tasks on wake-up.
 */
function startScheduler() {
  if (ticker) return ticker;

  ticker = setInterval(() => {
    runDueTasks().catch((err) => {
      console.error('[scheduler] tick failed:', err.message);
    });
  }, TICK_MS);

  // Node keeps the process alive for a timer; `unref` lets the process exit
  // cleanly during tests and shutdown.
  if (typeof ticker.unref === 'function') ticker.unref();

  console.log(`[scheduler] started (${taskNames().length} task(s): ${taskNames().join(', ')})`);
  return ticker;
}

/** Stop the in-process scheduler. */
function stopScheduler() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

module.exports = {
  registerTask,
  taskNames,
  runTask,
  runDueTasks,
  startScheduler,
  stopScheduler,
  isDue,
};

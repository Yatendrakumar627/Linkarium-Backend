// Registers every background task with the scheduler.
//
// Tasks are imported here (rather than inside the scheduler) so that a task
// module can be required directly by a test without starting the scheduler.

const { registerTask } = require('./scheduler');

const cleanupTrash = require('./tasks/cleanupTrash');
const linkHealth = require('./tasks/linkHealth');
const enrichLinks = require('./tasks/enrichLinks');
const weeklyDigest = require('./tasks/weeklyDigest');

const tasks = [cleanupTrash, linkHealth, enrichLinks, weeklyDigest];

for (const task of tasks) {
  registerTask(task.name, {
    intervalMs: task.intervalMs,
    leaseMs: task.leaseMs,
    retryMs: task.retryMs,
    enabled: task.enabled,
    run: task.run,
  });
}

module.exports = { tasks };

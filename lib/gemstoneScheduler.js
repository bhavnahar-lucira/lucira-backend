/**
 * Gemstone filters — global sync + optional daily/weekly schedule, on the
 * shared lib/filterScheduler.js with its own run collection and settings key.
 *
 * 05:15 IST by default: a quarter-hour after the diamond sync, so the two
 * never compete for the Shopify budget.
 */

const { createFilterScheduler } = require('./filterScheduler');
const engine = require('./gemstone');

const scheduler = createFilterScheduler({
  engine,
  runs: 'gemstone_runs',
  scheduleKey: 'gemstone_schedule',
  defaultTime: '05:15',
  tag: 'Gemstone',
});

module.exports = {
  ...scheduler,
  startGemstoneScheduler: scheduler.start,
  stopGemstoneScheduler: scheduler.stop,
};

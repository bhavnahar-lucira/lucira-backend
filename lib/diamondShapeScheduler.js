/**
 * Diamond filters — global sync + optional daily/weekly schedule. The job,
 * run lock and timer are the shared lib/filterScheduler.js; this only names
 * the diamond page's run collection and settings key.
 *
 * 05:00 IST by default: after the 02:30 smart-sort pass (~40 min) and the reco
 * rules, so it never queues behind them in the governor's background lane.
 */

const { createFilterScheduler } = require('./filterScheduler');
const engine = require('./diamondShape');

const scheduler = createFilterScheduler({
  engine,
  runs: 'diamond_shape_runs',
  scheduleKey: 'diamond_shape_schedule',
  defaultTime: '05:00',
  tag: 'DiamondShape',
});

module.exports = {
  ...scheduler,
  startDiamondShapeScheduler: scheduler.start,
  stopDiamondShapeScheduler: scheduler.stop,
};

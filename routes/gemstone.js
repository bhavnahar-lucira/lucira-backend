/**
 * Gemstone filter routes — /api/gemstone (colour, shape, pieces, weight).
 * Endpoints are listed in routes/componentFilterRoutes.js; the rules are in
 * lib/gemstone.js.
 */

const createFilterRoutes = require('./componentFilterRoutes');

module.exports = createFilterRoutes(require('../lib/gemstone'), require('../lib/gemstoneScheduler'));

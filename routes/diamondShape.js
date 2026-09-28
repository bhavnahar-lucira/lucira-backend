/**
 * Diamond filter routes — /api/diamond-shape (shape, carat, pieces, weight).
 * Endpoints are listed in routes/componentFilterRoutes.js; the rules are in
 * lib/diamondShape.js.
 */

const createFilterRoutes = require('./componentFilterRoutes');

module.exports = createFilterRoutes(require('../lib/diamondShape'), require('../lib/diamondShapeScheduler'));

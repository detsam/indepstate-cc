const chartImages = require('./comps');

/**
 * @param {import('../servicesApi').ServicesApi} servicesApi
 */
function initService(servicesApi = {}) {
  servicesApi.dealTrackersChartImages = chartImages;
}

module.exports = { initService };

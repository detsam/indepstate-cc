/**
 * @typedef {Object} BrokerageApi
 * @property {(name: string) => any} getAdapter
 * @property {(name: string) => any} getProviderConfig
 */

/**
 * @typedef {Object} ServicesApi
 * @property {BrokerageApi} [brokerage]
 */

module.exports = {};

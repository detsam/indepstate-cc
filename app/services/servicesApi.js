/**
 * @typedef {Object} BrokerageApi
 * @property {(name: string) => any} getAdapter
 * @property {(name: string) => any} getProviderConfig
 */

/**
 * @typedef {Object} DealTrackersApi
 * @property {(info: any, opts?: any) => void} notifyPositionClosed
 * @property {(info: any, opts?: any) => boolean} shouldWritePositionClosed
 * @property {(data: any) => any} calcDealData
 */

/**
 * @typedef {Object} ServicesApi
 * @property {BrokerageApi} [brokerage]
 * @property {DealTrackersApi} [dealTrackers]
 */

module.exports = {};

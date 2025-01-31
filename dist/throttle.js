// @ts-check
import './types.js';

/**
 * @typedef {import('./types.js').GenericLogger} GenericLogger
 */

/**
   * Logs or throttles messages based on the environment.
   * @param {string} message - The message to log or throttle.
   * @param {Function} throttleFn - Throttle function.
   * @param {GenericLogger} logger - Any logger implementing the basic logging methods
   * @param {boolean} [isError=false] - True if the message is an error.
   * @returns {void}
   */
export const logOrThrottle = (message, throttleFn, logger, isError = false) => {
  try {
    if (process.env.NODE_ENV !== 'development') {
      throttleFn(message);
    } else {
      logger[isError ? 'warn' : 'info'](message);
    }
  } catch (error) {
    logger.error("Error in logOrThrottle:", error);
  }
};
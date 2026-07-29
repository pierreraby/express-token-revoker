import type { GenericLogger } from './types.js';

/**
 * Logs or throttles messages based on the environment.
 * @param message - The message to log or throttle.
 * @param throttleFn - Throttle function.
 * @param logger - Any logger implementing the basic logging methods
 * @param isError - True if the message is an error.
 */
export const logOrThrottle = (
  message: string,
  throttleFn: (message: string) => void,
  logger: GenericLogger,
  isError = false
): void => {
  try {
    if (process.env.NODE_ENV !== 'development') {
      throttleFn(message);
    } else {
      logger[isError ? 'warn' : 'info'](message);
    }
  } catch (error) {
    logger.error('Error in logOrThrottle:', error);
  }
};

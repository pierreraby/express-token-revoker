import pino from 'pino';

const env = process.env.NODE_ENV || 'development';

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    env === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
          },
        }, // in production, use the default JSON format
});

// Config validation expects exactly the GenericLogger contract
// ({ info, warn, error, debug }) — expose only those four methods.
const logger = {
  info: (...args) => pinoLogger.info(...args),
  warn: (...args) => pinoLogger.warn(...args),
  error: (...args) => pinoLogger.error(...args),
  debug: (...args) => pinoLogger.debug(...args),
};

export default logger;

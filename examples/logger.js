import pino from 'pino';

const env = process.env.NODE_ENV || 'development';
process.env.LOG_LEVEL = 'debug';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: env !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
    },
  } : undefined, // En production, utiliser le format JSON par défaut
});

export default logger;
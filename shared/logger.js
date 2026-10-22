import pino from 'pino';
import { settings } from './settings.js';

const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || 'info',
  name: settings.app.name,
  customLevels: { success: 35 },
  formatters: {
    level(label, number) {
      const displayLevel = label === 'error' ? 'ERR' : label.toUpperCase();
      return { level: displayLevel, levelNumber: number };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'message',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.apikey',
    ],
    censor: '[REDACTED]',
  },
  base: {
    environment: settings.app.environment,
  },
});

export default logger;

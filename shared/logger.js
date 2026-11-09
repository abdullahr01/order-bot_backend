import { createRequire } from 'node:module';
import pino from 'pino';
import { settings } from './settings.js';
import { safeError, safeRequest, safeResponse } from './log-safety.js';

const require = createRequire(import.meta.url);
const sensitiveKeys = [
  'authorization', 'cookie', 'apikey', 'password', 'pin', 'pinHash',
  'token', 'accessToken', 'refreshToken', 'deviceToken', 'staffToken',
  'secretKey', 'publishableKey', 'dataUrl', 'body', 'query', 'payload',
  'email', 'phone', 'ownerEmail', 'ownerPhone',
  'databaseUrl', 'connectionString', 'DATABASE_URL',
];

export function createLogger({
  environment = settings.app.environment,
  level = process.env.LOG_LEVEL?.trim() || 'info',
  destination = process.stdout,
  colorize = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined,
} = {}) {
  let output = destination;
  // Production never loads the optional development dependency.
  if (environment === 'development') {
    const pretty = require('pino-pretty');
    output = pretty({
      destination,
      sync: true,
      colorize,
      colorizeObjects: false,
      messageKey: 'message',
      levelFirst: true,
      singleLine: true,
      translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l o',
      customLevels: 'success:35',
      useOnlyCustomProps: false,
      ignore: 'pid,hostname,name,environment,levelLabel,module,operation,requestId',
      customPrettifiers: {
        level(value, _key, _log, { label: levelLabel, colors }) {
          // pino-pretty removes ignored keys before formatting the level.
          const label = `[${value === 50 ? 'ERR' : levelLabel.toUpperCase()}]`;
          if (value === 30) return colors.white(label);
          if (value === 35) return colors.greenBright(label);
          if (value >= 50) return colors.redBright(label);
          if (value === 40) return colors.yellow(label);
          return label;
        },
      },
      messageFormat(log, key) {
        const scope = log.module ? `[${log.module}${log.operation ? `.${log.operation}` : ''}] ` : '';
        const request = log.requestId ? `[req:${log.requestId}] ` : '';
        return `${scope}${request}${log[key]}`;
      },
    });
  }
  return pino({
    level,
    customLevels: { success: 35 },
    formatters: {
      level(label, number) {
        return { level: number, levelLabel: label === 'error' ? 'ERR' : label.toUpperCase() };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    serializers: { err: safeError, error: safeError, req: safeRequest, res: safeResponse },
    redact: {
      paths: [
        ...sensitiveKeys.flatMap((key) => [key, `*.${key}`]),
        'req.headers.authorization', 'req.headers.cookie', 'req.headers.apikey',
        'req.headers["x-counter-device"]', 'res.headers["set-cookie"]',
      ],
      censor: '[REDACTED]',
    },
    base: { name: settings.app.name, environment },
  }, output);
}

export default createLogger();

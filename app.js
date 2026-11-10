import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import logger from './shared/logger.js';
import { settings } from './shared/settings.js';
import { createRequestLogger } from './middleware/request-logger.js';
import { errorHandler, notFound } from './middleware/error-handler.js';

// Optional router composition supports isolated features/tests without starting
// the server or contacting Supabase. The default app has no test-only routes.
export function createApp({ appLogger = logger, router } = {}) {
  const app = express();

  app.disable('x-powered-by');
  // Rate limits need the real caller's IP when the API sits behind a hosting proxy.
  app.set('trust proxy', settings.app.trustProxyHops);
  app.use(createRequestLogger(appLogger));
  app.use(helmet());
  app.use(cors({
    origin: settings.corsOrigins.length ? settings.corsOrigins : false,
    exposedHeaders: ['X-Request-Id'],
  }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (request, response) => {
    request.log.info({ module: 'Health', operation: 'respond' }, 'Preparing health response');
    response.status(200).json({
      status: 'ok',
      service: settings.app.name,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  if (router) app.use(router);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

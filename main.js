import app from './app.js';
import { checkSupabaseConnection } from './db/supabase.js';
import logger from './shared/logger.js';
import { settings } from './shared/settings.js';

let server;

async function start() {
  logger.info('Starting backend service');
  logger.info('Checking Supabase Data API connectivity');

  await checkSupabaseConnection();
  logger.success('Supabase Data API is reachable');

  server = app.listen(settings.app.port, () => {
    logger.success(
      { port: settings.app.port, environment: settings.app.environment },
      'Backend server is listening',
    );
  });
}

function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');

  if (!server) {
    process.exit(0);
  }

  server.close(() => {
    logger.success('HTTP server closed cleanly');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
  logger.error({ err: error }, 'Backend startup failed');
  process.exit(1);
});

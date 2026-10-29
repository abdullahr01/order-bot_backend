import app from './app.js';
import { checkSupabaseConnection } from './db/supabase.js';
import baseLogger from './shared/logger.js';
import { settings } from './shared/settings.js';

let server;
const logger = baseLogger.child({ module: 'Server' });
let shuttingDown = false;

async function start() {
  logger.info({ operation: 'start' }, 'Starting backend service');
  logger.info({ operation: 'supabaseProbe' }, 'Checking Supabase Data API connectivity');

  const probeStarted = performance.now();
  await checkSupabaseConnection();
  logger.success({ operation: 'supabaseProbe', durationMs: Math.round(performance.now() - probeStarted) }, 'Supabase Data API is reachable');

  await new Promise((resolve, reject) => {
    server = app.listen(settings.app.port);
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      server.on('error', (error) => {
        logger.error({ operation: 'listen', err: error }, 'HTTP server failure');
        process.exitCode = 1;
        shutdown('server_error');
      });
      resolve();
    });
  });
  logger.success({ operation: 'listen', port: settings.app.port }, 'Backend server is listening');
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ operation: 'shutdown', signal }, 'Shutdown signal received');

  if (!server) {
    process.exitCode ??= 0;
    return;
  }

  server.close((error) => {
    if (error) {
      logger.error({ operation: 'shutdown', err: error }, 'HTTP server could not close cleanly');
      process.exitCode = 1;
      return;
    }
    logger.success({ operation: 'shutdown' }, 'HTTP server closed cleanly');
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
  logger.error({ operation: 'start', err: error }, 'Backend startup failed');
  process.exitCode = 1;
});

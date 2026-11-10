import baseLogger from './shared/logger.js';
import { settings } from './shared/settings.js';

const logger = baseLogger.child({ module: 'Server' });

/** Checks the database, then listens. Never reports ready before the listener really is. */
export async function startServer({ app, probe, close = async () => {} }) {
  let server;
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ operation: 'shutdown', signal }, 'Shutdown signal received');

    if (!server) {
      process.exitCode ??= 0;
      return;
    }

    server.close(async (error) => {
      try {
        await close();
      } catch (closeError) {
        logger.error({ operation: 'shutdown', err: closeError }, 'Database connections could not close cleanly');
        process.exitCode = 1;
      }
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

  try {
    logger.info({ operation: 'start' }, 'Starting backend service');
    logger.info({ operation: 'databaseProbe' }, 'Checking database connectivity');
    const probeStarted = performance.now();
    await probe();
    logger.success({ operation: 'databaseProbe', durationMs: Math.round(performance.now() - probeStarted) }, 'Database is reachable');

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
  } catch (error) {
    logger.error({ operation: 'start', err: error }, 'Backend startup failed');
    process.exitCode = 1;
    await close().catch(() => {});
  }
}

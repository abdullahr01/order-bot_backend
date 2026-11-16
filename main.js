import { createApp } from './app.js';
import { Database } from './db/database.js';
import { createApiRouter } from './router/index.js';
import { startServer } from './server.js';
import { JobScheduler } from './service/job-scheduler.js';
import { createServices } from './service/index.js';
import logger from './shared/logger.js';
import { settings } from './shared/settings.js';

const database = new Database();
const services = createServices({ database });
// Daily jobs: on by default in production only (JOBS_ENABLED).
const scheduler = settings.jobsEnabled ? new JobScheduler({ jobs: services.jobs, logger }) : null;
if (!scheduler) logger.info({ module: 'JobScheduler', operation: 'start' }, 'Daily jobs are off here (JOBS_ENABLED); run them by hand with npm run jobs:run');

await startServer({
  app: createApp({ router: createApiRouter(services) }),
  probe: () => database.ping(),
  attach: (server) => services.live.lines.attach(server),
  onListening: () => scheduler?.start(),
  beforeClose: async () => {
    await scheduler?.stop();
    await services.live.lines.close();
  },
  close: () => database.close(),
});

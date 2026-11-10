import { createApp } from './app.js';
import { Database } from './db/database.js';
import { createApiRouter } from './router/index.js';
import { startServer } from './server.js';
import { createServices } from './service/index.js';

const database = new Database();
const services = createServices({ database });

await startServer({
  app: createApp({ router: createApiRouter(services) }),
  probe: () => database.ping(),
  close: () => database.close(),
});

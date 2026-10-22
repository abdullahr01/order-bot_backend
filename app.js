import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import logger from './shared/logger.js';
import { settings } from './shared/settings.js';

const app = express();

app.disable('x-powered-by');
app.use(pinoHttp({ logger }));
app.use(helmet());
app.use(cors({ origin: settings.corsOrigins.length ? settings.corsOrigins : false }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.status(200).json({
    status: 'ok',
    service: settings.app.name,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use((request, response) => {
  response.status(404).json({
    error: 'Not Found',
    path: request.path,
  });
});

app.use((error, request, response, _next) => {
  request.log.error({ err: error }, 'Unhandled request error');
  response.status(500).json({ error: 'Internal Server Error' });
});

export default app;

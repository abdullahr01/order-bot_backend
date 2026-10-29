import { Writable } from 'node:stream';
import { once } from 'node:events';
import { createLogger } from '../shared/logger.js';
import { createApp } from '../app.js';

export function captureLogger(options = {}) {
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
  });
  const logger = createLogger({ environment: 'test', destination, ...options });
  return {
    logger,
    text: () => output,
    records: () => output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

export async function serve(t, router) {
  const captured = captureLogger();
  const server = createApp({ appLogger: captured.logger, router }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...captured,
    async request(path, options) {
      const response = await fetch(`${base}${path}`, options);
      const body = await response.text();
      return { status: response.status, headers: response.headers, body, json: () => JSON.parse(body) };
    },
  };
}

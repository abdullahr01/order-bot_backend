// Subprocess harness only: no hosted request and no production debug endpoint.
import '../setup.js';
import { Module } from 'node:module';

process.env.PORT = process.env.TEST_LISTEN_PORT;
process.env.NODE_ENV = 'production';
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'pino-pretty') throw new Error('Production must not load pino-pretty');
  return load.call(this, name, ...args);
};
process.on('message', () => {
  process.emit('SIGTERM');
  process.disconnect();
});
process.channel.unref();
const { createApp } = await import('../../app.js');
const { startServer } = await import('../../server.js');
await startServer({
  app: createApp(),
  async probe() {
    if (process.env.TEST_PROBE_FAILURE === 'true') {
      throw new TypeError('probe-secret-sentinel', { cause: { code: 'ENOTFOUND' } });
    }
  },
});

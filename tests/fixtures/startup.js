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
globalThis.fetch = async () => {
  if (process.env.TEST_PROBE_FAILURE === 'true') {
    throw new TypeError('probe-secret-sentinel', { cause: { code: 'ENOTFOUND' } });
  }
  return { ok: true };
};
process.on('message', () => {
  process.emit('SIGTERM');
  process.disconnect();
});
process.channel.unref();
await import('../../main.js');

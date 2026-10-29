import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function reservePort(t) {
  const server = createServer().listen(0);
  await once(server, 'listening');
  t.after(() => { if (server.listening) server.close(); });
  return server;
}

async function startup(t, env) {
  const child = spawn(process.execPath, ['tests/fixtures/startup.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let stderr = '';
  let shutdownSent = false;
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (!shutdownSent && output.includes('Backend server is listening') && child.connected) {
      shutdownSent = true;
      child.send('shutdown');
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(stderr, '');
  assert.doesNotMatch(output, /probe-secret-sentinel/);
  return { code, records: output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

test('startup fails safely when the read-only connectivity probe fails', { timeout: 10000 }, async (t) => {
  const result = await startup(t, { TEST_LISTEN_PORT: '4000', TEST_PROBE_FAILURE: 'true' });
  assert.equal(result.code, 1);
  assert.ok(!result.records.some((record) => record.operation === 'listen'));
  assert.equal(result.records.at(-1).message, 'Backend startup failed');
  assert.equal(result.records.at(-1).err.causeCode, 'ENOTFOUND');
});

test('occupied port fails without falsely reporting readiness', { timeout: 10000 }, async (t) => {
  const server = await reservePort(t);
  const result = await startup(t, { TEST_LISTEN_PORT: String(server.address().port), TEST_PROBE_FAILURE: 'false' });
  assert.equal(result.code, 1);
  assert.ok(!result.records.some((record) => record.message === 'Backend server is listening'));
  assert.equal(result.records.at(-1).err.code, 'EADDRINUSE');
});

test('production starts without the dev formatter and shuts down cleanly', { timeout: 10000 }, async (t) => {
  const server = await reservePort(t);
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const result = await startup(t, { TEST_LISTEN_PORT: String(port), TEST_PROBE_FAILURE: 'false' });
  assert.equal(result.code, 0);
  assert.equal(result.records.filter((record) => record.message === 'Backend server is listening').length, 1);
  assert.equal(result.records.at(-1).message, 'HTTP server closed cleanly');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ApiError } from '../shared/api-error.js';
import { errorHandler } from '../middleware/error-handler.js';
import { serve } from './helpers.js';

test('health retains its contract and security headers', async (t) => {
  const app = await serve(t);
  const response = await app.request('/health');
  assert.equal(response.status, 200);
  assert.equal(response.json().status, 'ok');
  assert.equal(response.json().service, 'orderbot-backend');
  assert.ok(Number.isFinite(Date.parse(response.json().timestamp)));
  assert.ok(response.json().uptimeSeconds >= 0);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('content-security-policy'));
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('unknown routes return safe contract errors without reflecting a path', async (t) => {
  const app = await serve(t);
  const response = await app.request('/secret-in-path?token=secret-in-query');
  assert.equal(response.status, 404);
  assert.deepEqual(response.json(), { code: 'not_found', message: 'The requested resource was not found.' });
  assert.doesNotMatch(app.text(), /secret-in-path|secret-in-query/);
});

test('JSON parser errors retain client statuses and never expose parser input', async (t) => {
  const app = await serve(t);
  for (const [body, contentType, status] of [
    ['{"secret":"parser-sentinel",', 'application/json', 400],
    [JSON.stringify({ value: 'x'.repeat(1024 * 1024) }), 'application/json', 413],
    ['{}', 'application/json; charset=iso-8859-1', 415],
  ]) {
    const response = await app.request('/health', { method: 'POST', headers: { 'content-type': contentType }, body });
    assert.equal(response.status, status);
    assert.equal(response.json().code, 'bad_request');
    assert.doesNotMatch(response.body + app.text(), /parser-sentinel/);
  }
});

test('unexpected errors are generic; intentional errors preserve safe field messages', async (t) => {
  const router = express.Router();
  router.get('/failure', () => { throw new Error('private-SQL-and-credential-sentinel'); });
  router.get('/invalid', () => { throw new ApiError(422, 'validation_error', 'Check the input.', { name: 'Required.' }); });
  const app = await serve(t, router);
  const failure = await app.request('/failure');
  assert.equal(failure.status, 500);
  assert.deepEqual(failure.json(), { code: 'server_error', message: 'Something went wrong. Please try again.' });
  assert.doesNotMatch(failure.body + app.text(), /private-SQL-and-credential-sentinel|\bat .*\.js:/);
  const invalid = await app.request('/invalid');
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.json(), { code: 'validation_error', message: 'Check the input.', fields: { name: 'Required.' } });
  const defaultApp = await serve(t);
  assert.equal((await defaultApp.request('/failure')).status, 404);
});

test('all allowed origins can read request IDs; other origins receive no permission', async (t) => {
  const app = await serve(t);
  for (const port of [3000, 3001, 3002, 3003]) {
    const origin = `http://localhost:${port}`;
    const response = await app.request('/health', { headers: { origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.match(response.headers.get('access-control-expose-headers'), /X-Request-Id/i);
    assert.match(response.headers.get('vary'), /Origin/);
    const preflight = await app.request('/health', { method: 'OPTIONS', headers: {
      origin, 'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-counter-device',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.match(preflight.headers.get('access-control-allow-headers'), /x-counter-device/);
  }
  for (const origin of ['https://unlisted.invalid', 'http://127.0.0.1:3000']) {
    assert.equal((await app.request('/health', { headers: { origin } })).headers.get('access-control-allow-origin'), null);
  }
});

test('request IDs correlate arrival, health/error and completion without trusting caller IDs', async (t) => {
  const app = await serve(t);
  const first = await app.request('/health', { headers: { 'x-request-id': 'caller-controlled' } });
  const second = await app.request('/missing');
  const firstId = first.headers.get('x-request-id');
  const secondId = second.headers.get('x-request-id');
  assert.match(firstId, /^[a-f0-9-]{36}$/);
  assert.notEqual(firstId, secondId);
  assert.doesNotMatch(app.text(), /caller-controlled/);
  for (const [id, status, module] of [[firstId, 200, 'Health'], [secondId, 404, 'ErrorHandler']]) {
    const records = app.records().filter((record) => record.requestId === id);
    assert.equal(records.filter((record) => record.operation === 'receive').length, 1);
    assert.equal(records.filter((record) => record.module === module).length, 1);
    const completed = records.filter((record) => record.operation === 'complete');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].res.statusCode, status);
    assert.equal(completed[0].levelLabel, status === 200 ? 'SUCCESS' : 'ERR');
    assert.ok(completed[0].durationMs >= 0);
  }
});

test('HTTP logs omit credentials, query values, table tokens and malformed bodies', async (t) => {
  const app = await serve(t);
  const sentinels = ['auth-sentinel', 'cookie-sentinel', 'api-sentinel', 'device-sentinel', 'table-sentinel', 'query-sentinel', 'body-sentinel'];
  const response = await app.request('/public/tables/table-sentinel/orders?pin=query-sentinel', {
    method: 'POST', headers: {
      authorization: 'Bearer auth-sentinel', cookie: 'session=cookie-sentinel', apikey: 'api-sentinel',
      'x-counter-device': 'device-sentinel', 'content-type': 'application/json',
    }, body: '{"pin":"body-sentinel",',
  });
  for (const sentinel of sentinels) assert.ok(!(app.text() + response.body).includes(sentinel), sentinel);
  assert.match(app.text(), /\/public\/tables\/:token\/orders/);
});

test('error middleware delegates after headers have been sent', () => {
  const error = new Error('already streaming');
  let forwarded;
  errorHandler(error, {}, { headersSent: true }, (value) => { forwarded = value; });
  assert.equal(forwarded, error);
});

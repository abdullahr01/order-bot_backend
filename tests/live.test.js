import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { CLOSE, LiveController } from '../controller/live.controller.js';
import { LiveHub, NO_LIVE } from '../service/live.service.js';
import { apiError } from '../shared/error-codes.js';
import { captureLogger } from './helpers.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const B1 = 'b1111111-1111-4111-8111-111111111111';
const B2 = 'b2222222-2222-4222-8222-222222222222';
const B9 = 'b9999999-9999-4999-8999-999999999999';
const TABLE = 'ta111111-1111-4111-8111-111111111111'.replace('ta', 'aa');

const jwt = (payload) => ['{"alg":"none"}', JSON.stringify(payload), 'sig'].map((part, index) => (index < 2 ? Buffer.from(part).toString('base64url') : part)).join('.');

/** Stand-ins for the real sign-in checks, which the database tests use. */
const auth = {
  async authenticateDevice(headers) {
    if (headers['x-counter-device'] === 'device-a') return { tenantId: T1, branchId: B1, deviceId: 'd1' };
    if (headers['x-counter-device'] === 'device-z') return { tenantId: T2, branchId: B9, deviceId: 'd9' };
    throw apiError('device_revoked', 'This counter is no longer paired.');
  },
  async authenticatePortal(headers) {
    const token = headers.authorization.slice('Bearer '.length);
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString() || '{}');
    if (payload.sub === 'owner-1') return { tenantId: T1, branchId: null, userId: 'owner-1' };
    if (payload.sub === 'staff-1') return { tenantId: T1, branchId: B2, userId: 'staff-1' };
    throw apiError('unauthorized', 'Please sign in to continue.');
  },
};
const tables = { async tableByToken(token) { return token === 'table-a' ? { id: TABLE, tenant_id: T1, branch_id: B1 } : null; } };
const branches = { async visibleBranches(_tenantId, branchId) { return branchId ? [{ id: branchId }] : [{ id: B1 }, { id: B2 }]; } };

async function start(t, options = {}) {
  const capture = captureLogger();
  const hub = new LiveHub();
  const lines = new LiveController({ hub, auth, tables, branches, logger: capture.logger, origins: ['http://localhost:3003'], ...options });
  const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  lines.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await lines.close();
    await new Promise((resolve) => server.close(resolve));
  });

  /** Opens a line, sends a hello, and collects what arrives. */
  async function open(hello, { path = '/live', headers = {} } = {}) {
    const ws = new WebSocket(`${url}${path}`, { headers });
    const messages = [];
    const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    const failed = new Promise((resolve) => ws.on('unexpected-response', (_request, response) => resolve(response.statusCode)));
    ws.on('error', () => {});
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    const opened = await Promise.race([once(ws, 'open').then(() => true), failed]);
    if (opened !== true) return { status: opened };
    if (hello !== undefined) ws.send(typeof hello === 'string' ? hello : JSON.stringify(hello));
    const next = async (type) => {
      for (let tries = 0; tries < 100; tries += 1) {
        const found = messages.find((message) => message.type === type && !message.seen);
        if (found) { found.seen = true; return found; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`No ${type} message arrived`);
    };
    return { ws, messages, closed, next };
  }
  return { hub, lines, open, capture };
}

test('a counter and a diner hear their own news, numbered; another restaurant hears nothing', async (t) => {
  const { hub, open } = await start(t);
  const counter = await open({ type: 'hello', app: 'counter', deviceToken: 'device-a' });
  const diner = await open({ type: 'hello', app: 'diner', tableToken: 'table-a' });
  const other = await open({ type: 'hello', app: 'counter', deviceToken: 'device-z' });
  const ready = await counter.next('ready');
  assert.deepEqual(ready.seq, { [`branch:${B1}`]: 0 });
  assert.equal(ready.epoch, hub.epoch);
  assert.deepEqual((await diner.next('ready')).seq, { table: 0 });
  await other.next('ready');

  hub.orderCreated({ branchId: B1, tableId: TABLE, orderId: 'o1' });
  hub.requestCreated({ branchId: B1, tableId: TABLE });
  assert.deepEqual(await counter.next('event'), { type: 'event', channel: `branch:${B1}`, seq: 1, event: 'order.created', orderId: 'o1', seen: true });
  assert.equal((await counter.next('event')).seq, 2);
  const bill = await diner.next('event');
  assert.equal(bill.channel, 'table');
  assert.equal(bill.event, 'bill.updated');
  assert.equal(bill.seq, 1);
  assert.doesNotMatch(JSON.stringify(diner.messages), /o1|branch/);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(other.messages.filter((message) => message.type === 'event').length, 0);
});

test('pings every few seconds carry the latest numbers, so a missed message is noticed', async (t) => {
  const { hub, open } = await start(t, { pingMs: 100 });
  const counter = await open({ type: 'hello', app: 'counter', deviceToken: 'device-a' });
  await counter.next('ready');
  hub.publish(`branch:${B1}`, 'order.updated');
  hub.publish(`branch:${B1}`, 'order.updated');
  let ping;
  do { ping = await counter.next('ping'); } while (ping.seq[`branch:${B1}`] !== 2);
  assert.equal(ping.epoch, hub.epoch);
});

test('the owner hears every branch or one; staff only their own; menu news reaches everyone of the restaurant', async (t) => {
  const { hub, open } = await start(t);
  const owner = await open({ type: 'hello', app: 'portal', accessToken: jwt({ sub: 'owner-1', exp: Math.floor(Date.now() / 1000) + 600 }) });
  assert.deepEqual(Object.keys((await owner.next('ready')).seq).sort(), [`branch:${B1}`, `branch:${B2}`].sort());
  const ownerOne = await open({ type: 'hello', app: 'portal', branchId: B2, accessToken: jwt({ sub: 'owner-1', exp: Math.floor(Date.now() / 1000) + 600 }) });
  assert.deepEqual(Object.keys((await ownerOne.next('ready')).seq), [`branch:${B2}`]);
  const staffElsewhere = await open({ type: 'hello', app: 'portal', branchId: B1, accessToken: jwt({ sub: 'staff-1', exp: Math.floor(Date.now() / 1000) + 600 }) });
  assert.deepEqual(await staffElsewhere.closed, { code: CLOSE.forbidden, reason: 'branch_not_found' });

  const diner = await open({ type: 'hello', app: 'diner', tableToken: 'table-a' });
  await diner.next('ready');
  hub.menuUpdated({ tenantId: T1, version: 7 });
  assert.equal((await diner.next('event')).version, 7);
  const ownerEvents = [await owner.next('event'), await owner.next('event')];
  assert.deepEqual(ownerEvents.map((event) => event.event), ['menu.updated', 'menu.updated']);
  hub.serviceUpdated({ tenantId: T1, branchId: B2 });
  assert.equal((await ownerOne.next('event')).event, 'menu.updated');
  assert.equal((await ownerOne.next('event')).event, 'service.updated');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(diner.messages.filter((message) => message.event === 'service.updated').length, 0, 'the diner is at branch 1');
});

test('refused: other paths, other websites, bad or wrong hellos, silence, and a second message', async (t) => {
  const { open } = await start(t, { helloTimeoutMs: 150 });
  assert.equal((await open(undefined, { path: '/other' })).status, 404);
  assert.equal((await open(undefined, { headers: { origin: 'https://evil.example' } })).status, 403);
  const allowed = await open({ type: 'hello', app: 'counter', deviceToken: 'device-a' }, { headers: { origin: 'http://localhost:3003' } });
  await allowed.next('ready');

  assert.deepEqual(await (await open('not json')).closed, { code: CLOSE.badHello, reason: 'bad_hello' });
  assert.deepEqual(await (await open({ type: 'hello', app: 'kitchen' })).closed, { code: CLOSE.badHello, reason: 'bad_hello' });
  assert.deepEqual(await (await open({ type: 'hello', app: 'counter', deviceToken: 'stolen' })).closed, { code: CLOSE.unauthorized, reason: 'device_revoked' });
  assert.deepEqual(await (await open({ type: 'hello', app: 'diner', tableToken: 'old-card' })).closed, { code: CLOSE.unauthorized, reason: 'table_not_found' });
  assert.deepEqual(await (await open({ type: 'hello', app: 'portal', accessToken: jwt({ sub: 'someone' }) })).closed, { code: CLOSE.unauthorized, reason: 'unauthorized' });
  assert.deepEqual(await (await open()).closed, { code: CLOSE.helloTimeout, reason: 'hello_timeout' });

  const chatty = await open({ type: 'hello', app: 'counter', deviceToken: 'device-a' });
  await chatty.next('ready');
  chatty.ws.send(JSON.stringify({ type: 'hello', app: 'counter', deviceToken: 'device-a' }));
  assert.deepEqual(await chatty.closed, { code: CLOSE.badHello, reason: 'unexpected_message' });
});

test('lines close when the sign-in expires, a counter is unpaired, a QR code is replaced or the restaurant cancelled', async (t) => {
  const { hub, open } = await start(t);
  const soon = await open({ type: 'hello', app: 'portal', accessToken: jwt({ sub: 'owner-1', exp: Math.floor(Date.now() / 1000) + 1 }) });
  await soon.next('ready');
  assert.deepEqual(await soon.closed, { code: CLOSE.unauthorized, reason: 'session_expired' });

  const counter = await open({ type: 'hello', app: 'counter', deviceToken: 'device-a' });
  const diner = await open({ type: 'hello', app: 'diner', tableToken: 'table-a' });
  const other = await open({ type: 'hello', app: 'counter', deviceToken: 'device-z' });
  await Promise.all([counter.next('ready'), diner.next('ready'), other.next('ready')]);
  hub.deviceRemoved({ tenantId: T2, deviceId: 'd1' });
  hub.deviceRemoved({ tenantId: T1, deviceId: 'd1' });
  assert.deepEqual(await counter.closed, { code: CLOSE.unauthorized, reason: 'device_revoked' });
  hub.tableRetired({ tenantId: T1, tableId: TABLE });
  assert.deepEqual(await diner.closed, { code: CLOSE.unauthorized, reason: 'table_not_found' });

  const again = await open({ type: 'hello', app: 'counter', deviceToken: 'device-a' });
  await again.next('ready');
  hub.tenantChanged(T1);
  assert.equal((await again.next('event')).event, 'account.updated');
  hub.tenantChanged(T1, { cancelled: true });
  assert.deepEqual(await again.closed, { code: CLOSE.unauthorized, reason: 'account_cancelled' });
  assert.equal(other.ws.readyState, WebSocket.OPEN, 'another restaurant is untouched');
});

test('on shutdown every line is told to reconnect, and too many lines from one address are refused', async (t) => {
  const { lines, open, capture } = await start(t, { maxPerIp: 2 });
  const first = await open({ type: 'hello', app: 'counter', deviceToken: 'device-a' });
  const second = await open({ type: 'hello', app: 'diner', tableToken: 'table-a' });
  await Promise.all([first.next('ready'), second.next('ready')]);
  assert.equal((await open()).status, 429);
  await lines.close();
  assert.deepEqual(await first.closed, { code: CLOSE.restarting, reason: 'restarting' });
  assert.deepEqual(await second.closed, { code: CLOSE.restarting, reason: 'restarting' });
  assert.doesNotMatch(capture.text(), /device-a|table-a/, 'tokens never logged');
});

test('scripts without live updates can call every announcement safely', () => {
  for (const announce of Object.values(NO_LIVE)) assert.equal(announce({}), undefined);
});

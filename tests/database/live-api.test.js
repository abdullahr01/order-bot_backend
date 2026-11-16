// Live updates through the real API and database (rolled back): each saved change is
// announced to the right counter, owner screen and diner phone, numbered; another
// restaurant hears nothing and can't listen in.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openHarness } from './api-harness.js';

const harness = openHarness();
after(() => harness.close());

/** A restaurant open all day with a dish, a table, a waiter and a paired counter. */
async function serving(api) {
  const restaurant = await api.restaurant();
  const owner = (method, path, body) => api.call(method, `/portal${path}`, { token: restaurant.ownerToken, body });
  await api.openAllDay(restaurant.ownerToken);
  const category = (await owner('POST', '/menu/categories', { name: 'Karahi' })).body.categories[0];
  const dish = (await owner('POST', '/menu/items', {
    categoryId: category.id, name: 'Chicken Karahi', description: '', price: 1100, photoUrl: null, available: true, soldOutUntil: null, options: [],
  })).body.items[0];
  const table = (await owner('POST', '/dine-in/tables', { number: 4, seats: 4, branchId: restaurant.mainBranchId })).body.tables[0];
  const waiter = (await owner('POST', '/dine-in/waiters', { name: 'Shahid', branchId: restaurant.mainBranchId })).body.waiters[0];
  const deviceToken = await api.pairCounter(restaurant.ownerToken, restaurant.mainBranchId);
  const diner = (method, path = '', body) => api.call(method, `/public/tables/${table.token}${path}`, { body });
  return { ...restaurant, owner, dish, table, waiter, deviceToken, diner };
}

test('each saved change reaches the counter, the owner and the diner, numbered; another restaurant hears nothing', () => harness.run(async (api) => {
  const here = await serving(api);
  const there = await serving(api);
  const branch = `branch:${here.mainBranchId}`;

  const counter = await api.listen({ type: 'hello', app: 'counter', deviceToken: here.deviceToken });
  const owner = await api.listen({ type: 'hello', app: 'portal', accessToken: await here.ownerToken });
  const diner = await api.listen({ type: 'hello', app: 'diner', tableToken: here.table.token });
  const elsewhere = await api.listen({ type: 'hello', app: 'counter', deviceToken: there.deviceToken });
  const elsewhereOwner = await api.listen({ type: 'hello', app: 'portal', accessToken: await there.ownerToken });
  const ready = await counter.ready();
  assert.deepEqual(Object.keys(ready.seq), [branch]);
  assert.deepEqual(Object.keys((await owner.ready()).seq), [branch]);
  assert.deepEqual((await diner.ready()).seq, { table: 0 });
  await elsewhere.ready();
  await elsewhereOwner.ready();

  // The diner orders: the counter and the owner see a new order; the diner's other phones a new bill.
  const placed = await here.diner('POST', '/orders', { clientRef: randomUUID(), items: [{ menuItemId: here.dish.id, quantity: 1 }] });
  const orderId = placed.body.bill.orders[0].id;
  const created = await counter.event('order.created');
  assert.deepEqual([created.channel, created.orderId], [branch, orderId]);
  assert.equal((await owner.event('order.created')).orderId, orderId);
  assert.equal((await diner.event('bill.updated')).channel, 'table');

  // Accepted with a waiter; a water request; seen to.
  await here.owner('PATCH', `/orders/${orderId}/status`, { from: 'new', status: 'accepted', waiterId: here.waiter.id });
  assert.equal((await counter.event('order.updated')).orderId, orderId);
  await diner.event('bill.updated');
  await here.diner('POST', '/requests', { kind: 'water' });
  await counter.event('request.created');
  await diner.event('bill.updated');
  const [request] = (await here.owner('GET', '/dine-in/requests')).body.open;
  await here.owner('POST', `/dine-in/requests/${request.id}/handle`);
  assert.equal((await counter.event('request.handled')).requestId, request.id);
  await diner.event('bill.updated');

  // The menu changes for everyone of the restaurant, with its new version.
  const soldOut = await here.owner('PATCH', `/menu/items/${here.dish.id}`, { available: false });
  assert.equal(soldOut.status, 200);
  const menu = await counter.event('menu.updated');
  assert.ok(Number.isInteger(menu.version));
  assert.equal((await diner.event('menu.updated')).version, menu.version);

  // A pause at this branch; then the table settled.
  const until = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  assert.equal((await here.owner('PATCH', '/service', { pausedUntil: until })).status, 200);
  await counter.event('service.updated');
  await diner.event('service.updated');
  const closed = await here.owner('POST', `/dine-in/tables/${here.table.id}/close`, { outcome: 'paid', paidBy: 'cash' });
  assert.equal(closed.status, 200);
  await counter.event('session.updated');
  await diner.event('bill.updated');

  // Numbered one after another on each channel, with no gaps.
  const numbers = counter.events().map((event) => event.seq);
  assert.deepEqual(numbers, numbers.map((_, index) => index + 1));
  const dinerNumbers = diner.events().map((event) => event.seq);
  assert.deepEqual(dinerNumbers, dinerNumbers.map((_, index) => index + 1));

  // Another restaurant heard nothing at all.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual([elsewhere.events(), elsewhereOwner.events()], [[], []]);
  const ping = elsewhere.messages.find((message) => message.type === 'ping');
  assert.ok(ping, 'pings still arrive');
  assert.deepEqual(Object.keys(ping.seq), [`branch:${there.mainBranchId}`]);
}));

test('another restaurant can\'t listen in; lines close on unpairing, a new QR code, staff removal and expiry of sign-in', () => harness.run(async (api) => {
  const here = await serving(api);
  const there = await serving(api);

  // Wrong restaurant: another owner asking for this branch, and made-up credentials.
  const intruder = await api.listen({ type: 'hello', app: 'portal', branchId: here.mainBranchId, accessToken: await there.ownerToken });
  assert.deepEqual(await intruder.closed, { code: 4403, reason: 'branch_not_found' });
  const guessed = await api.listen({ type: 'hello', app: 'counter', deviceToken: 'a'.repeat(64) });
  assert.deepEqual(await guessed.closed, { code: 4401, reason: 'device_revoked' });
  const unsigned = await api.listen({ type: 'hello', app: 'portal', accessToken: 'not-a-token' });
  assert.deepEqual(await unsigned.closed, { code: 4401, reason: 'unauthorized' });

  // A staff member hears only their own branch, and is cut off when removed.
  const second = await api.addBranch(here.id, 'Gulberg');
  const staff = await api.addStaff(here.id, second, 'Rabia Khan');
  const staffLine = await api.listen({ type: 'hello', app: 'portal', accessToken: await staff.token });
  assert.deepEqual(Object.keys((await staffLine.ready()).seq), [`branch:${second}`]);
  const tried = await api.listen({ type: 'hello', app: 'portal', branchId: here.mainBranchId, accessToken: await staff.token });
  assert.deepEqual(await tried.closed, { code: 4403, reason: 'branch_not_found' });
  assert.equal((await here.owner('DELETE', `/team/${staff.id}`)).status, 200);
  assert.deepEqual(await staffLine.closed, { code: 4401, reason: 'account_removed' });

  // A new QR code cuts off phones on the old one; the old code can't sign in again.
  const diner = await api.listen({ type: 'hello', app: 'diner', tableToken: here.table.token });
  await diner.ready();
  assert.equal((await here.owner('POST', `/dine-in/tables/${here.table.id}/token`)).status, 200);
  assert.deepEqual(await diner.closed, { code: 4401, reason: 'table_not_found' });
  assert.deepEqual(await (await api.listen({ type: 'hello', app: 'diner', tableToken: here.table.token })).closed, { code: 4401, reason: 'table_not_found' });

  // Unpairing the counter cuts it off; another restaurant's counter stays.
  const counter = await api.listen({ type: 'hello', app: 'counter', deviceToken: here.deviceToken });
  const otherCounter = await api.listen({ type: 'hello', app: 'counter', deviceToken: there.deviceToken });
  await counter.ready();
  await otherCounter.ready();
  const [device] = (await here.owner('GET', '/counters')).body.devices;
  assert.equal((await api.call('DELETE', `/portal/counters/${device.id}`, { token: there.ownerToken })).status, 404, 'not another restaurant\'s to unpair');
  assert.equal((await here.owner('DELETE', `/counters/${device.id}`)).status, 200);
  assert.deepEqual(await counter.closed, { code: 4401, reason: 'device_revoked' });
  assert.equal(otherCounter.ws.readyState, 1, 'still open');
}));

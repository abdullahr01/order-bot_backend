// A whole evening, then the diner page's and the counter's rules one by one. Every test
// runs in a transaction that is rolled back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openHarness } from './api-harness.js';

const harness = openHarness();
after(() => harness.close());

/** A restaurant open all day with a menu, a table, a waiter and an unlocked counter. */
async function evening(api, overrides = {}) {
  const restaurant = await api.restaurant(overrides);
  const { id, ownerToken, mainBranchId } = restaurant;
  const owner = (method, path, body, headers) => api.call(method, `/portal${path}`, { token: ownerToken, body, headers });
  await api.openAllDay(ownerToken);
  const category = (await owner('POST', '/menu/categories', { name: 'Karahi' })).body.categories[0];
  const options = [{ id: 'size', name: 'Size', kind: 'one', choices: [{ id: 'half', name: 'Half', price: 0 }, { id: 'full', name: 'Full', price: 900 }] },
    { id: 'extra', name: 'Extras', kind: 'extra', choices: [{ id: 'butter', name: 'Butter on top', price: 100 }] }];
  const menu = await owner('POST', '/menu/items', { categoryId: category.id, name: 'Chicken Karahi', description: '', price: 1100, photoUrl: null, available: true, soldOutUntil: null, options });
  const karahi = menu.body.items[0];
  const naan = (await owner('POST', '/menu/items', { categoryId: category.id, name: 'Naan', description: '', price: 60, photoUrl: null, available: true, soldOutUntil: null, options: [] })).body.items.find((i) => i.name === 'Naan');
  const table = (await owner('POST', '/dine-in/tables', { number: 4, seats: 4, branchId: mainBranchId })).body.tables[0];
  const waiter = (await owner('POST', '/dine-in/waiters', { name: 'Shahid', branchId: mainBranchId })).body.waiters[0];
  const staff = await api.addStaff(id, mainBranchId, 'Rabia Khan');
  const deviceToken = await api.pairCounter(ownerToken, mainBranchId);
  const counter = await api.unlockCounter(ownerToken, deviceToken, staff.id);
  const diner = (method, path = '', body) => api.call(method, `/public/tables/${table.token}${path}`, { body });
  return { ...restaurant, owner, category, karahi, naan, table, waiter, staff, counter, diner, deviceToken };
}

test('a whole evening: scan, order, waiter, more rounds, requests, bill, payment, table free', () => harness.run(async (api) => {
  const { owner, karahi, naan, table, waiter, counter, diner } = await evening(api);

  // 7:10 pm, the party scans the code.
  const page = await diner('GET');
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.ordering, page.body.table, page.body.bill.orders], [{ state: 'open' }, { number: 4, label: null }, []]);
  assert.deepEqual(Object.keys(page.body).sort(), ['bill', 'branch', 'features', 'generatedAt', 'menu', 'openRequests', 'ordering', 'restaurant', 'table']);
  assert.ok(!JSON.stringify(page.body).includes(karahi.tenantId), 'no restaurant id on the diner page');
  assert.ok(!JSON.stringify(page.body).includes('Rabia'), 'no staff names');

  // They order: the server prices it, whatever the phone says.
  const cart = { clientRef: randomUUID(), notes: 'Less spicy please', items: [{ menuItemId: karahi.id, quantity: 2, choices: ['full', 'butter'], unitPrice: 1 }] };
  const ordered = await diner('POST', '/orders', cart);
  assert.equal(ordered.status, 200);
  const first = ordered.body.bill.orders[0];
  assert.deepEqual([first.status, first.total, first.items[0].unitPrice, first.items[0].options, first.byStaff], ['new', 4200, 2100, ['Full', '+ Butter on top'], false]);
  assert.ok(first.number >= 1200);
  // The phone lost the answer and sends the same cart again: still one order.
  const retried = await diner('POST', '/orders', cart);
  assert.equal(retried.body.bill.orders.length, 1);

  // 7:11 pm, the counter gives it to Shahid. A second counter tapping a moment later is refused.
  const board = await counter('GET', '/orders');
  assert.deepEqual([board.body.items.map((o) => o.id), board.body.counts.new], [[first.id], 1]);
  const [accept, late] = await Promise.all([
    counter('PATCH', `/orders/${first.id}/status`, { from: 'new', status: 'accepted', waiterId: waiter.id }),
    owner('PATCH', `/orders/${first.id}/status`, { from: 'new', status: 'accepted', waiterId: waiter.id }),
  ]);
  assert.deepEqual([accept.status, late.status, late.body.code], [200, 409, 'order_changed']);
  assert.match(late.body.message, /is already with a waiter/);
  assert.deepEqual(accept.body.history.map((h) => h.status), ['new', 'accepted']);

  // 7:40 pm, another round goes straight to Shahid; they ask for water twice and for the bill.
  const second = (await diner('POST', '/orders', { clientRef: randomUUID(), items: [{ menuItemId: naan.id, quantity: 4 }] })).body.bill.orders[1];
  assert.equal(second.status, 'accepted');
  await diner('POST', '/requests', { kind: 'water' });
  const water = await diner('POST', '/requests', { kind: 'water' });
  assert.deepEqual(water.body.openRequests, ['water']);
  const bill = await diner('POST', '/requests', { kind: 'bill' });
  assert.ok(bill.body.bill.billRequestedAt);
  assert.deepEqual([bill.body.bill.total, bill.body.openRequests.sort()], [4440, ['bill', 'water']]);
  const requests = await counter('GET', '/dine-in/requests');
  assert.deepEqual(requests.body.open.map((r) => [r.kind, r.table]), [['water', 4], ['bill', 4]]);
  const handled = await counter('POST', `/dine-in/requests/${requests.body.open[0].id}/handle`);
  assert.deepEqual([handled.body.open.length, handled.body.recent[0].handledBy], [1, 'Rabia Khan']);

  const floor = await counter('GET', '/dine-in/floor');
  const row = floor.body.tables.find((t) => t.table.id === table.id);
  assert.deepEqual([row.session.status, row.total, row.orderCount, row.waitingForWaiter, row.openRequests], ['bill_requested', 4440, 2, 0, 1]);

  // Dessert after the bill, entered at the counter; the counter's Wi-Fi drops and it sends it twice.
  const key = randomUUID();
  const manual = { tableId: table.id, items: [{ menuItemId: naan.id, quantity: 1 }], notes: 'For the child' };
  const entered = await counter('POST', '/dine-in/orders', manual, { 'idempotency-key': key });
  const again = await counter('POST', '/dine-in/orders', manual, { 'idempotency-key': key });
  assert.deepEqual([entered.status, again.status, again.body], [200, 200, entered.body], 'the retry gets the first answer');
  assert.equal(entered.body.orders.length, 3, 'one order, not two');
  const staffOrder = entered.body.orders[2];
  assert.deepEqual([staffOrder.status, staffOrder.source, staffOrder.enteredBy, staffOrder.enteredByName, staffOrder.waiterId], ['accepted', 'staff', 'staff', 'Rabia Khan', waiter.id]);
  const misuse = await counter('POST', '/dine-in/orders', { ...manual, notes: 'Different' }, { 'idempotency-key': key });
  assert.deepEqual([misuse.status, misuse.body.code], [400, 'bad_request']);

  // 8:35 pm, cash. The close is sent twice too.
  const closeKey = randomUUID();
  const paid = await counter('POST', `/dine-in/tables/${table.id}/close`, { outcome: 'paid', paidBy: 'cash' }, { 'idempotency-key': closeKey });
  assert.equal(paid.status, 200);
  assert.deepEqual([paid.body.session.status, paid.body.session.closedAs, paid.body.session.paidBy, paid.body.session.amountPaid, paid.body.session.closedBy], ['closed', 'paid', 'cash', 4500, 'Rabia Khan']);
  assert.ok(paid.body.orders.every((order) => order.status === 'served'));
  const closeAgain = await counter('POST', `/dine-in/tables/${table.id}/close`, { outcome: 'paid', paidBy: 'cash' }, { 'idempotency-key': closeKey });
  assert.deepEqual(closeAgain.body, paid.body, 'not "already free", and never the next party');
  const free = await counter('POST', `/dine-in/tables/${table.id}/close`, { outcome: 'paid', paidBy: 'cash' });
  assert.deepEqual([free.status, free.body.code, free.body.message], [409, 'no_session', 'Table 4 is already free.']);

  // The table is free for the next party; the evening is in the record.
  assert.deepEqual((await diner('GET')).body.bill, { orders: [], total: 0, billRequestedAt: null });
  assert.equal((await counter('GET', '/dine-in/floor')).body.tables[0].session, null);
  const done = await owner('GET', '/orders?view=completed&range=today');
  assert.equal(done.body.items.length, 3);
  assert.equal((await owner('GET', '/orders?q=t4&view=completed')).body.items.length, 3);
  assert.equal((await owner('GET', `/orders?q=%23${first.number}&view=completed`)).body.items[0].id, first.id);
  const today = await counter('GET', '/today');
  assert.deepEqual([today.body.completed, today.body.waiting, today.body.inProgress], [3, 0, 0]);
}));

test('the diner page: closed, paused, unavailable; dishes, options, menus by time; the prank limit', () => harness.run(async (api) => {
  const { id, owner, ownerToken, karahi, naan, category, table, waiter, diner, counter } = await evening(api);
  const line = (overrides = {}) => ({ clientRef: randomUUID(), items: [{ menuItemId: naan.id, quantity: 1, ...overrides }] });
  const refused = async (body) => (await diner('POST', '/orders', body)).body;

  assert.equal((await refused({ clientRef: randomUUID(), items: [] })).fields.items, 'Add at least one dish.');
  assert.equal((await refused(line({ quantity: 51 }))).fields.items, 'Quantities from 1 to 50.');
  assert.equal((await refused({ clientRef: randomUUID(), items: Array.from({ length: 31 }, () => ({ menuItemId: naan.id, quantity: 1 })) })).fields.items, 'That’s a very long order. Please send it in two parts.');
  assert.equal((await refused(line({ menuItemId: randomUUID() }))).fields.items, 'A dish is no longer on the menu.');
  assert.equal((await refused({ clientRef: randomUUID(), items: [{ menuItemId: karahi.id, quantity: 1 }] })).fields.items, 'Choose size for Chicken Karahi.');
  assert.match((await refused({ clientRef: randomUUID(), items: [{ menuItemId: karahi.id, quantity: 1, choices: ['half', 'nope'] }] })).fields.items, /options for Chicken Karahi have changed/);
  await counter('PATCH', `/menu/items/${naan.id}`, { soldOutUntil: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal((await refused(line())).fields.items, 'Naan is not available right now.');
  const page = await diner('GET');
  assert.equal(page.body.menu.items.find((item) => item.id === naan.id).soldOut, true);
  await owner('PATCH', `/menu/items/${naan.id}`, { soldOutUntil: null, available: false });
  assert.ok(!(await diner('GET')).body.menu.items.some((item) => item.id === naan.id), 'hidden dishes are left out');
  await owner('PATCH', `/menu/items/${naan.id}`, { available: true });

  // A breakfast menu outside its hours.
  const hour = new Date().getUTCHours();
  const notNow = { days: [0, 1, 2, 3, 4, 5, 6], from: `${String((hour + 8) % 24).padStart(2, '0')}:00`, to: `${String((hour + 9) % 24).padStart(2, '0')}:00`, until: null };
  await owner('PATCH', `/menu/categories/${category.id}`, { schedule: notNow });
  const timed = await diner('GET');
  assert.equal(timed.body.menu.categories[0].servedNow, false);
  assert.match(timed.body.menu.categories[0].servedText, /^Daily, /);
  assert.match((await refused(line())).fields.items, /^Naan is on the Karahi menu: Daily, /);
  await owner('PATCH', `/menu/categories/${category.id}`, { schedule: null });

  // Paused by the owner, by the branch, closed for the day, and unavailable.
  const until = new Date(Date.now() + 20 * 60_000).toISOString();
  await owner('PATCH', '/service', { pausedUntil: until });
  const paused = await diner('POST', '/orders', line());
  assert.deepEqual([paused.status, paused.body.code], [409, 'not_taking_orders']);
  assert.deepEqual((await diner('GET')).body.ordering, { state: 'paused', until });
  const staffWhilePaused = await counter('POST', '/dine-in/orders', { tableId: table.id, items: [{ menuItemId: naan.id, quantity: 1 }], waiterId: waiter.id });
  assert.equal(staffWhilePaused.status, 200, 'staff still take orders while paused');
  await owner('PATCH', '/service', { pausedUntil: null });
  assert.equal((await counter('PUT', '/today/pause', { pausedUntil: new Date(Date.now() + 13 * 3_600_000).toISOString() })).body.fields.pausedUntil, 'Pause for up to 12 hours.');
  const branchPause = await counter('PUT', '/today/pause', { pausedUntil: until });
  assert.equal(branchPause.body.branchPausedUntil, until);
  assert.equal((await diner('GET')).body.ordering.state, 'paused');
  await counter('PUT', '/today/pause', { pausedUntil: null });
  await owner('PATCH', '/service', { hours: Array.from({ length: 7 }, (_, day) => ({ day, open: false, opensAt: '12:00', closesAt: '23:00' })) });
  assert.deepEqual((await diner('GET')).body.ordering, { state: 'closed', opensAt: null });
  await api.openAllDay(ownerToken);
  await api.sql`insert into dinein.tenant_overrides (tenant_id, feature_key, granted, reason, created_by) values (${id}, 'qr_ordering', false, 'Test revoke', 'Test')`;
  assert.deepEqual((await diner('GET')).body.ordering, { state: 'unavailable' });
  assert.equal((await diner('POST', '/orders', line())).body.message, 'Ordering from the table isn’t available here. Please order with a waiter.');
  await api.sql`delete from dinein.tenant_overrides where tenant_id = ${id}`;

  // No party yet: requests need someone to have ordered.
  const fresh = await evening(api);
  assert.equal((await fresh.diner('POST', '/requests', { kind: 'water' })).body.code, 'no_session');
  assert.equal((await fresh.diner('POST', '/requests', { kind: 'champagne' })).body.code, 'validation_failed');
  // Eight orders an hour, then the prank limit.
  for (let n = 0; n < 8; n += 1) assert.equal((await fresh.diner('POST', '/orders', { clientRef: randomUUID(), items: [{ menuItemId: fresh.naan.id, quantity: 1 }] })).status, 200);
  const ninth = await fresh.diner('POST', '/orders', { clientRef: randomUUID(), items: [{ menuItemId: fresh.naan.id, quantity: 1 }] });
  assert.deepEqual([ninth.status, ninth.body.code], [429, 'too_many_orders']);

  assert.equal((await api.call('GET', '/public/tables/not-a-real-token')).body.code, 'table_not_found');
  // A retired table's code stops working at once.
  await api.sql`update dinein.table_sessions set status = 'closed', closed_at = now(), closed_as = 'force_closed', closed_by = 'Test', close_reason = 'Test close' where table_id = ${fresh.table.id}`;
  await fresh.owner('PATCH', `/dine-in/tables/${fresh.table.id}`, { active: false });
  assert.equal((await fresh.diner('GET')).body.code, 'table_not_found');
}));

test('orders: steps, cancel reasons, waiters at the branch, force close and suspension', () => harness.run(async (api) => {
  const { id, owner, naan, table, waiter, counter, diner, detail } = await evening(api);
  const place = async () => (await diner('POST', '/orders', { clientRef: randomUUID(), items: [{ menuItemId: naan.id, quantity: 2 }] })).body.bill.orders.at(-1);
  const order = await place();
  const status = (body, target = order.id) => counter('PATCH', `/orders/${target}/status`, body);

  assert.equal((await status({ from: 'new', status: 'served' })).body.code, 'invalid_transition');
  assert.deepEqual((await status({ from: 'new', status: 'accepted' })).body.fields, { waiterId: 'Choose the waiter who will serve this table.' });
  const other = await api.addBranch(id);
  const farWaiter = (await owner('POST', '/dine-in/waiters', { name: 'Far', branchId: other })).body.waiters.find((w) => w.name === 'Far');
  assert.equal((await status({ from: 'new', status: 'accepted', waiterId: farWaiter.id })).status, 422, 'the waiter must be at the order’s branch');
  assert.deepEqual((await status({ from: 'new', status: 'cancelled', reason: 'no' })).body.fields, { reason: 'Give a short reason; it is kept in the void log.' });
  const cancelled = await status({ from: 'new', status: 'cancelled', reason: 'Diner asked to cancel' });
  assert.deepEqual([cancelled.body.status, cancelled.body.cancelReason, cancelled.body.cancelledBy], ['cancelled', 'Diner asked to cancel', 'Rabia Khan']);
  assert.equal((await status({ from: 'cancelled', status: 'accepted', waiterId: waiter.id })).body.code, 'invalid_transition', 'cancelled is final');

  // Paying is refused while an order waits for a waiter; force close cancels what's open.
  const waiting = await place();
  const blocked = await counter('POST', `/dine-in/tables/${table.id}/close`, { outcome: 'paid', paidBy: 'card' });
  assert.deepEqual([blocked.status, blocked.body.code, blocked.body.message], [409, 'orders_waiting', '1 order is still waiting for a waiter. Give it to a waiter or cancel before taking payment.']);
  assert.equal((await counter('POST', `/dine-in/tables/${table.id}/close`, { outcome: 'paid', paidBy: 'bitcoin' })).status, 409, 'still waiting first');
  assert.equal((await counter('POST', `/dine-in/tables/${table.id}/close`, { outcome: 'force_closed', reason: 'Left' })).body.fields.reason, 'Say why the table is being closed.');
  const forced = await counter('POST', `/dine-in/tables/${table.id}/close`, { outcome: 'force_closed', reason: 'Party left without paying' });
  assert.deepEqual([forced.body.session.closedAs, forced.body.session.closeReason], ['force_closed', 'Party left without paying']);
  const [left] = await api.sql`select status, cancel_reason, cancelled_by from dinein.orders where id = ${waiting.id}`;
  assert.deepEqual([left.status, left.cancel_reason, left.cancelled_by], ['cancelled', 'Table closed: Party left without paying', 'Rabia Khan']);

  // Suspended: the diner page says so and the counter can only look.
  await place();
  await api.call('POST', `/admin/tenants/${id}/status`, { token: api.admin(), body: { status: 'suspended', reason: 'Testing suspension', confirmation: detail.tenant.businessName } });
  assert.deepEqual((await diner('GET')).body.ordering, { state: 'unavailable' });
  assert.equal((await counter('GET', '/orders')).status, 200);
  assert.equal((await counter('POST', '/dine-in/orders', { tableId: table.id, items: [{ menuItemId: naan.id, quantity: 1 }], waiterId: waiter.id })).body.code, 'account_paused');
  assert.equal((await counter('PUT', '/today/pause', { pausedUntil: null })).body.code, 'account_paused');
}));

test('another restaurant’s or branch’s orders, tables and requests do not exist', () => harness.run(async (api) => {
  const mine = await evening(api);
  const theirs = await evening(api);
  await theirs.diner('POST', '/orders', { clientRef: randomUUID(), items: [{ menuItemId: theirs.naan.id, quantity: 1 }] });
  await theirs.diner('POST', '/requests', { kind: 'water' });
  const theirOrder = (await theirs.owner('GET', '/orders')).body.items[0];
  const theirRequest = (await theirs.owner('GET', '/dine-in/requests')).body.open[0];

  for (const [method, path, body] of [
    ['GET', `/orders/${theirOrder.id}`], ['PATCH', `/orders/${theirOrder.id}/status`, { from: 'new', status: 'cancelled', reason: 'Not mine' }],
    ['GET', `/dine-in/tables/${theirs.table.id}`], ['POST', `/dine-in/tables/${theirs.table.id}/close`, { outcome: 'force_closed', reason: 'Not my table' }],
    ['POST', '/dine-in/orders', { tableId: theirs.table.id, items: [{ menuItemId: mine.naan.id, quantity: 1 }], waiterId: mine.waiter.id }],
    ['POST', `/dine-in/requests/${theirRequest.id}/handle`],
  ]) {
    for (const caller of [mine.owner, mine.counter]) {
      const response = await caller(method, path, body);
      assert.deepEqual([path, response.status, response.body.code], [path, 404, 'not_found']);
    }
  }
  assert.deepEqual((await mine.owner('GET', '/orders')).body.items, []);
  assert.deepEqual((await mine.counter('GET', '/dine-in/requests')).body.open, []);
  // Their dish can't be ordered at my table.
  assert.equal((await mine.diner('POST', '/orders', { clientRef: randomUUID(), items: [{ menuItemId: theirs.naan.id, quantity: 1 }] })).body.fields.items, 'A dish is no longer on the menu.');

  // Staff at another branch of the same restaurant see nothing of this branch.
  const other = await api.addBranch(mine.id);
  const far = await api.addStaff(mine.id, other, 'Far Away');
  const farCall = (method, path, body) => api.call(method, `/portal${path}`, { token: far.token, body });
  await mine.diner('POST', '/orders', { clientRef: randomUUID(), items: [{ menuItemId: mine.naan.id, quantity: 1 }] });
  const myOrder = (await mine.owner('GET', '/orders')).body.items[0];
  assert.equal((await farCall('GET', `/orders/${myOrder.id}`)).status, 404);
  assert.equal((await farCall('GET', `/dine-in/tables/${mine.table.id}`)).status, 404);
  assert.deepEqual((await farCall('GET', '/orders?branch=' + mine.mainBranchId)).body.items, [], 'asking for another branch changes nothing');
  assert.deepEqual((await farCall('GET', '/dine-in/floor')).body.tables, []);
  assert.equal((await theirs.owner('GET', '/orders')).body.items[0].status, 'new', 'nothing of theirs changed');
}));

test('opening hours and the branch’s day: owners set hours, staff see today', () => harness.run(async (api) => {
  const { owner, counter, staff, id, mainBranchId } = await evening(api);
  assert.equal((await api.call('GET', '/portal/service', { token: staff.token })).status, 403, 'hours are the owner’s');
  assert.equal((await owner('PATCH', '/service', { hours: [{ day: 0, open: true, opensAt: '12:00', closesAt: '23:00' }] })).body.code, 'validation_failed');
  assert.equal((await owner('PATCH', '/service', { pausedUntil: new Date(Date.now() - 60_000).toISOString() })).body.fields.pausedUntil, 'Choose a time later than now, or resume.');
  const hours = Array.from({ length: 7 }, (_, day) => ({ day, open: day !== 1, opensAt: '12:00', closesAt: '01:00' }));
  const saved = await owner('PATCH', '/service', { hours });
  assert.deepEqual([saved.body.hours, saved.body.pausedUntil], [hours, null]);
  const today = await counter('GET', '/today');
  assert.deepEqual([today.body.branch.id, today.body.hours, today.body.restaurantPausedUntil, today.body.branchPausedUntil], [mainBranchId, hours, null, null]);
  const ownerToday = await owner('GET', '/today');
  assert.equal(ownerToday.body.branch.isMain, true, 'owners see the main branch');
  assert.ok(id);
}));

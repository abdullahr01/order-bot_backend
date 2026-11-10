// /portal/dine-in setup: tables and waiters. Every test runs in a transaction that is rolled back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openHarness } from './api-harness.js';
import { hashToken } from '../../shared/crypto.js';

const harness = openHarness();
after(() => harness.close());

async function setup(api, overrides) {
  const restaurant = await api.restaurant(overrides);
  const as = (token) => (method, path, body) => api.call(method, `/portal/dine-in${path}`, { token, body });
  return { ...restaurant, as, owner: as(restaurant.ownerToken) };
}

const limitTables = (api, tenantId, value) => api.sql`insert into dinein.tenant_overrides (tenant_id, limit_key, limit_value, reason, created_by)
  values (${tenantId}, 'tables', ${value}, 'Test limit', 'Test')`;

async function seat(api, tenantId, table, waiterId) {
  await api.sql`insert into dinein.table_sessions (tenant_id, branch_id, table_id, waiter_id)
    values (${tenantId}, ${table.branchId}, ${table.id}, ${waiterId})`;
}

test('tables: numbers per branch, the plan’s limit, retiring, bringing back and a new QR code', () => harness.run(async (api) => {
  const { id, owner, mainBranchId } = await setup(api);
  await limitTables(api, id, 2);

  const first = await owner('POST', '/tables', { number: 1, seats: 4, branchId: mainBranchId, label: ' Terrace ' });
  assert.equal(first.status, 200);
  const [table] = first.body.tables;
  assert.deepEqual([table.number, table.label, table.seats, table.active, first.body.tableLimit], [1, 'Terrace', 4, true, 2]);
  assert.match(table.token, /^[a-z2-9]{20}$/);

  const taken = await owner('POST', '/tables', { number: 1, seats: 2, branchId: mainBranchId });
  assert.deepEqual(taken.body.fields, { number: 'Table 1 already exists at this branch.' });
  const bad = await owner('POST', '/tables', { number: 0, seats: 31, branchId: randomUUID() });
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ['branchId', 'number', 'seats']);

  const second = (await owner('POST', '/tables', { number: 2, seats: 2, branchId: mainBranchId })).body.tables.find((entry) => entry.number === 2);
  const third = await owner('POST', '/tables', { number: 3, seats: 2, branchId: mainBranchId });
  assert.deepEqual([third.status, third.body.code], [403, 'limit_reached']);
  assert.match(third.body.message, /Your plan covers 2 tables/);

  // A table with a party can't be retired; a free one can, and coming back counts again.
  const [waiter] = await api.sql`insert into dinein.waiters (tenant_id, branch_id, name) values (${id}, ${mainBranchId}, 'Shahid') returning id`;
  await seat(api, id, table, waiter.id);
  assert.equal((await owner('PATCH', `/tables/${table.id}`, { active: false })).body.code, 'table_in_use');
  const retired = await owner('PATCH', `/tables/${second.id}`, { active: false });
  assert.equal(retired.body.tables.find((entry) => entry.id === second.id).active, false);
  const replacement = (await owner('POST', '/tables', { number: 3, seats: 6, branchId: mainBranchId })).body.tables.find((entry) => entry.number === 3);
  assert.equal((await owner('PATCH', `/tables/${second.id}`, { active: true })).body.code, 'limit_reached');
  // A retired table's number can be used again, and then the old one can't come back as it was.
  await owner('PATCH', `/tables/${replacement.id}`, { active: false });
  assert.equal((await owner('POST', '/tables', { number: 2, seats: 6, branchId: mainBranchId })).status, 200);
  assert.deepEqual((await owner('PATCH', `/tables/${second.id}`, { active: true })).body.fields, { number: 'Table 2 already exists at this branch.' });

  const renamed = await owner('PATCH', `/tables/${table.id}`, { seats: 6, label: null });
  assert.deepEqual([renamed.body.tables[0].seats, renamed.body.tables[0].label, renamed.body.tables[0].token], [6, null, table.token]);
  const fresh = await owner('POST', `/tables/${table.id}/token`);
  assert.notEqual(fresh.body.tables.find((entry) => entry.id === table.id).token, table.token, 'the old code stops working');

  // A table with history stays at its branch.
  const other = await api.addBranch(id);
  assert.equal((await owner('PATCH', `/tables/${table.id}`, { branchId: other })).body.code, 'table_in_use');
}));

test('waiters: owners and staff add and remove them, never while serving, and staff only at their branch', () => harness.run(async (api) => {
  const { id, as, owner, mainBranchId } = await setup(api);
  const other = await api.addBranch(id);
  const staff = as((await api.addStaff(id, mainBranchId)).token);

  const added = await staff('POST', '/waiters', { name: ' Shahid ', branchId: mainBranchId });
  assert.equal(added.status, 200);
  const shahid = added.body.waiters[0];
  assert.equal(shahid.name, 'Shahid');
  assert.deepEqual((await owner('POST', '/waiters', { name: 'shahid', branchId: mainBranchId })).body.fields, { name: 'Already on the list.' });
  assert.equal((await owner('POST', '/waiters', { name: 'Shahid', branchId: other })).status, 200, 'the same name at another branch is fine');
  assert.deepEqual((await staff('POST', '/waiters', { name: 'Bilal', branchId: other })).body.fields, { branchId: 'Choose a branch.' });

  // Staff see only their branch.
  const view = await staff('GET', '/setup');
  assert.deepEqual(view.body.branches.map((branch) => branch.id), [mainBranchId]);
  assert.deepEqual(view.body.waiters.map((waiter) => waiter.id), [shahid.id]);
  const ownerView = await owner('GET', '/setup');
  assert.equal(ownerView.body.waiters.length, 2);
  const elsewhere = ownerView.body.waiters.find((waiter) => waiter.branchId === other);
  assert.equal((await staff('DELETE', `/waiters/${elsewhere.id}`)).body.code, 'not_found');

  const table = (await owner('POST', '/tables', { number: 4, seats: 4, branchId: mainBranchId })).body.tables[0];
  await seat(api, id, table, shahid.id);
  const busy = await staff('DELETE', `/waiters/${shahid.id}`);
  assert.deepEqual([busy.status, busy.body.code], [409, 'waiter_busy']);
  assert.match(busy.body.message, /^Shahid is serving a table/);
  await api.sql`update dinein.table_sessions set status = 'closed', closed_at = now(), closed_as = 'paid', paid_by = 'cash', amount_paid = 0, closed_by = 'Test' where table_id = ${table.id}`;
  const removed = await staff('DELETE', `/waiters/${shahid.id}`);
  assert.deepEqual(removed.body.waiters, []);
  assert.equal((await staff('DELETE', `/waiters/${shahid.id}`)).body.code, 'not_found', 'already removed');

  // Staff can't manage tables.
  assert.deepEqual([(await staff('POST', '/tables', { number: 9, seats: 2, branchId: mainBranchId })).status], [403]);
  // A staff member's view of another branch's table is "not found".
  const far = (await owner('POST', '/tables', { number: 1, seats: 2, branchId: other })).body.tables.find((entry) => entry.branchId === other);
  assert.ok(!view.body.tables.some((entry) => entry.id === far.id));
}));

test('another restaurant’s tables and waiters do not exist for this owner', () => harness.run(async (api) => {
  const mine = await setup(api);
  const theirs = await setup(api);
  const table = (await theirs.owner('POST', '/tables', { number: 1, seats: 4, branchId: theirs.mainBranchId })).body.tables[0];
  const waiter = (await theirs.owner('POST', '/waiters', { name: 'Theirs', branchId: theirs.mainBranchId })).body.waiters[0];

  for (const [method, path, body] of [
    ['PATCH', `/tables/${table.id}`, { seats: 1 }],
    ['POST', `/tables/${table.id}/token`],
    ['DELETE', `/waiters/${waiter.id}`],
  ]) {
    const response = await mine.owner(method, path, body);
    assert.deepEqual([path, response.status, response.body.code], [path, 404, 'not_found']);
  }
  assert.deepEqual((await mine.owner('POST', '/tables', { number: 1, seats: 4, branchId: theirs.mainBranchId })).body.fields, { branchId: 'Choose a branch.' });
  assert.deepEqual((await mine.owner('POST', '/waiters', { name: 'Spy', branchId: theirs.mainBranchId })).body.fields, { branchId: 'Choose a branch.' });

  const view = await mine.owner('GET', '/setup');
  assert.deepEqual([view.body.tables, view.body.waiters], [[], []]);
  const theirsNow = await theirs.owner('GET', '/setup');
  assert.deepEqual([theirsNow.body.tables[0].seats, theirsNow.body.tables[0].token, theirsNow.body.waiters.length], [4, table.token, 1]);
}));

test('an unlocked counter works on its own branch: waiters and sold out yes, menu and tables no', () => harness.run(async (api) => {
  const { id, owner, mainBranchId } = await setup(api);
  const other = await api.addBranch(id);
  const person = await api.addStaff(id, other, 'Counter Person');
  // Pairing and PIN unlock arrive in Stage 4; here the paired, unlocked counter is made directly.
  const [deviceToken, staffToken] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  const [device] = await api.sql`insert into dinein.counter_devices (tenant_id, branch_id, name, token_hash, paired_by)
    values (${id}, ${other}, 'Front counter', ${hashToken(deviceToken)}, 'Test') returning id`;
  await api.sql`insert into dinein.counter_pins (tenant_id, user_id, pin_hash) values (${id}, ${person.id}, '$argon2id$test-only')`;
  await api.sql`insert into dinein.counter_unlocks (token_hash, tenant_id, branch_id, device_id, user_id)
    values (${hashToken(staffToken)}, ${id}, ${other}, ${device.id}, ${person.id})`;
  const counter = (method, path, body) => api.call(method, `/portal${path}`, {
    body, headers: { 'x-counter-device': deviceToken, authorization: `Bearer ${staffToken}` },
  });

  await owner('POST', '/tables', { number: 1, seats: 4, branchId: mainBranchId });
  const view = await counter('GET', '/dine-in/setup');
  assert.deepEqual([view.status, view.body.branches.map((branch) => branch.id), view.body.tables], [200, [other], []]);
  assert.equal((await counter('POST', '/dine-in/waiters', { name: 'Bilal', branchId: other })).status, 200);
  assert.equal((await counter('POST', '/dine-in/tables', { number: 2, seats: 2, branchId: other })).status, 403);
  assert.equal((await counter('POST', '/menu/categories', { name: 'Counter menu' })).status, 403);
  const me = await counter('GET', '/me');
  assert.deepEqual(me.body.branches.map((branch) => branch.id), [other]);
  // A locked counter (no staff token) can't use the portal.
  const locked = await api.call('GET', '/portal/dine-in/setup', { headers: { 'x-counter-device': deviceToken } });
  assert.deepEqual([locked.status, locked.body.code], [401, 'counter_locked']);
}));

test('day 30 locks the owner’s tables but not the waiters; no QR ordering means no dine-in setup', () => harness.run(async (api) => {
  const { id, as, owner, mainBranchId } = await setup(api);
  const staff = as((await api.addStaff(id, mainBranchId)).token);
  await api.sql`update dinein.subscriptions set status = 'past_due', past_due_since = now() - interval '31 days' where tenant_id = ${id}`;
  assert.equal((await owner('POST', '/tables', { number: 1, seats: 4, branchId: mainBranchId })).body.code, 'account_paused');
  assert.equal((await staff('POST', '/waiters', { name: 'Bilal', branchId: mainBranchId })).status, 200, 'service carries on');

  await api.sql`update dinein.subscriptions set status = 'active', past_due_since = null where tenant_id = ${id}`;
  await api.sql`insert into dinein.tenant_overrides (tenant_id, feature_key, granted, reason, created_by)
    values (${id}, 'qr_ordering', false, 'Test revoke', 'Test')`;
  const locked = await owner('GET', '/setup');
  assert.deepEqual([locked.status, locked.body.code, locked.body.message], [403, 'feature_locked', 'QR table ordering isn’t on your plan.']);
}));

// /portal/team, PINs and counter PCs (/portal/counters, /counter/*). Every test runs in a
// transaction that is rolled back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openHarness } from './api-harness.js';

const harness = openHarness();
after(() => harness.close());

const email = () => `stage4-${randomUUID()}@example.invalid`;

test('team: invite staff within the plan’s limit, edit, move branch and remove', () => harness.run(async (api) => {
  const { id, ownerToken, ownerId, mainBranchId, detail } = await api.restaurant({ planId: 'starter' });
  const other = await api.addBranch(id);
  const owner = (method, path, body) => api.call(method, `/portal${path}`, { token: ownerToken, body });

  const start = await owner('GET', '/team');
  assert.deepEqual([start.status, start.body.limit, start.body.members.map((m) => m.id)], [200, 3, [ownerId]], 'Starter allows 3 accounts, the owner included');

  const rabiaEmail = email();
  const added = await owner('POST', '/team', { name: 'Rabia Khan', email: rabiaEmail.toUpperCase(), branchId: mainBranchId });
  assert.equal(added.status, 200);
  const rabia = added.body.members.find((member) => member.name === 'Rabia Khan');
  assert.deepEqual([rabia.role, rabia.branchId, rabia.email, rabia.hasPin], ['tenant_staff', mainBranchId, rabiaEmail, false]);
  const invite = api.auth.invited.find((entry) => entry.id === rabia.id);
  assert.deepEqual([invite.role, invite.tenantId, invite.branchId], ['tenant_staff', id, mainBranchId], 'the invite carries the branch in app_metadata');

  assert.deepEqual((await owner('POST', '/team', { name: 'Again', email: rabiaEmail, branchId: mainBranchId })).body.fields, { email: 'This email already has an account.' });
  assert.deepEqual((await owner('POST', '/team', { name: 'Owner twin', email: detail.tenant.ownerEmail, branchId: mainBranchId })).body.fields, { email: 'This email already has an account.' });
  assert.deepEqual((await owner('POST', '/team', { name: 'Elsewhere', email: email(), branchId: randomUUID() })).body.fields, { branchId: 'Choose one of your branches.' });
  assert.equal((await owner('POST', '/team', { name: 'B', email: 'nope', branchId: mainBranchId })).body.code, 'validation_failed');
  assert.equal((await owner('POST', '/team', { name: 'Bilal', email: email(), branchId: mainBranchId })).status, 200);
  const full = await owner('POST', '/team', { name: 'Fourth', email: email(), branchId: mainBranchId });
  assert.deepEqual([full.status, full.body.code], [403, 'limit_reached']);

  // Rabia can use the portal; moving her branch signs her out once (her token names the old branch).
  const rabiaToken = api.staff(id, mainBranchId, rabia.id);
  assert.equal((await api.call('GET', '/portal/me', { token: rabiaToken })).status, 200);
  assert.equal((await api.call('GET', '/portal/team', { token: rabiaToken })).status, 403, 'staff can’t manage the team');
  const moved = await owner('PATCH', `/team/${rabia.id}`, { branchId: other, name: 'Rabia K.' });
  assert.deepEqual([moved.body.members.find((m) => m.id === rabia.id).branchId, moved.body.members.find((m) => m.id === rabia.id).name], [other, 'Rabia K.']);
  const [meta] = await api.sql`select raw_app_meta_data ->> 'branch_id' as branch_id from auth.users where id = ${rabia.id}`;
  assert.equal(meta.branch_id, other);
  assert.equal((await api.call('GET', '/portal/me', { token: rabiaToken })).body.code, 'account_removed');
  assert.equal((await api.call('GET', '/portal/me', { token: api.staff(id, other, rabia.id) })).status, 200);

  assert.deepEqual([(await owner('PATCH', `/team/${ownerId}`, { name: 'Boss' })).status, (await owner('DELETE', `/team/${ownerId}`)).status], [403, 403], 'the owner is managed by the platform team');
  const removed = await owner('DELETE', `/team/${rabia.id}`);
  assert.ok(!removed.body.members.some((m) => m.id === rabia.id));
  assert.ok(api.auth.deleted.includes(rabia.id), 'their login is deleted too');
  assert.equal((await api.call('GET', '/portal/me', { token: api.staff(id, other, rabia.id) })).body.code, 'account_removed');
  assert.equal((await owner('DELETE', `/team/${rabia.id}`)).body.code, 'not_found');
  // The email can be invited again.
  assert.equal((await owner('POST', '/team', { name: 'Rabia Khan', email: rabiaEmail, branchId: mainBranchId })).status, 200);
}));

test('PINs: 4 digits, hashed, and day 30 locks team changes but not PINs or counters', () => harness.run(async (api) => {
  const { id, ownerToken, ownerId, mainBranchId } = await api.restaurant();
  const owner = (method, path, body) => api.call(method, `/portal${path}`, { token: ownerToken, body });
  assert.deepEqual((await owner('PUT', `/team/${ownerId}/pin`, { pin: '12a4' })).body.fields, { pin: 'The PIN is 4 digits.' });
  const set = await owner('PUT', `/team/${ownerId}/pin`, { pin: '2468' });
  assert.equal(set.body.members[0].hasPin, true);
  const [stored] = await api.sql`select pin_hash from dinein.counter_pins where user_id = ${ownerId}`;
  assert.match(stored.pin_hash, /^\$argon2id\$/, 'never stored as typed');
  assert.equal((await owner('PUT', `/team/${ownerId}/pin`, { pin: null })).body.members[0].hasPin, false);
  assert.equal((await owner('PUT', `/team/${randomUUID()}/pin`, { pin: '1111' })).body.code, 'not_found');

  await api.sql`update dinein.subscriptions set status = 'past_due', past_due_since = now() - interval '31 days' where tenant_id = ${id}`;
  assert.equal((await owner('POST', '/team', { name: 'Late hire', email: email(), branchId: mainBranchId })).body.code, 'account_paused');
  assert.equal((await owner('PUT', `/team/${ownerId}/pin`, { pin: '1357' })).status, 200, 'a forgotten PIN can still be reset');
  assert.equal((await owner('POST', '/counters/pairing-codes', { branchId: mainBranchId })).status, 200, 'and a counter paired');
}));

test('counter PCs: a code pairs once, PINs unlock with tries left, one person at a time, unpairing ends it', () => harness.run(async (api) => {
  const { id, ownerToken, ownerId, mainBranchId, detail } = await api.restaurant();
  const other = await api.addBranch(id);
  const owner = (method, path, body) => api.call(method, `/portal${path}`, { token: ownerToken, body });
  const rabia = await api.addStaff(id, mainBranchId, 'Rabia Khan');
  const bilal = await api.addStaff(id, mainBranchId, 'Bilal Ahmed');
  const elsewhere = await api.addStaff(id, other, 'Far Away');

  const made = await owner('POST', '/counters/pairing-codes', { branchId: mainBranchId });
  const { code, expiresAt } = made.body.pairingCodes[0];
  assert.match(code, /^\d{6}$/);
  assert.ok(new Date(expiresAt) - Date.now() <= 15 * 60_000 + 5_000);
  assert.deepEqual((await owner('POST', '/counters/pairing-codes', { branchId: randomUUID() })).body.fields, { branchId: 'Choose one of your branches.' });

  assert.deepEqual((await api.call('POST', '/counter/pair', { body: { code: '000000', name: 'Front counter' } })).body.fields, { code: 'That code is wrong or has expired. Ask the owner for a new one.' });
  assert.ok((await api.call('POST', '/counter/pair', { body: { code, name: 'X' } })).body.fields.name);
  const paired = await api.call('POST', '/counter/pair', { body: { code: `${code.slice(0, 3)} ${code.slice(3)}`, name: 'Front counter' } });
  assert.equal(paired.status, 200);
  assert.match(paired.body.deviceToken, /^[a-f0-9]{64}$/);
  assert.deepEqual([paired.body.session.restaurant.businessName, paired.body.session.branch.id], [detail.tenant.businessName, mainBranchId]);
  assert.equal((await api.call('POST', '/counter/pair', { body: { code, name: 'Second' } })).status, 422, 'a code works once');
  const device = { 'x-counter-device': paired.body.deviceToken };
  const [hash] = await api.sql`select token_hash from dinein.counter_devices where tenant_id = ${id}`;
  assert.notEqual(hash.token_hash, paired.body.deviceToken, 'only the hash is kept');

  for (const person of [rabia, bilal, elsewhere]) await owner('PUT', `/team/${person.id}/pin`, { pin: '1234' });
  await owner('PUT', `/team/${ownerId}/pin`, { pin: '9999' });
  const session = await api.call('GET', '/counter/session', { headers: device });
  assert.deepEqual(session.body.people.map((person) => person.name), ['Bilal Ahmed', 'Rabia Khan', 'Test Owner'], 'branch staff first, then the owner; not other branches');
  assert.equal((await api.call('GET', '/portal/orders', { headers: device })).body.code, 'counter_locked');

  const unlock = (userId, pin) => api.call('POST', '/counter/unlock', { headers: device, body: { userId, pin } });
  assert.equal((await unlock(elsewhere.id, '1234')).body.code, 'not_found', 'another branch’s staff can’t unlock here');
  const wrong = await unlock(rabia.id, '0000');
  assert.deepEqual([wrong.status, wrong.body.code, wrong.body.message], [422, 'wrong_pin', 'Wrong PIN. 4 tries left.']);
  for (let attempt = 0; attempt < 3; attempt += 1) await unlock(rabia.id, '0000');
  assert.equal((await unlock(rabia.id, '0000')).body.message, 'Wrong PIN. Try again in 5 minutes.');
  assert.deepEqual([(await unlock(rabia.id, '1234')).status, (await unlock(rabia.id, '1234')).body.code], [429, 'pin_held'], 'held even with the right PIN');
  await api.sql`update dinein.counter_pins set held_until = now() - interval '1 second' where user_id = ${rabia.id}`;
  const ok = await unlock(rabia.id, '1234');
  assert.deepEqual([ok.status, ok.body.person.name], [200, 'Rabia Khan']);
  const [pins] = await api.sql`select failures, held_until from dinein.counter_pins where user_id = ${rabia.id}`;
  assert.deepEqual([pins.failures, pins.held_until], [0, null]);

  const rabiaAtCounter = { ...device, authorization: `Bearer ${ok.body.staffToken}` };
  assert.equal((await api.call('GET', '/portal/orders', { headers: rabiaAtCounter })).status, 200);
  // Bilal unlocking replaces Rabia: one person at a time.
  const bilalOk = await unlock(bilal.id, '1234');
  assert.equal((await api.call('GET', '/portal/orders', { headers: rabiaAtCounter })).body.code, 'counter_locked');
  const bilalAtCounter = { ...device, authorization: `Bearer ${bilalOk.body.staffToken}` };
  assert.equal((await api.call('GET', '/portal/orders', { headers: bilalAtCounter })).status, 200);
  // A new PIN ends his session at once.
  await owner('PUT', `/team/${bilal.id}/pin`, { pin: '5678' });
  assert.equal((await api.call('GET', '/portal/orders', { headers: bilalAtCounter })).body.code, 'counter_locked');
  const owned = await unlock(ownerId, '9999');
  assert.equal((await api.call('POST', '/counter/lock', { headers: device })).body.ok, true);
  assert.equal((await api.call('GET', '/portal/orders', { headers: { ...device, authorization: `Bearer ${owned.body.staffToken}` } })).body.code, 'counter_locked');

  const listed = await owner('GET', '/counters');
  assert.deepEqual([listed.body.devices.length, listed.body.devices[0].name, listed.body.pairingCodes.length], [1, 'Front counter', 0]);
  assert.equal(listed.body.devices[0].token, undefined);
  const removed = await owner('DELETE', `/counters/${listed.body.devices[0].id}`);
  assert.deepEqual(removed.body.devices, []);
  assert.equal((await api.call('GET', '/counter/session', { headers: device })).body.code, 'device_revoked');
}));

test('counters and team are this restaurant’s only; a suspended restaurant can’t pair', () => harness.run(async (api) => {
  const mine = await api.restaurant();
  const theirs = await api.restaurant();
  const theirStaff = await api.addStaff(theirs.id, theirs.mainBranchId);
  const deviceToken = await api.pairCounter(theirs.ownerToken, theirs.mainBranchId);
  const theirDevice = (await api.call('GET', '/portal/counters', { token: theirs.ownerToken })).body.devices[0];
  const mineOwner = (method, path, body) => api.call(method, `/portal${path}`, { token: mine.ownerToken, body });

  for (const [method, path, body] of [
    ['PATCH', `/team/${theirStaff.id}`, { name: 'Taken' }], ['DELETE', `/team/${theirStaff.id}`],
    ['PUT', `/team/${theirStaff.id}/pin`, { pin: '1111' }], ['DELETE', `/counters/${theirDevice.id}`],
  ]) {
    const response = await mineOwner(method, path, body);
    assert.deepEqual([path, response.status, response.body.code], [path, 404, 'not_found']);
  }
  assert.ok(!(await mineOwner('GET', '/team')).body.members.some((member) => member.id === theirStaff.id));
  assert.deepEqual((await mineOwner('POST', '/counters/pairing-codes', { branchId: theirs.mainBranchId })).body.fields, { branchId: 'Choose one of your branches.' });
  // Their counter can't unlock someone from my restaurant.
  const myStaff = await api.addStaff(mine.id, mine.mainBranchId);
  await mineOwner('PUT', `/team/${myStaff.id}/pin`, { pin: '1234' });
  assert.equal((await api.call('POST', '/counter/unlock', { headers: { 'x-counter-device': deviceToken }, body: { userId: myStaff.id, pin: '1234' } })).body.code, 'not_found');

  const code = (await mineOwner('POST', '/counters/pairing-codes', { branchId: mine.mainBranchId })).body.pairingCodes[0].code;
  await api.call('POST', `/admin/tenants/${mine.id}/status`, { token: api.admin(), body: { status: 'suspended', reason: 'Testing suspension', confirmation: mine.detail.tenant.businessName } });
  const paused = await api.call('POST', '/counter/pair', { body: { code, name: 'Front counter' } });
  assert.deepEqual([paused.status, paused.body.code], [403, 'account_paused']);
}));

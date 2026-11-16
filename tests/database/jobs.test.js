// The daily jobs against the real database (rolled back): the 1st of the month, the
// unpaid ladder, the billing period and the clean-ups. Each runs twice to show a repeat
// changes nothing. The clock is passed in; emails go to a fake sender.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../shared/logger.js';
import { openHarness } from './api-harness.js';

const harness = openHarness();
after(() => harness.close());

const log = createLogger({ environment: 'test', level: 'silent' });
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const UK = { country: 'GB', city: 'London', ownerPhone: '07700 900123' };
const reason = 'Changed in a jobs test';

const mine = (list, ids) => (Array.isArray(list) ? list.filter((item) => ids.includes(item.tenantId)) : list);
const subscription = async (api, id) => (await api.sql`
  select status, past_due_since, plan_id, scheduled_plan_id, current_period_end from dinein.subscriptions where tenant_id = ${id}`)[0];
const lastEvent = async (api, id, action) => (await api.sql`
  select actor, "before", "after", reason from dinein.entitlement_events
  where tenant_id = ${id} and action = ${action} order by created_at desc limit 1`)[0];

/** A restaurant open all day with a dish, a table and a paired counter. */
async function serving(api, overrides = {}) {
  const restaurant = await api.restaurant(overrides);
  const owner = (method, path, body) => api.call(method, `/portal${path}`, { token: restaurant.ownerToken, body });
  await api.openAllDay(restaurant.ownerToken);
  const category = (await owner('POST', '/menu/categories', { name: 'Karahi' })).body.categories[0];
  const dish = (await owner('POST', '/menu/items', {
    categoryId: category.id, name: 'Chicken Karahi', description: '', price: 1100, photoUrl: null, available: true, soldOutUntil: null, options: [],
  })).body.items[0];
  const table = (await owner('POST', '/dine-in/tables', { number: 4, seats: 4, branchId: restaurant.mainBranchId })).body.tables[0];
  const deviceToken = await api.pairCounter(restaurant.ownerToken, restaurant.mainBranchId);
  const diner = (method, path = '', body) => api.call(method, `/public/tables/${table.token}${path}`, { body });
  return { ...restaurant, owner, dish, table, deviceToken, diner };
}

test('the 1st of the month: an active restaurant that did not pay last month is past due from the 1st, once', () => harness.run(async (api) => {
  const unpaid = await api.restaurant();
  const paid = await api.restaurant();
  const trial = await api.restaurant({ startAs: 'trial' });
  const uk = await api.restaurant(UK);
  const ids = [unpaid.id, paid.id, trial.id, uk.id];
  for (const id of [unpaid.id, paid.id, uk.id]) await api.sql`update dinein.subscriptions set billing_starts_at = '2026-10-01T00:00:00Z' where tenant_id = ${id}`;
  await api.sql`insert into dinein.payments (tenant_id, kind, month, amount, method, reference, recorded_by, recorded_at)
    values (${paid.id}, 'monthly', '2026-11-01', 15000, 'cash', '', 'Test', now())`;

  // 8 am in Karachi on 1 December: too early.
  let report = await api.jobs.runDaily({ now: new Date('2026-12-01T03:00:00Z'), log });
  assert.deepEqual(mine(report.billingMonth, ids), []);

  // 10 am in Karachi (5 am in London). A dry run lists it and changes nothing.
  const tenAm = new Date('2026-12-01T05:00:00Z');
  report = await api.jobs.runDaily({ now: tenAm, dryRun: true, log });
  assert.deepEqual(mine(report.billingMonth, ids).map((item) => [item.tenantId, item.month, item.action]), [[unpaid.id, '2026-11', 'past_due']]);
  assert.ok(mine(report.billingMonth, ids)[0].due > 0);
  assert.equal((await subscription(api, unpaid.id)).status, 'active');

  report = await api.jobs.runDaily({ now: tenAm, log });
  assert.deepEqual(mine(report.billingMonth, ids).map((item) => [item.tenantId, item.action]), [[unpaid.id, 'past_due']]);
  const late = await subscription(api, unpaid.id);
  assert.deepEqual([late.status, late.past_due_since.toISOString()], ['past_due', '2026-11-30T19:00:00.000Z'], 'from midnight on the 1st, Karachi time');
  assert.deepEqual({ ...await lastEvent(api, unpaid.id, 'status_changed') },
    { actor: 'System', before: 'Active', after: 'Past due', reason: 'No payment received for November 2026' });
  assert.equal((await subscription(api, paid.id)).status, 'active', 'paid November');
  assert.equal((await subscription(api, trial.id)).status, 'trial', 'trials are a person\'s decision');
  assert.equal((await subscription(api, uk.id)).status, 'active', 'still 5 am in London');

  // Again an hour later: nothing new.
  report = await api.jobs.runDaily({ now: new Date(tenAm.getTime() + HOUR), log });
  assert.deepEqual(mine(report.billingMonth, ids), []);

  // 9:30 am in London: the UK restaurant, from midnight London time.
  report = await api.jobs.runDaily({ now: new Date('2026-12-01T09:30:00Z'), log });
  assert.deepEqual(mine(report.billingMonth, ids).map((item) => item.tenantId), [uk.id]);
  assert.equal((await subscription(api, uk.id)).past_due_since.toISOString(), '2026-12-01T00:00:00.000Z');
}));

test('the unpaid ladder: one email on day 7, 30 and 43, a failed email tried again, skipped steps not sent late', () => harness.run(async (api) => {
  const slow = await api.restaurant();
  // A trial, so the 1st-of-the-month check (which would rightly make an unpaid active
  // restaurant past due on 1 December) leaves it alone until day 43.
  const jumped = await api.restaurant({ startAs: 'trial' });
  const since = new Date('2026-11-30T19:00:00Z');
  await api.sql`update dinein.subscriptions set status = 'past_due', past_due_since = ${since} where tenant_id = ${slow.id}`;
  // `day(n)`: n whole days after, at 10 am Karachi time.
  const day = (n) => new Date(since.getTime() + n * DAY + 10 * HOUR);
  const emails = new Map((await api.sql`select id, owner_email from dinein.tenants where id in (${slow.id}, ${jumped.id})`).map((row) => [row.id, row.owner_email]));
  const sentTo = (restaurant) => api.mailer.sent.filter((message) => message.to === emails.get(restaurant.id)).map((message) => message.subject);
  const run = (n) => api.jobs.runDaily({ now: day(n), log });
  assert.ok(emails.get(slow.id), 'the owner email is on the restaurant');

  await run(6);
  assert.deepEqual(sentTo(slow), []);
  await run(7);
  await run(7);
  assert.equal(sentTo(slow).length, 1, 'never twice');
  assert.match(sentTo(slow)[0], /^Payment reminder: /);
  assert.match(api.mailer.sent.find((message) => message.to === emails.get(slow.id)).text, /7 days overdue/);

  api.mailer.fail = true;
  const failed = await run(30);
  assert.deepEqual(mine(failed.unpaid, [slow.id]).map((item) => item.action), ['email_failed']);
  api.mailer.fail = false;
  await run(31);
  assert.deepEqual(sentTo(slow).length, 2, 'tried again the next day');
  assert.match(sentTo(slow)[1], /setup is locked/);

  // The other restaurant's unpaid period is first seen on day 43 (the server was off, say).
  await api.sql`update dinein.subscriptions set status = 'past_due', past_due_since = ${since} where tenant_id = ${jumped.id}`;
  await run(43);
  assert.match(sentTo(slow)[2], /^Service stops in 2 days/);
  assert.equal((await subscription(api, slow.id)).status, 'past_due', 'day 43 only warns');

  // The other restaurant was only checked on day 43: the 7 and 30 emails are not sent late.
  assert.deepEqual(sentTo(jumped).map((subject) => subject.split(':')[0]), ['Service stops in 2 days']);
}));

test('day 45: suspended by System, open orders cancelled, the table closed, one email, and the counter told', () => harness.run(async (api) => {
  const restaurant = await serving(api);
  const ordered = await restaurant.diner('POST', '/orders', { clientRef: randomUUID(), items: [{ menuItemId: restaurant.dish.id, quantity: 1 }] });
  assert.equal(ordered.status, 200);
  const counter = await api.listen({ type: 'hello', app: 'counter', deviceToken: restaurant.deviceToken });
  await counter.ready();

  const since = new Date('2026-11-30T19:00:00Z');
  await api.sql`update dinein.subscriptions set status = 'past_due', past_due_since = ${since} where tenant_id = ${restaurant.id}`;
  const dayFortyFive = new Date(since.getTime() + 45 * DAY + 10 * HOUR);
  const dry = await api.jobs.runDaily({ now: dayFortyFive, dryRun: true, log });
  assert.deepEqual(mine(dry.unpaid, [restaurant.id]).map((item) => item.action), ['suspend_and_email']);
  assert.equal((await subscription(api, restaurant.id)).status, 'past_due');

  const report = await api.jobs.runDaily({ now: dayFortyFive, log });
  const [done] = mine(report.unpaid, [restaurant.id]);
  assert.deepEqual([done.action, done.emailed, done.orders, done.tables], ['suspended', true, 1, 1]);
  assert.equal((await subscription(api, restaurant.id)).status, 'suspended');
  const [order] = await api.sql`select status, cancelled_by, cancel_reason from dinein.orders where tenant_id = ${restaurant.id}`;
  assert.deepEqual({ ...order }, { status: 'cancelled', cancelled_by: 'System', cancel_reason: 'Account suspended: payment 45 days overdue' });
  const [session] = await api.sql`select status, closed_as, closed_by from dinein.table_sessions where tenant_id = ${restaurant.id}`;
  assert.deepEqual({ ...session }, { status: 'closed', closed_as: 'force_closed', closed_by: 'System' });
  assert.deepEqual({ ...await lastEvent(api, restaurant.id, 'status_changed') },
    { actor: 'System', before: 'Past due', after: 'Suspended', reason: 'Payment 45 days overdue' });
  assert.equal((await counter.event('account.updated')).channel, `branch:${restaurant.mainBranchId}`);

  await api.jobs.runDaily({ now: new Date(dayFortyFive.getTime() + DAY), log });
  const emails = api.mailer.sent.filter((message) => message.subject.startsWith('Service suspended'));
  assert.equal(emails.length, 1, 'one suspension email, and suspended restaurants leave the ladder');
  assert.equal((await api.call('GET', `/public/tables/${restaurant.table.token}`)).body.ordering.state, 'unavailable');
}));

test('the billing period: a waiting downgrade starts at the period end, then a new 30-day period, once', () => harness.run(async (api) => {
  const founder = api.admin();
  const downgrading = await api.restaurant({ planId: 'growth' });
  const longAgo = await api.restaurant();
  const trial = await api.restaurant({ startAs: 'trial' });
  const ids = [downgrading.id, longAgo.id, trial.id];
  const scheduled = await api.call('POST', `/admin/tenants/${downgrading.id}/plan`, { token: founder, body: { planId: 'starter', reason } });
  assert.equal(scheduled.body.subscription.scheduledPlanId, 'starter');

  const end = new Date('2026-12-05T08:00:00Z');
  await api.sql`update dinein.subscriptions set current_period_end = ${end} where tenant_id = ${downgrading.id}`;
  await api.sql`update dinein.subscriptions set current_period_end = ${new Date(end.getTime() - 65 * DAY)} where tenant_id = ${longAgo.id}`;
  await api.sql`update dinein.subscriptions set current_period_end = ${new Date(end.getTime() - DAY)} where tenant_id = ${trial.id}`;

  const before = await api.jobs.runDaily({ now: new Date(end.getTime() - HOUR), log });
  assert.deepEqual(mine(before.billingPeriods, ids).map((item) => item.tenantId), [longAgo.id], 'not yet ended; trials never move');

  const now = new Date(end.getTime() + HOUR);
  const report = await api.jobs.runDaily({ now, log });
  assert.deepEqual(mine(report.billingPeriods, ids).map((item) => [item.tenantId, item.planChanged]), [[downgrading.id, 'starter']]);
  const after = await subscription(api, downgrading.id);
  assert.deepEqual([after.plan_id, after.scheduled_plan_id, after.current_period_end.toISOString()], ['starter', null, '2027-01-04T08:00:00.000Z']);
  assert.deepEqual({ ...await lastEvent(api, downgrading.id, 'plan_changed') },
    { actor: 'System', before: 'Growth', after: 'Starter', reason: 'Scheduled change at the end of the billing period' });
  assert.equal((await subscription(api, longAgo.id)).current_period_end.toISOString(), new Date(end.getTime() + 25 * DAY).toISOString(),
    'a period long past jumps to the next end still ahead');

  const again = await api.jobs.runDaily({ now, log });
  assert.deepEqual(mine(again.billingPeriods, ids), []);
  // A removal now waits for the new end, not the old one.
  assert.equal((await api.call('GET', `/admin/tenants/${downgrading.id}`, { token: founder })).body.subscription.currentPeriodEnd, '2027-01-04T08:00:00.000Z');
}));

test('clean-ups: expired codes, day-old saved requests and unused photos go; anything in use or recent stays', () => harness.run(async (api) => {
  const restaurant = await serving(api);
  const now = new Date();
  const old = new Date(now.getTime() - 25 * HOUR);
  await api.sql`insert into dinein.pairing_codes (code, tenant_id, branch_id, expires_at, created_by) values
    ('900001', ${restaurant.id}, ${restaurant.mainBranchId}, ${new Date(now.getTime() - HOUR)}, 'Test'),
    ('900002', ${restaurant.id}, ${restaurant.mainBranchId}, ${new Date(now.getTime() + HOUR)}, 'Test')`;
  const caller = `device:${randomUUID()}`;
  await api.sql`insert into dinein.idempotency_keys (tenant_id, caller, key, request_hash, response, created_at) values
    (${restaurant.id}, ${caller}, 'old-key-123', ${'a'.repeat(64)}, '{}'::jsonb, ${old}),
    (${restaurant.id}, ${caller}, 'new-key-123', ${'b'.repeat(64)}, '{}'::jsonb, ${now})`;
  const oldRef = `old-${randomUUID()}`;
  const newRef = `new-${randomUUID()}`;
  for (const clientRef of [oldRef, newRef]) {
    const placed = await restaurant.diner('POST', '/orders', { clientRef, items: [{ menuItemId: restaurant.dish.id, quantity: 1 }] });
    assert.equal(placed.status, 200);
  }
  await api.sql`update dinein.diner_order_refs set created_at = ${old} where client_ref = ${oldRef}`;

  const twoDaysAgo = new Date(now.getTime() - 2 * DAY);
  const usedUrl = await api.photos.upload(`${restaurant.id}/old-used.jpg`, Buffer.alloc(1), twoDaysAgo);
  await api.photos.upload(`${restaurant.id}/old-unused.jpg`, Buffer.alloc(1), twoDaysAgo);
  await api.photos.upload(`${restaurant.id}/new-unused.jpg`, Buffer.alloc(1), new Date(now.getTime() - HOUR));
  await api.photos.upload('not-a-restaurant/stray.jpg', Buffer.alloc(1), twoDaysAgo);
  await api.sql`update dinein.menu_items set photo_url = ${usedUrl} where id = ${restaurant.dish.id}`;

  const codes = async () => (await api.sql`select code from dinein.pairing_codes where code in ('900001', '900002') order by code`).map((row) => row.code);
  const keys = async () => (await api.sql`select key from dinein.idempotency_keys where caller = ${caller} order by key`).map((row) => row.key);
  const refs = async () => (await api.sql`select client_ref from dinein.diner_order_refs where client_ref in (${oldRef}, ${newRef})`).map((row) => row.client_ref);

  const dry = await api.jobs.runDaily({ now, dryRun: true, log });
  assert.ok(dry.cleanUp.pairing_codes >= 1 && dry.cleanUp.idempotency_keys >= 1 && dry.cleanUp.diner_order_refs >= 1);
  assert.deepEqual(dry.cleanUp.photos, { checked: 2, unused: 1 });
  assert.deepEqual([await codes(), await keys(), (await refs()).length, api.photos.removed], [['900001', '900002'], ['new-key-123', 'old-key-123'], 2, []]);

  await api.jobs.runDaily({ now, log });
  assert.deepEqual(await codes(), ['900002']);
  assert.deepEqual(await keys(), ['new-key-123']);
  assert.deepEqual(await refs(), [newRef]);
  assert.deepEqual(api.photos.removed, [`${restaurant.id}/old-unused.jpg`]);
  const [{ orders }] = await api.sql`select count(*)::int as orders from dinein.orders where tenant_id = ${restaurant.id}`;
  assert.equal(orders, 2, 'orders themselves are never cleaned up');
}));

// /admin/tenants/:id plan, status and payments. Every test runs in a transaction that is rolled back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openHarness } from './api-harness.js';
import { monthKey } from '../../shared/time.js';

const harness = openHarness();
after(() => harness.close());

const reason = 'Agreed on the phone';
const actions = (detail) => detail.events.map((event) => event.action);

/** A seated table with one new and one accepted order, as diners will make in Stage 4. */
async function seatParty(api, tenantId, branchId) {
  const [waiter] = await api.sql`insert into dinein.waiters (tenant_id, branch_id, name) values (${tenantId}, ${branchId}, 'Shahid') returning id`;
  const [table] = await api.sql`insert into dinein.dining_tables (tenant_id, branch_id, number, seats, token)
    values (${tenantId}, ${branchId}, 7, 4, ${randomBytes(12).toString('hex')}) returning id`;
  const [session] = await api.sql`insert into dinein.table_sessions (tenant_id, branch_id, table_id, waiter_id)
    values (${tenantId}, ${branchId}, ${table.id}, ${waiter.id}) returning id`;
  const items = api.sql.json([{ name: 'Chicken Karahi', quantity: 1, unitPrice: 1100 }]);
  for (const [number, status] of [[1200, 'new'], [1201, 'accepted']]) {
    await api.sql`insert into dinein.orders (number, business_day, tenant_id, branch_id, table_number, table_id, session_id, waiter_id,
        items, total, status, source, entered_by)
      values (${number}, current_date, ${tenantId}, ${branchId}, 7, ${table.id}, ${session.id}, ${status === 'accepted' ? waiter.id : null},
        ${items}, 1100, ${status}, 'qr', 'customer')`;
  }
  await api.sql`insert into dinein.service_requests (tenant_id, branch_id, table_id, table_number, session_id, kind)
    values (${tenantId}, ${branchId}, ${table.id}, 7, ${session.id}, 'water')`;
  return { sessionId: session.id };
}

test('plan changes: upgrades apply now, downgrades wait for the period end, and can be cancelled', () => harness.run(async (api) => {
  const { id } = await api.restaurant({ planId: 'growth', startAs: 'active' });
  const founder = api.admin();
  const plan = (planId, body = {}) => api.call('POST', `/admin/tenants/${id}/plan`, { token: founder, body: { planId, reason, ...body } });

  assert.equal((await plan('growth')).body.code, 'same_plan');
  assert.equal((await plan('platinum')).body.code, 'invalid_plan');
  assert.equal((await plan('pro', { reason: 'ok' })).body.code, 'reason_required');

  const up = await plan('pro');
  assert.deepEqual([up.status, up.body.subscription.planId, up.body.subscription.scheduledPlanId], [200, 'pro', null]);
  assert.ok(actions(up.body).includes('plan_changed'));

  const down = await plan('starter');
  assert.deepEqual([down.body.subscription.planId, down.body.subscription.scheduledPlanId], ['pro', 'starter'], 'paid for this month: waits');
  const scheduled = down.body.events.find((event) => event.action === 'plan_change_scheduled');
  assert.match(scheduled.after, /^Starter from [A-Z][a-z]{2} \d{1,2}$/);

  // Choosing the current plan again cancels the waiting downgrade.
  const keep = await plan('pro');
  assert.deepEqual([keep.status, keep.body.subscription.scheduledPlanId], [200, null]);

  const cancel = (body) => api.call('DELETE', `/admin/tenants/${id}/plan/scheduled`, { token: founder, body });
  assert.equal((await cancel({ reason })).body.code, 'nothing_scheduled');
  await plan('growth');
  const cancelled = await cancel({ reason });
  assert.deepEqual([cancelled.status, cancelled.body.subscription.scheduledPlanId], [200, null]);
  assert.equal(cancelled.body.events[0].action, 'plan_change_cancelled');
  assert.equal(cancelled.body.events[0].after, 'Stays on Pro');
}));

test('a downgrade during a trial applies at once, and add-ons the new plan lacks stop', () => harness.run(async (api) => {
  const { id } = await api.restaurant({ planId: 'starter', startAs: 'trial', addons: [{ addonId: 'extra_station', quantity: 1 }] });
  const founder = api.admin();
  const up = await api.call('POST', `/admin/tenants/${id}/plan`, { token: founder, body: { planId: 'growth', reason } });
  assert.equal(up.body.subscription.planId, 'growth');
  assert.deepEqual(up.body.addons.map((addon) => addon.addonId), [], 'Growth includes stations, so the add-on ends');

  const down = await api.call('POST', `/admin/tenants/${id}/plan`, { token: founder, body: { planId: 'starter', reason } });
  assert.deepEqual([down.body.subscription.planId, down.body.subscription.scheduledPlanId], ['starter', null], 'a trial changes at once');
}));

test('status: activating starts billing, past due starts the ladder, suspending needs the name and stops service', () => harness.run(async (api) => {
  const { id, detail, mainBranchId, ownerToken } = await api.restaurant({ planId: 'growth', startAs: 'trial' });
  const founder = api.admin();
  const status = (body) => api.call('POST', `/admin/tenants/${id}/status`, { token: founder, body: { reason, ...body } });

  assert.equal((await status({ status: 'trial' })).body.code, 'same_status');
  assert.equal((await status({ status: 'frozen' })).body.code, 'invalid_status');

  const active = await status({ status: 'active' });
  assert.ok(active.body.subscription.billingStartsAt, 'trial to active starts billing today');
  assert.equal(active.body.subscription.trialEndsAt, null);

  const pastDue = await status({ status: 'past_due' });
  assert.ok(pastDue.body.subscription.pastDueSince);

  const { sessionId } = await seatParty(api, id, mainBranchId);
  const wrongName = await status({ status: 'suspended', confirmation: 'Some other name' });
  assert.deepEqual([wrongName.status, wrongName.body.code], [422, 'confirmation_mismatch']);

  const suspended = await status({ status: 'suspended', confirmation: ` ${detail.tenant.businessName} ` });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.subscription.status, 'suspended');
  assert.equal(suspended.body.subscription.pastDueSince, pastDue.body.subscription.pastDueSince, 'suspending keeps the ladder date');
  const event = suspended.body.events.find((entry) => entry.action === 'status_changed');
  assert.deepEqual([event.before, event.after], ['Past due', 'Suspended']);

  // The founders' rule: nothing is left open when a restaurant is suspended.
  const orders = await api.sql`select status, cancelled_by, cancel_reason, finished_at from dinein.orders where tenant_id = ${id}`;
  assert.ok(orders.every((order) => order.status === 'cancelled' && order.cancelled_by === 'System' && order.finished_at));
  assert.match(orders[0].cancel_reason, /suspended/);
  const [session] = await api.sql`select status, closed_as, closed_by from dinein.table_sessions where id = ${sessionId}`;
  assert.deepEqual([session.status, session.closed_as, session.closed_by], ['closed', 'force_closed', 'System']);
  const [request] = await api.sql`select handled_by from dinein.service_requests where session_id = ${sessionId}`;
  assert.equal(request.handled_by, 'System');

  // A suspended restaurant can look but not change anything.
  assert.equal((await api.call('GET', '/portal/menu', { token: ownerToken })).status, 200);
  const write = await api.call('POST', '/portal/menu/categories', { token: ownerToken, body: { name: 'Starters' } });
  assert.deepEqual([write.status, write.body.code], [403, 'account_paused']);

  const back = await status({ status: 'active' });
  assert.deepEqual([back.body.subscription.status, back.body.subscription.pastDueSince], ['active', null]);
}));

test('payments: this month once, the setup fee once, references, and the ladder ends but a suspension stays', () => harness.run(async (api) => {
  const { id, detail } = await api.restaurant({ planId: 'starter', startAs: 'active' });
  const founder = api.admin();
  const month = monthKey(new Date(), 'Asia/Karachi');
  const pay = (body) => api.call('POST', `/admin/tenants/${id}/payments`, { token: founder, body: { month, amount: 15000, method: 'cash', reference: '', ...body } });

  assert.equal((await pay({ month: monthKey(new Date(), 'Asia/Karachi', -1) })).body.code, 'closed_month');
  assert.equal((await pay({ method: 'bitcoin' })).body.code, 'invalid_method');
  assert.equal((await pay({ amount: 0 })).body.code, 'invalid_amount');
  assert.equal((await pay({ amount: 12.5 })).body.code, 'invalid_amount');
  assert.equal((await pay({ method: 'bank_transfer' })).body.code, 'invalid_reference', 'only cash may have no reference');
  assert.equal((await pay({ reference: 'x'.repeat(61) })).body.code, 'invalid_reference');

  // Past due, then paid: back to active.
  await api.call('POST', `/admin/tenants/${id}/status`, { token: founder, body: { status: 'past_due', reason } });
  const paid = await pay({ method: 'easypaisa', reference: 'EP-123456' });
  assert.equal(paid.status, 200);
  assert.deepEqual([paid.body.subscription.status, paid.body.subscription.pastDueSince], ['active', null]);
  assert.deepEqual(paid.body.payments.map((payment) => [payment.kind, payment.month, payment.amount, payment.method, payment.reference]),
    [['monthly', month, 15000, 'easypaisa', 'EP-123456']]);
  const recorded = paid.body.events.find((event) => event.action === 'payment_recorded');
  assert.deepEqual([recorded.after, recorded.reason], ['PKR 15,000 via Easypaisa (EP-123456)', `Payment for ${month}`]);
  assert.ok(actions(paid.body).includes('status_changed'));
  assert.equal((await pay({})).body.code, 'already_paid');

  const setup = await pay({ kind: 'setup', amount: 30000 });
  assert.equal(setup.status, 200);
  assert.equal((await pay({ kind: 'setup', amount: 30000 })).body.code, 'already_paid');

  // Paying never lifts a suspension (the founders' rule): the team reactivates by hand.
  const other = await api.restaurant({ planId: 'starter', startAs: 'active' });
  await api.call('POST', `/admin/tenants/${other.id}/status`, { token: founder, body: { status: 'suspended', reason, confirmation: other.detail.tenant.businessName } });
  const stillSuspended = await api.call('POST', `/admin/tenants/${other.id}/payments`, { token: founder, body: { month, amount: 15000, method: 'cash', reference: '' } });
  assert.equal(stillSuspended.body.subscription.status, 'suspended');
  assert.equal(detail.tenant.currency, 'PKR');
}));

test('plan, status and payment writes are refused for a restaurant outside the person’s scope', () => harness.run(async (api) => {
  const { id } = await api.restaurant();
  const partner = api.admin({ role: 'partner', countries: ['GB'], partnerId: randomUUID() });
  const month = monthKey(new Date(), 'Asia/Karachi');
  for (const [method, path, body] of [
    ['POST', 'plan', { planId: 'pro', reason }],
    ['DELETE', 'plan/scheduled', { reason }],
    ['POST', 'status', { status: 'past_due', reason }],
    ['POST', 'payments', { month, amount: 100, method: 'cash', reference: '' }],
    ['PATCH', 'onboarding', { stepId: 'menu', done: true }],
  ]) {
    const response = await api.call(method, `/admin/tenants/${id}/${path}`, { token: partner, body });
    assert.deepEqual([path, response.status, response.body.code], [path, 404, 'tenant_not_found']);
  }
  const [row] = await api.sql`select plan_id, status from dinein.subscriptions where tenant_id = ${id}`;
  assert.deepEqual([row.plan_id, row.status], ['growth', 'active'], 'nothing changed');
}));

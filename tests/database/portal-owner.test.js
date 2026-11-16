// The owner's figures: dashboard, daily summary, void log, cash close, branches, reports,
// billing. Orders are written directly with exact days and times. Every test is rolled back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openHarness } from './api-harness.js';
import { dayKey, monthKey, startOfLocalDay } from '../../shared/time.js';

const harness = openHarness();
after(() => harness.close());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const item = (name, quantity, unitPrice) => ({ name, quantity, unitPrice });
let number = 1200;

/** An order on a given restaurant day; `at` is when it was placed. */
async function order(api, tenantId, branchId, { at = new Date(), status = 'served', total = 1000, items, source = 'qr', timeZone = 'Asia/Karachi', session = null, cancelReason, cancelledBy } = {}) {
  number += 1;
  const lines = items ?? [item('Chicken Karahi', 1, total)];
  const cancelled = status === 'cancelled';
  const [row] = await api.sql`insert into dinein.orders (number, business_day, tenant_id, branch_id, table_number, table_id, session_id,
      items, total, status, source, entered_by, entered_by_name, cancel_reason, cancelled_by, created_at, finished_at)
    values (${number}, ${dayKey(at, timeZone)}::date, ${tenantId}, ${branchId}, ${session?.number ?? null}, ${session?.tableId ?? null}, ${session?.id ?? null},
      ${api.sql.json(lines)}, ${total}, ${status}, ${source}, ${source === 'qr' ? 'customer' : 'staff'}, ${source === 'qr' ? null : 'Rabia Khan'},
      ${cancelled ? cancelReason ?? 'Diner asked to cancel' : null}, ${cancelled ? cancelledBy ?? 'Rabia Khan' : null},
      ${at}, ${['served', 'cancelled'].includes(status) ? at : null})
    returning id`;
  return row.id;
}

async function table(api, tenantId, branchId, tableNumber) {
  const [row] = await api.sql`insert into dinein.dining_tables (tenant_id, branch_id, number, seats, token)
    values (${tenantId}, ${branchId}, ${tableNumber}, 4, ${randomBytes(12).toString('hex')}) returning id`;
  return row.id;
}

/** A party already settled: paid in a way, or closed without payment. */
async function settled(api, tenantId, branchId, tableNumber, close) {
  const tableId = await table(api, tenantId, branchId, tableNumber);
  const [row] = await api.sql`insert into dinein.table_sessions (tenant_id, branch_id, table_id, status, closed_at, closed_as, paid_by, amount_paid, closed_by, close_reason)
    values (${tenantId}, ${branchId}, ${tableId}, 'closed', now(), ${close.as}, ${close.paidBy ?? null}, ${close.amount ?? null}, 'Rabia Khan', ${close.reason ?? null})
    returning id`;
  return { id: row.id, tableId, number: tableNumber };
}

test('the dashboard and the daily summary add up today, against yesterday and the same day last week', () => harness.run(async (api) => {
  const { id, mainBranchId, ownerToken } = await api.restaurant({ planId: 'growth', startAs: 'active' });
  const now = new Date();
  await order(api, id, mainBranchId, { total: 1000, items: [item('Chicken Karahi', 1, 1000)] });
  await order(api, id, mainBranchId, { total: 500, items: [item('Naan', 5, 100)], source: 'staff' });
  await order(api, id, mainBranchId, { status: 'cancelled', total: 300 });
  await order(api, id, mainBranchId, { status: 'new', total: 200 });
  await order(api, id, mainBranchId, { at: new Date(now.getTime() - DAY), total: 800 });
  // Earlier on the same day last week: halfway between its midnight and this time of day
  // (a fixed hour earlier falls on the day before when the test runs just after midnight).
  const sameTimeLastWeek = new Date(now.getTime() - 7 * DAY);
  const lastWeekMidnight = startOfLocalDay(sameTimeLastWeek, 'Asia/Karachi').getTime();
  await order(api, id, mainBranchId, { at: new Date((lastWeekMidnight + sameTimeLastWeek.getTime()) / 2), total: 600 });
  await order(api, id, mainBranchId, { at: new Date(now.getTime() - 7 * DAY + HOUR), total: 9999 });
  const owner = (path) => api.call('GET', `/portal${path}`, { token: ownerToken });

  const dashboard = await owner('/dashboard');
  assert.equal(dashboard.status, 200);
  // The new order counts too: it isn't cancelled.
  assert.deepEqual(dashboard.body.today, { orders: 3, ordersYesterday: 1, revenue: 1700, revenueYesterday: 800, averageOrderValue: 567, waiting: 1, inProgress: 0 });
  assert.deepEqual(dashboard.body.topItems.slice(0, 2).map((row) => [row.name, row.quantity, row.revenue]), [['Naan', 5, 500], ['Chicken Karahi', 2, 1200]]);
  assert.equal(dashboard.body.activeOrders.length, 1);
  assert.deepEqual(dashboard.body.usage.map((meter) => [meter.key, meter.used, meter.limit]), [['tables', 0, 20], ['staff_accounts', 1, 6]]);
  assert.deepEqual(dashboard.body.upgradeSignals, [], 'Growth has stations and time menus');
  assert.deepEqual(dashboard.body.setup.steps.map((step) => step.id), ['menu', 'tables', 'time_menus', 'go_live']);
  assert.ok(dashboard.body.ordersByHour.length >= 1);

  const summary = await owner('/daily-summary');
  assert.deepEqual([summary.body.sales, summary.body.orders, summary.body.averageOrder], [1700, 3, 567]);
  assert.deepEqual(summary.body.lastWeek, { sales: 600, orders: 1 }, 'today is compared with last week up to the same time');
  assert.deepEqual(summary.body.voids, { count: 1, amount: 300 });
  assert.match(summary.body.shareText, /^\*Stage3 Test .+\* · /);
  assert.match(summary.body.shareText, /Sales PKR 1,700 · 3 orders · average PKR 567/);
  assert.match(summary.body.shareText, /Cash count: not done yet/);
  const yesterday = await owner(`/daily-summary?day=${dayKey(new Date(now.getTime() - DAY), 'Asia/Karachi')}`);
  assert.deepEqual([yesterday.body.sales, yesterday.body.orders], [800, 1]);
  assert.equal((await owner('/daily-summary?day=2001-01-01')).body.day, dayKey(now, 'Asia/Karachi'), 'only the last 7 days');

  const starter = await api.restaurant({ planId: 'starter' });
  const pitch = await api.call('GET', '/portal/dashboard', { token: starter.ownerToken });
  assert.deepEqual(pitch.body.upgradeSignals.map((signal) => signal.featureKey), ['time_menus']);
  const staff = await api.addStaff(id, mainBranchId);
  assert.equal((await api.call('GET', '/portal/dashboard', { token: staff.token })).status, 403, 'figures are the owner’s');
}));

test('the void log and the cash close: who voided what, and the drawer against the counter', () => harness.run(async (api) => {
  const { id, mainBranchId, ownerToken } = await api.restaurant({ planId: 'growth' });
  const left = await settled(api, id, mainBranchId, 1, { as: 'force_closed', reason: 'Party left without paying' });
  await order(api, id, mainBranchId, { session: left, total: 700, items: [item('Mutton Karahi', 1, 700)] });
  await order(api, id, mainBranchId, { session: left, status: 'cancelled', total: 200, items: [item('Naan', 2, 100)], cancelReason: 'Table closed: Party left without paying' });
  await order(api, id, mainBranchId, { status: 'cancelled', total: 300, items: [item('Raita', 3, 100)], cancelReason: 'Ordered twice by mistake', cancelledBy: 'Bilal Ahmed' });
  await settled(api, id, mainBranchId, 2, { as: 'paid', paidBy: 'cash', amount: 1200 });
  await settled(api, id, mainBranchId, 3, { as: 'paid', paidBy: 'card', amount: 400 });
  const owner = (method, path, body) => api.call(method, `/portal${path}`, { token: ownerToken, body });

  const log = await owner('GET', '/void-log');
  assert.deepEqual(log.body.entries.map((entry) => [entry.kind, entry.amount, entry.by]).sort(), [
    ['order_cancelled', 300, 'Bilal Ahmed'], ['table_force_closed', 900, 'Rabia Khan'],
  ].sort(), 'an order cancelled by closing its table counts once, under the table');
  const closedTable = log.body.entries.find((entry) => entry.kind === 'table_force_closed');
  assert.deepEqual([closedTable.table, closedTable.items, closedTable.reason], [1, '1× Mutton Karahi, 2× Naan', 'Party left without paying']);
  assert.deepEqual(log.body.totals, { count: 2, amount: 1200 });
  // Most voids first; equal counts, the larger amount first.
  assert.deepEqual(log.body.byPerson.map((person) => [person.name, person.count, person.amount]), [['Rabia Khan', 1, 900], ['Bilal Ahmed', 1, 300]]);

  const day = await owner('GET', '/cash-close');
  assert.deepEqual([day.body.payments.cash, day.body.payments.card, day.body.payments.wallet, day.body.expectedCash, day.body.openTables, day.body.record],
    [{ count: 1, amount: 1200 }, { count: 1, amount: 400 }, { count: 0, amount: 0 }, 1200, 0, null]);
  const short = await owner('POST', '/cash-close', { branchId: mainBranchId, countedCash: 1100 });
  assert.deepEqual(short.body.fields, { note: 'The count doesn’t match. Say why, for the record.' });
  const counted = await owner('POST', '/cash-close', { branchId: mainBranchId, countedCash: 1100, note: 'Change given wrong' });
  assert.deepEqual([counted.body.record.difference, counted.body.record.note, counted.body.record.closedBy], [-100, 'Change given wrong', 'Test Owner']);
  const recount = await owner('POST', '/cash-close', { branchId: mainBranchId, countedCash: 1200 });
  assert.deepEqual([recount.body.record.difference, recount.body.history], [0, []], 'a recount replaces the count');
  assert.equal((await owner('POST', '/cash-close', { branchId: randomUUID(), countedCash: 5 })).body.fields.branchId, 'Choose one of your branches.');
  // Covering every branch, the message names the branch.
  assert.match((await owner('GET', '/daily-summary')).body.shareText, /Cash count Main branch: exact \(Test Owner\)/);
}));

test('branches side by side, and reports by month, weekday and hour in the restaurant’s own time zone', () => harness.run(async (api) => {
  const pk = await api.restaurant({ planId: 'growth', startAs: 'active' });
  await api.call('POST', `/admin/tenants/${pk.id}/addons`, { token: api.admin(), body: { addonId: 'extra_branch', reason: 'Second branch sold' } });
  const second = (await api.call('POST', `/admin/tenants/${pk.id}/branches`, { token: api.admin(), body: { name: 'Blue Area', area: 'Islamabad', reason: 'Second branch sold' } }))
    .body.branches.find((branch) => branch.name === 'Blue Area');
  await order(api, pk.id, pk.mainBranchId, { total: 1000 });
  await order(api, pk.id, second.id, { total: 400 });
  await order(api, pk.id, second.id, { status: 'new', total: 100 });
  const overview = await api.call('GET', '/portal/branches', { token: pk.ownerToken });
  assert.deepEqual(overview.body.branches.map((row) => [row.branch.name, row.sales, row.orders, row.waiting]), [['Main branch', 1000, 1, 0], ['Blue Area', 500, 2, 1]]);

  // Joined three months ago, with an order on the 1st of this month and of last month.
  await api.sql`update dinein.tenants set created_at = now() - interval '95 days' where id = ${pk.id}`;
  const thisMonth = monthKey(new Date(), 'Asia/Karachi');
  const lastMonth = monthKey(new Date(), 'Asia/Karachi', -1);
  await order(api, pk.id, pk.mainBranchId, { at: new Date(`${thisMonth}-01T07:00:00Z`), total: 250, source: 'staff' });
  await order(api, pk.id, pk.mainBranchId, { at: new Date(`${lastMonth}-01T07:00:00Z`), total: 750 });
  const report = await api.call('GET', '/portal/reports', { token: pk.ownerToken });
  assert.equal(report.status, 200);
  assert.deepEqual([report.body.month, report.body.partial, report.body.months.length >= 4], [thisMonth, true, true]);
  // 1000 + 400 + 100 (new, not cancelled) + 250 this month.
  assert.deepEqual([report.body.summary.orders, report.body.summary.revenue], [4, 1750]);
  assert.equal(report.body.previous.revenue, 750, 'the same days of last month');
  assert.deepEqual(report.body.trend.slice(-2).map((row) => [row.month, row.revenue]), [[lastMonth, 750], [thisMonth, 1750]]);
  assert.equal(report.body.weekdays.length, 7);
  assert.deepEqual(report.body.sources.map((row) => row.source), ['qr', 'staff']);
  assert.deepEqual(report.body.branches.map((row) => [row.name, row.revenue]), [['Main branch', 1250], ['Blue Area', 500]]);
  const narrowed = await api.call('GET', `/portal/reports?branch=${second.id}`, { token: pk.ownerToken });
  assert.deepEqual([narrowed.body.summary.revenue, narrowed.body.branches], [500, []]);
  const old = await api.call('GET', `/portal/reports?month=${lastMonth}`, { token: pk.ownerToken });
  assert.deepEqual([old.body.month, old.body.partial, old.body.summary.revenue], [lastMonth, false, 750]);

  // 23:30 in London is 04:30 in Karachi: hours follow the restaurant's own clock.
  const uk = await api.restaurant({ country: 'GB', city: 'London', ownerPhone: '07700 900123' });
  await api.sql`update dinein.tenants set created_at = now() - interval '40 days' where id = ${uk.id}`;
  const lateNight = new Date(`${monthKey(new Date(), 'Europe/London')}-01T23:30:00Z`);
  await order(api, uk.id, uk.mainBranchId, { at: lateNight, total: 25, timeZone: 'Europe/London' });
  const ukReport = await api.call('GET', '/portal/reports', { token: uk.ownerToken });
  const hour = ukReport.body.hours.find((row) => row.orders > 0)?.hour;
  assert.ok(hour === 23 || hour === 0, `London hour, not Karachi's (got ${hour})`);

  // Reports lock from day 30 of non-payment.
  await api.sql`update dinein.subscriptions set status = 'past_due', past_due_since = now() - interval '31 days' where tenant_id = ${pk.id}`;
  const locked = await api.call('GET', '/portal/reports', { token: pk.ownerToken });
  assert.deepEqual([locked.status, locked.body.code], [403, 'feature_locked']);
}));

test('billing shows what they pay and what was received; another restaurant’s branch is never used', () => harness.run(async (api) => {
  const { id, ownerToken, detail } = await api.restaurant({ planId: 'starter', startAs: 'active', addons: [{ addonId: 'extra_tables', quantity: 2 }] });
  const month = monthKey(new Date(), 'Asia/Karachi');
  await api.call('POST', `/admin/tenants/${id}/payments`, { token: api.admin(), body: { month, amount: 17000, method: 'cash', reference: '' } });
  const billing = await api.call('GET', '/portal/billing', { token: ownerToken });
  assert.deepEqual([billing.body.plan, billing.body.monthlyTotal], [{ id: 'starter', name: 'Starter', monthlyPrice: 15000 }, 17000]);
  assert.deepEqual(billing.body.addons.map((addon) => [addon.id, addon.quantity, addon.monthlyPrice]), [['extra_tables', 2, 2000]]);
  assert.deepEqual(billing.body.months, [{ month, payment: { amount: 17000, method: 'cash', recordedAt: billing.body.months[0].payment.recordedAt } }]);
  const trial = await api.restaurant({ planId: 'growth', startAs: 'trial' });
  assert.deepEqual((await api.call('GET', '/portal/billing', { token: trial.ownerToken })).body.months, [], 'nothing is billed during a trial');

  // Another restaurant's branch id changes nothing: their figures never appear.
  const theirs = await api.restaurant();
  await order(api, theirs.id, theirs.mainBranchId, { total: 5555 });
  await order(api, theirs.id, theirs.mainBranchId, { status: 'cancelled', total: 4444 });
  for (const path of ['/dashboard', '/void-log', '/daily-summary', '/reports', '/cash-close']) {
    const response = await api.call('GET', `/portal${path}?branch=${theirs.mainBranchId}`, { token: ownerToken });
    assert.equal(response.status, 200, path);
    assert.ok(!JSON.stringify(response.body).includes('5555') && !JSON.stringify(response.body).includes('4444'), `${path} shows nothing of theirs`);
  }
  assert.equal((await api.call('POST', '/portal/cash-close', { token: ownerToken, body: { branchId: theirs.mainBranchId, countedCash: 0 } })).status, 422);
  assert.equal(detail.tenant.currency, 'PKR');
}));

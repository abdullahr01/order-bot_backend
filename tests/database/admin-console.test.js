// The rest of the platform console: add-ons, overrides, branches, price lists, the history
// log, upgrade requests, the dashboard, the monthly audit and partners. Rolled back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { FOUNDER, openHarness } from './api-harness.js';
import { monthKey } from '../../shared/time.js';

const harness = openHarness();
after(() => harness.close());

const reason = 'Agreed with the owner';
const UK = { country: 'GB', city: 'London', ownerPhone: '07700 900123' };
const limitOf = (detail, key) => detail.access.limits.find((limit) => limit.key === key).value;
const feature = (detail, key) => detail.access.features.find((entry) => entry.key === key);

async function addTables(api, tenantId, branchId, count) {
  await api.sql`insert into dinein.dining_tables (tenant_id, branch_id, number, seats, token)
    select ${tenantId}, ${branchId}, n, 4, ${randomBytes(6).toString('hex')} || lpad(n::text, 4, '0') from generate_series(1, ${count}) n`;
}

test('add-ons: add, add more, never below what is in use, removed at the period end, and kept going', () => harness.run(async (api) => {
  const { id, mainBranchId } = await api.restaurant({ planId: 'starter', startAs: 'active' });
  const founder = api.admin();
  const addon = (method, path, body) => api.call(method, `/admin/tenants/${id}/addons${path}`, { token: founder, body: { reason, ...body } });

  assert.equal((await addon('POST', '', { addonId: 'extra_tables', quantity: 3 })).status, 200);
  const more = await addon('POST', '', { addonId: 'extra_tables', quantity: 2 });
  assert.deepEqual([more.body.addons[0].quantity, limitOf(more.body, 'tables')], [5, 15], 'adding an active add-on adds to its quantity');
  assert.equal(more.body.events[0].after, 'Extra tables × 5');
  assert.equal((await addon('POST', '', { addonId: 'extra_station' })).status, 200, 'Starter offers extra stations');
  assert.equal((await addon('POST', '', { addonId: 'nope' })).body.code, 'invalid_addon');

  await addTables(api, id, mainBranchId, 12);
  const lower = await addon('PATCH', '/extra_tables', { quantity: 1 });
  assert.deepEqual([lower.status, lower.body.code, lower.body.message], [409, 'in_use', '12 tables are in use. The restaurant must retire some before the number bought is lowered.']);
  assert.equal((await addon('PATCH', '/extra_tables', { quantity: 5 })).body.code, 'no_changes');
  assert.equal(limitOf((await addon('PATCH', '/extra_tables', { quantity: 2 })).body, 'tables'), 12);
  assert.equal((await addon('PATCH', '/extra_staff', { quantity: 2 })).body.code, 'addon_not_active');

  const removed = await addon('DELETE', '/extra_station');
  const station = removed.body.addons.find((entry) => entry.addonId === 'extra_station');
  assert.ok(station.cancelsAt, 'keeps working until the end of the paid period');
  assert.equal(removed.body.events[0].action, 'addon_removed');
  const kept = await addon('POST', '', { addonId: 'extra_station' });
  assert.equal(kept.body.addons.find((entry) => entry.addonId === 'extra_station').cancelsAt, null, 'adding it again keeps it going');

  const growth = await api.restaurant({ planId: 'growth' });
  assert.equal((await api.call('POST', `/admin/tenants/${growth.id}/addons`, { token: founder, body: { addonId: 'extra_station', reason } })).body.code, 'addon_unavailable');
}));

test('overrides: grant a feature, set a limit, the newest wins, dependencies, expiry, never partners', () => harness.run(async (api) => {
  const partnerId = (await api.sql`insert into dinein.partners (name, countries, contact_name, contact_email)
    values ('Test Partner Ltd', ${['GB']}, 'Contact', 'p@example.invalid') returning id`)[0].id;
  const { id } = await api.restaurant({ planId: 'starter' });
  const founder = api.admin();
  const override = (body, token = founder) => api.call('POST', `/admin/tenants/${id}/overrides`, { token, body: { reason, expiresAt: null, ...body } });

  const granted = await override({ kind: 'feature', featureKey: 'time_menus', granted: true });
  assert.equal(feature(granted.body, 'time_menus').enabled, true);
  assert.deepEqual([granted.body.events[0].action, granted.body.events[0].after], ['override_granted', 'Time-based menus']);

  const limited = await override({ kind: 'limit', limitKey: 'tables', limitValue: 30 });
  assert.equal(limitOf(limited.body, 'tables'), 30);
  assert.equal(limited.body.events[0].before, '10 tables');
  const replaced = await override({ kind: 'limit', limitKey: 'tables', limitValue: null });
  assert.equal(limitOf(replaced.body, 'tables'), null, 'the newest override on a subject wins');
  assert.equal(replaced.body.overrides.filter((entry) => entry.limitKey === 'tables').length, 1, 'the old one ended');

  await override({ kind: 'feature', featureKey: 'kot_printing', granted: false });
  assert.equal((await override({ kind: 'feature', featureKey: 'station_routing', granted: true })).body.code, 'missing_dependency');
  assert.equal((await override({ kind: 'feature', featureKey: 'time_menus', granted: true, expiresAt: '2020-01-01T00:00:00Z' })).body.code, 'invalid_expiry');
  assert.equal((await override({ kind: 'feature', featureKey: 'teleport' })).body.code, 'invalid_feature');
  assert.equal((await override({ kind: 'limit', limitKey: 'tables', limitValue: -1 })).body.code, 'invalid_limit_value');

  const time = replaced.body.overrides.find((entry) => entry.featureKey === 'time_menus');
  const removed = await api.call('DELETE', `/admin/tenants/${id}/overrides/${time.id}`, { token: founder, body: { reason } });
  assert.equal(feature(removed.body, 'time_menus').enabled, false, 'the plan applies again');
  assert.equal((await api.call('DELETE', `/admin/tenants/${id}/overrides/${time.id}`, { token: founder, body: { reason } })).body.code, 'override_not_found');

  const uk = await api.restaurant({ ...UK, partnerId });
  const partner = api.admin({ role: 'partner', countries: ['GB'], partnerId });
  const refused = await api.call('POST', `/admin/tenants/${uk.id}/overrides`, { token: partner, body: { kind: 'feature', featureKey: 'time_menus', granted: true, reason, expiresAt: null } });
  assert.deepEqual([refused.status, refused.body.code], [403, 'forbidden']);
}));

test('branches: the limit, unique names, never the main one, only once empty, by typing the name', () => harness.run(async (api) => {
  const { id, detail, mainBranchId } = await api.restaurant({ planId: 'growth', startAs: 'active' });
  const founder = api.admin();
  const branch = (method, path, body) => api.call(method, `/admin/tenants/${id}/branches${path}`, { token: founder, body });
  assert.equal((await branch('POST', '', { name: 'Blue Area', area: 'Islamabad', reason })).body.code, 'branch_limit');
  await api.call('POST', `/admin/tenants/${id}/addons`, { token: founder, body: { addonId: 'extra_branch', reason } });
  const added = await branch('POST', '', { name: 'Blue Area', area: 'Islamabad', reason });
  assert.equal(added.status, 200);
  const blue = added.body.branches.find((entry) => entry.name === 'Blue Area');
  assert.equal((await branch('POST', '', { name: 'blue area', area: 'Somewhere', reason })).body.code, 'branch_limit', 'two branches paid for');
  assert.equal((await branch('PATCH', `/${blue.id}`, { name: 'Blue Area', area: 'Islamabad', reason })).body.code, 'no_changes');
  assert.equal((await branch('PATCH', `/${blue.id}`, { name: 'Main branch', area: 'Islamabad', reason })).body.code, 'duplicate_branch');
  const renamed = await branch('PATCH', `/${blue.id}`, { name: 'Blue Area F-6', area: 'Islamabad', reason });
  assert.equal(renamed.body.events[0].after, 'Name: Blue Area F-6');

  assert.equal((await branch('DELETE', `/${mainBranchId}`, { reason, confirmation: 'Main branch' })).body.code, 'main_branch');
  assert.equal((await branch('DELETE', `/${blue.id}`, { reason, confirmation: 'Blue Area' })).body.code, 'confirmation_mismatch');
  const staff = await api.addStaff(id, blue.id);
  const busy = await branch('DELETE', `/${blue.id}`, { reason, confirmation: 'Blue Area F-6' });
  assert.deepEqual([busy.body.code, busy.body.message], ['branch_in_use', 'Blue Area F-6 still has 1 staff login. The owner retires them in the portal first.']);
  await api.sql`delete from dinein.team_members where id = ${staff.id}`;
  const removed = await branch('DELETE', `/${blue.id}`, { reason, confirmation: 'Blue Area F-6' });
  assert.deepEqual(removed.body.branches.map((entry) => entry.id), [mainBranchId]);
  assert.equal(removed.body.events[0].action, 'branch_removed');
  assert.equal((await branch('PATCH', `/${randomUUID()}`, { name: 'Ghost', area: 'Nowhere', reason })).body.code, 'branch_not_found');
  assert.ok(detail);
}));

test('price lists: each country its own, the UK only for the founder, partners look but never edit', () => harness.run(async (api) => {
  const founder = api.admin();
  const team = api.admin({ role: 'team', countries: ['PK', 'GB'], partnerId: null });
  const catalog = (token, country = 'PK') => api.call('GET', '/admin/catalog', { token, headers: { 'x-admin-country': country } });
  const plan = (token, country, planId, body) => api.call('PUT', `/admin/catalog/plans/${planId}`, { token, headers: { 'x-admin-country': country }, body: { reason, ...body } });

  const pk = await catalog(founder);
  assert.deepEqual([pk.body.country, pk.body.currency, pk.body.pricesConfirmed, pk.body.canEdit], ['PK', 'PKR', true, true]);
  const growth = pk.body.catalog.plans.growth;
  const edit = { monthlyPrice: growth.monthlyPrice, setupFee: growth.setupFee, tagline: growth.tagline, features: growth.features, limits: growth.limits };

  assert.equal((await plan(founder, 'PK', 'growth', edit)).body.code, 'no_changes');
  assert.equal((await plan(founder, 'PK', 'growth', { ...edit, monthlyPrice: 10 })).body.code, 'invalid_plan', 'must cost more than Starter');
  assert.equal((await plan(founder, 'PK', 'growth', { ...edit, tagline: 'x' })).body.code, 'invalid_tagline');
  assert.equal((await plan(founder, 'PK', 'platinum', edit)).body.code, 'plan_not_found');
  const pricier = await plan(team, 'PK', 'growth', { ...edit, monthlyPrice: 26000 });
  assert.equal(pricier.body.catalog.plans.growth.monthlyPrice, 26000, 'the team may change Pakistan’s prices');

  const gb = await catalog(team, 'GB');
  assert.deepEqual([gb.body.currency, gb.body.pricesConfirmed, gb.body.canEdit], ['GBP', false, false]);
  const ukGrowth = gb.body.catalog.plans.growth;
  const ukEdit = { monthlyPrice: 179, setupFee: ukGrowth.setupFee, tagline: ukGrowth.tagline, features: ukGrowth.features, limits: ukGrowth.limits };
  assert.equal((await plan(team, 'GB', 'growth', ukEdit)).status, 403, 'only the founder sets UK prices');
  const confirmed = await plan(founder, 'GB', 'growth', ukEdit);
  assert.deepEqual([confirmed.body.pricesConfirmed, confirmed.body.catalog.plans.growth.monthlyPrice], [true, 179]);
  const events = await api.call('GET', '/admin/events?group=catalog', { token: founder, headers: { 'x-admin-country': 'GB' } });
  assert.deepEqual([events.body.items[0].tenantName, events.body.items[0].before, events.body.items[0].after, events.body.items[0].country], ['Growth plan', '£169/mo', '£179/mo', 'GB']);

  const addon = await api.call('PUT', '/admin/catalog/addons/extra_branch', { token: founder, body: { reason, planShare: 70, availableTo: ['growth', 'pro'] } });
  assert.deepEqual([addon.body.catalog.addons.extra_branch.planShare, addon.body.catalog.addons.extra_branch.availableTo], [70, ['growth', 'pro']]);
  assert.equal((await api.call('PUT', '/admin/catalog/addons/extra_branch', { token: founder, body: { reason, planShare: 70, availableTo: [] } })).body.code, 'no_plans');

  const partnerId = randomUUID();
  const partnerView = await catalog(api.admin({ role: 'partner', countries: ['GB'], partnerId }), 'GB');
  assert.deepEqual([partnerView.body.canEdit, partnerView.body.usage.plans.growth], [false, { tenants: 0, paying: 0, mrr: 0 }]);
}));

test('the dashboard, history log and upgrade requests show only what the person may see', () => harness.run(async (api) => {
  const partnerId = (await api.sql`insert into dinein.partners (name, countries, contact_name, contact_email)
    values ('Test Partner Ltd', ${['GB']}, 'Contact', 'p@example.invalid') returning id`)[0].id;
  const pk = await api.restaurant({ planId: 'growth', startAs: 'active' });
  const uk = await api.restaurant({ ...UK, partnerId, planId: 'starter', startAs: 'active' });
  const otherUk = await api.restaurant({ ...UK, city: 'Leeds' });
  const founder = api.admin();
  const partner = api.admin({ role: 'partner', countries: ['GB'], partnerId });

  await api.call('POST', '/portal/upgrade-requests', { token: pk.ownerToken, body: { featureKey: 'pra_invoicing' } });
  await api.call('POST', '/portal/upgrade-requests', { token: pk.ownerToken, body: { featureKey: 'pra_invoicing' } });
  await api.call('POST', '/portal/upgrade-requests', { token: uk.ownerToken, body: { limitKey: 'tables' } });

  const dashboard = await api.call('GET', '/admin/dashboard', { token: founder, headers: { 'x-admin-country': 'PK' } });
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.mrr >= 25000);
  assert.equal(dashboard.body.mrrTrend.length, 6);
  assert.equal(dashboard.body.mrrTrend.at(-1).mrr, dashboard.body.mrr, 'this month is the live total');
  const mine = dashboard.body.attention.filter((item) => item.tenantId === pk.id).map((item) => item.kind).sort();
  // Every restaurant uses its one included branch, so core's "limit reached" nudge shows.
  assert.deepEqual(mine, ['limit_reached', 'setup_unpaid', 'upgrade_request']);
  assert.match(dashboard.body.attention.find((item) => item.kind === 'upgrade_request' && item.tenantId === pk.id).message, /asked for pra invoicing \(2 times\)\. Offer: Pro plan · PKR 35,000\/mo\./i);
  assert.ok(dashboard.body.recentTenants.some((row) => row.id === pk.id));

  const requests = await api.call('GET', '/admin/requests', { token: founder });
  const row = requests.body.items.find((item) => item.tenantId === pk.id);
  assert.deepEqual([row.count, row.label, row.suggestion], [2, 'PRA invoicing', 'Pro plan · PKR 35,000/mo']);
  assert.equal((await api.call('POST', `/admin/requests/${row.id}/handle`, { token: founder, body: { note: 'ok' } })).body.code, 'validation_failed');
  const handled = await api.call('POST', `/admin/requests/${row.id}/handle`, { token: founder, body: { note: 'Called, moving to Pro on the 1st' } });
  assert.ok(!handled.body.items.some((item) => item.id === row.id));
  assert.equal((await api.call('POST', `/admin/requests/${row.id}/handle`, { token: founder, body: { note: 'Again, again' } })).body.code, 'already_handled');

  // A partner sees only their own restaurants' requests and events.
  const partnerRequests = await api.call('GET', '/admin/requests', { token: partner });
  assert.deepEqual(partnerRequests.body.items.map((item) => item.tenantId), [uk.id]);
  assert.equal(partnerRequests.body.items[0].suggestion, 'Extra tables · £5/mo each');
  assert.equal((await api.call('POST', `/admin/requests/${row.id}/handle`, { token: partner, body: { note: 'Not mine at all' } })).status, 404);
  const partnerEvents = await api.call('GET', '/admin/events?pageSize=100', { token: partner });
  assert.ok(partnerEvents.body.items.length > 0 && partnerEvents.body.items.every((event) => event.tenantId === uk.id));
  assert.deepEqual(partnerEvents.body.tenants.map((tenant) => tenant.id), [uk.id]);
  assert.ok(!partnerEvents.body.items.some((event) => event.tenantId === otherUk.id));

  const filtered = await api.call('GET', `/admin/events?tenantId=${pk.id}&group=restaurants&search=signed`, { token: founder });
  assert.deepEqual(filtered.body.items.map((event) => event.action), ['tenant_created']);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await api.call('GET', `/admin/events?tenantId=${pk.id}&from=2020-01-01&to=2020-01-02`, { token: founder })).body.total, 0);
  assert.ok((await api.call('GET', `/admin/events?tenantId=${pk.id}&from=2020-01-01&to=2099-01-01`, { token: founder })).body.total >= 1, today);

  // Owners: what they ask for, and what they can't.
  assert.equal((await api.call('POST', '/portal/upgrade-requests', { token: pk.ownerToken, body: { featureKey: 'station_routing' } })).body.code, 'already_enabled');
  assert.equal((await api.call('POST', '/portal/upgrade-requests', { token: pk.ownerToken, body: { featureKey: 'nope' } })).body.code, 'invalid_feature');
  const staff = await api.addStaff(pk.id, pk.mainBranchId);
  assert.equal((await api.call('POST', '/portal/upgrade-requests', { token: staff.token, body: { featureKey: 'pra_invoicing' } })).status, 403);
  const [clicks] = await api.sql`select clicks from dinein.locked_clicks where tenant_id = ${pk.id} and feature_key = 'pra_invoicing'`;
  assert.equal(clicks.clicks, 2, 'feature requests count as locked-feature clicks');
}));

test('the monthly audit: six checks, sign-off needs all six, one per country, partners only look', () => harness.run(async (api) => {
  const pk = await api.restaurant({ planId: 'growth', startAs: 'active' });
  const founder = api.admin();
  const month = monthKey(new Date(), 'Asia/Karachi');
  const audit = await api.call('GET', '/admin/monthly-audit', { token: founder });
  assert.equal(audit.body.month, month);
  const billing = audit.body.billing.find((row) => row.tenantId === pk.id);
  assert.deepEqual([billing.payment, billing.setupOutstanding, billing.proRated || billing.amountDue === 25000], [null, 40000, true]);
  assert.ok(audit.body.activity.some((row) => row.tenantId === pk.id && /No orders yet/.test(row.issue)));
  assert.deepEqual(audit.body.run, { month, reviewed: [], notes: '', completedAt: null, completedBy: null });

  const update = (body, token = founder, at = month, country = 'PK') => api.call('PUT', `/admin/monthly-audit/${at}`, { token, headers: { 'x-admin-country': country }, body });
  assert.equal((await update({ action: 'sign_off', notes: '' })).body.code, 'incomplete');
  assert.equal((await update({ action: 'review', check: 'nonsense', reviewed: true })).body.code, 'invalid_check');
  assert.equal((await update({ action: 'dance' })).body.code, 'invalid_action');
  assert.equal((await update({ action: 'review', check: 'billing', reviewed: true }, founder, '2020-01')).body.code, 'closed_month');
  for (const check of ['billing', 'limits', 'locked', 'overrides', 'activity', 'orphans']) await update({ action: 'review', check, reviewed: true });
  const partner = api.admin({ role: 'partner', countries: ['GB'], partnerId: randomUUID() });
  assert.equal((await update({ action: 'review', check: 'billing', reviewed: false }, partner, month, 'GB')).status, 403, 'partners look but don’t sign');
  const signed = await update({ action: 'sign_off', notes: 'All collected except one' });
  assert.deepEqual([signed.body.run.reviewed.length, signed.body.run.notes, signed.body.run.completedBy], [6, 'All collected except one', 'Test founder']);
  assert.equal((await update({ action: 'review', check: 'billing', reviewed: false })).body.code, 'audit_completed');

  const uk = await api.call('GET', '/admin/monthly-audit', { token: founder, headers: { 'x-admin-country': 'GB' } });
  assert.equal(uk.body.run.completedAt, null, 'signing off Pakistan doesn’t sign off the UK');
}));

test('partners: statements from the fees their restaurants paid, our share, founder-only changes', () => harness.run(async (api) => {
  const [{ id: partnerId }] = await api.sql`insert into dinein.partners (name, countries, contact_name, contact_email)
    values ('Test Partner Ltd', ${['GB']}, 'Contact', 'p@example.invalid') returning id`;
  const [{ id: otherPartner }] = await api.sql`insert into dinein.partners (name, countries, contact_name, contact_email)
    values ('Other Partner Ltd', ${['GB']}, 'Contact', 'o@example.invalid') returning id`;
  const uk = await api.restaurant({ ...UK, partnerId, planId: 'growth', startAs: 'active' });
  const lastMonth = monthKey(new Date(), 'Europe/London', -1);
  const thisMonth = monthKey(new Date(), 'Europe/London');
  await api.sql`update dinein.tenants set created_at = now() - interval '45 days' where id = ${uk.id}`;
  await api.sql`insert into dinein.payments (tenant_id, kind, month, amount, method, reference, recorded_by) values
    (${uk.id}, 'monthly', ${`${lastMonth}-01`}::date, 169, 'card', 'CARD-1', 'Partner'),
    (${uk.id}, 'setup', ${`${lastMonth}-01`}::date, 299, 'card', 'CARD-2', 'Partner'),
    (${uk.id}, 'monthly', ${`${thisMonth}-01`}::date, 169, 'card', 'CARD-3', 'Partner')`;
  const founder = api.admin();
  const partner = api.admin({ role: 'partner', countries: ['GB'], partnerId });

  const list = await api.call('GET', '/admin/partners', { token: partner });
  assert.deepEqual(list.body.map((row) => row.id), [partnerId], 'a partner sees only themselves');
  assert.equal((await api.call('GET', `/admin/partners/${otherPartner}`, { token: partner })).status, 404);
  assert.ok((await api.call('GET', '/admin/partners', { token: founder })).body.length >= 2);

  const before = await api.call('GET', `/admin/partners/${partnerId}`, { token: partner });
  const last = before.body.statements.find((statement) => statement.month === lastMonth);
  assert.deepEqual([last.feesCollected, last.shareDue, last.dueOn, last.currency, before.body.canEdit], [468, null, null, 'GBP', false]);
  assert.equal((await api.call('PATCH', `/admin/partners/${partnerId}`, { token: partner, body: { sharePercent: 20, paymentDay: 10, reason } })).status, 403);
  assert.equal((await api.call('PATCH', `/admin/partners/${partnerId}`, { token: founder, body: { sharePercent: 120, paymentDay: 31, reason } })).body.code, 'validation_failed');

  const agreed = await api.call('PATCH', `/admin/partners/${partnerId}`, { token: founder, body: { sharePercent: 20, paymentDay: 10, reason } });
  const owed = agreed.body.statements.find((statement) => statement.month === lastMonth);
  assert.deepEqual([owed.shareDue, owed.dueOn.slice(8), agreed.body.outstanding], [94, '10', 94], 'this month is still being collected');
  const paidPath = (month) => `/admin/partners/${partnerId}/statements/${month}/received`;
  assert.equal((await api.call('POST', paidPath(thisMonth), { token: founder, body: { amount: 34, reference: 'BACS' } })).body.code, 'month_open');
  assert.equal((await api.call('POST', paidPath('2001-01'), { token: founder, body: { amount: 34, reference: 'BACS' } })).body.code, 'not_found');
  const received = await api.call('POST', paidPath(lastMonth), { token: founder, body: { amount: 94, reference: 'BACS 123' } });
  assert.deepEqual([received.body.outstanding, received.body.statements.find((statement) => statement.month === lastMonth).received.amount], [0, 94]);
  assert.equal((await api.call('POST', paidPath(lastMonth), { token: founder, body: { amount: 94, reference: 'Again' } })).body.code, 'already_paid');
  const events = await api.call('GET', '/admin/events?group=partners', { token: founder, headers: { 'x-admin-country': 'GB' } });
  assert.deepEqual(events.body.items.map((event) => event.action), ['partner_payment_recorded', 'partner_updated']);
  assert.ok(FOUNDER);
}));

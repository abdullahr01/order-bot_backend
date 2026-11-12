// Every route the four apps call exists (the partner's mock answers exactly these 87),
// and anything else is the plain "not found". Rolled back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openHarness } from './api-harness.js';
import { monthKey } from '../../shared/time.js';

const harness = openHarness();
after(() => harness.close());

/** What the API answers when no route matches: never used by an endpoint. */
const NO_ROUTE = 'The requested resource was not found.';

// From packages/core/src/mock/index.ts (route(...) list), 2026-11-12.
const ROUTES = [
  ['GET', '/portal/me'], ['GET', '/portal/dashboard'], ['GET', '/portal/orders'], ['GET', '/portal/orders/:id'],
  ['PATCH', '/portal/orders/:id/status'], ['GET', '/portal/menu'], ['POST', '/portal/menu/categories'],
  ['PUT', '/portal/menu/categories/order'], ['PATCH', '/portal/menu/categories/:id'], ['DELETE', '/portal/menu/categories/:id'],
  ['PUT', '/portal/menu/categories/:id/order'], ['POST', '/portal/menu/stations'], ['PATCH', '/portal/menu/stations/:id'],
  ['DELETE', '/portal/menu/stations/:id'], ['POST', '/portal/menu/items'], ['PATCH', '/portal/menu/items/:id'],
  ['DELETE', '/portal/menu/items/:id'], ['POST', '/portal/menu/photos'], ['POST', '/portal/upgrade-requests'],
  ['GET', '/portal/reports'], ['GET', '/portal/daily-summary'], ['GET', '/portal/branches'], ['GET', '/portal/void-log'],
  ['GET', '/portal/cash-close'], ['POST', '/portal/cash-close'], ['GET', '/portal/billing'], ['GET', '/portal/service'],
  ['PATCH', '/portal/service'], ['GET', '/portal/today'], ['PUT', '/portal/today/pause'], ['GET', '/portal/dine-in/floor'],
  ['GET', '/portal/dine-in/setup'], ['GET', '/portal/dine-in/requests'], ['POST', '/portal/dine-in/requests/:id/handle'],
  ['POST', '/portal/dine-in/orders'], ['GET', '/portal/dine-in/tables/:id'], ['POST', '/portal/dine-in/tables/:id/close'],
  ['POST', '/portal/dine-in/tables'], ['PATCH', '/portal/dine-in/tables/:id'], ['POST', '/portal/dine-in/tables/:id/token'],
  ['POST', '/portal/dine-in/waiters'], ['DELETE', '/portal/dine-in/waiters/:id'], ['GET', '/portal/team'], ['POST', '/portal/team'],
  ['PATCH', '/portal/team/:id'], ['DELETE', '/portal/team/:id'], ['PUT', '/portal/team/:id/pin'], ['GET', '/portal/counters'],
  ['POST', '/portal/counters/pairing-codes'], ['DELETE', '/portal/counters/:id'], ['GET', '/public/tables/:token'],
  ['POST', '/public/tables/:token/orders'], ['POST', '/public/tables/:token/requests'], ['POST', '/counter/pair'],
  ['GET', '/counter/session'], ['POST', '/counter/unlock'], ['POST', '/counter/lock'], ['GET', '/admin/dashboard'],
  ['GET', '/admin/catalog'], ['PUT', '/admin/catalog/plans/:planId'], ['PUT', '/admin/catalog/addons/:addonId'],
  ['GET', '/admin/events'], ['GET', '/admin/requests'], ['GET', '/admin/partners'], ['GET', '/admin/partners/:id'],
  ['PATCH', '/admin/partners/:id'], ['POST', '/admin/partners/:id/statements/:month/received'], ['POST', '/admin/requests/:id/handle'],
  ['GET', '/admin/monthly-audit'], ['PUT', '/admin/monthly-audit/:month'], ['POST', '/admin/tenants/:id/payments'],
  ['GET', '/admin/tenants'], ['POST', '/admin/tenants'], ['GET', '/admin/tenants/:id'], ['PATCH', '/admin/tenants/:id'],
  ['PATCH', '/admin/tenants/:id/addons/:addonId'], ['POST', '/admin/tenants/:id/branches'],
  ['PATCH', '/admin/tenants/:id/branches/:branchId'], ['DELETE', '/admin/tenants/:id/branches/:branchId'],
  ['PATCH', '/admin/tenants/:id/onboarding'], ['POST', '/admin/tenants/:id/plan'], ['DELETE', '/admin/tenants/:id/plan/scheduled'],
  ['POST', '/admin/tenants/:id/status'], ['POST', '/admin/tenants/:id/addons'], ['DELETE', '/admin/tenants/:id/addons/:addonId'],
  ['POST', '/admin/tenants/:id/overrides'], ['DELETE', '/admin/tenants/:id/overrides/:overrideId'],
];

test('all 87 routes the apps use exist, and nothing else does', () => harness.run(async (api) => {
  assert.equal(ROUTES.length, 87);
  const { id, ownerToken } = await api.restaurant();
  const deviceToken = await api.pairCounter(ownerToken, (await api.call('GET', '/portal/me', { token: ownerToken })).body.branches[0].id);
  const fill = (path) => path
    .replace('/admin/tenants/:id', `/admin/tenants/${id}`)
    .replace(':month', monthKey(new Date(), 'Asia/Karachi'))
    .replace(':planId', 'growth').replace(':addonId', 'extra_tables').replace(':token', 'abcdefghjkmnpqrstuvw')
    .replace(/:\w+/g, () => randomUUID());
  const callerFor = (path) => (path.startsWith('/admin') ? { token: api.admin() }
    : path.startsWith('/portal') ? { token: ownerToken }
      : path.startsWith('/counter') ? { headers: { 'x-counter-device': deviceToken } } : {});

  const missing = [];
  for (const [method, path] of ROUTES) {
    const response = await api.call(method, fill(path), { ...callerFor(path), body: method === 'GET' ? undefined : {} });
    if (response.status === 404 && response.body?.message === NO_ROUTE) missing.push(`${method} ${path}`);
    assert.notEqual(response.status, 500, `${method} ${path} answered 500`);
  }
  assert.deepEqual(missing, [], 'routes the apps call but the API lacks');

  for (const [method, path, caller] of [
    ['GET', '/portal/nothing-here', { token: ownerToken }], ['DELETE', '/portal/me', { token: ownerToken }],
    ['GET', `/admin/tenants/${id}/secrets`, { token: api.admin() }], ['POST', '/admin/dashboard', { token: api.admin() }],
    ['GET', '/public/tables', {}], ['GET', '/nowhere', {}],
  ]) {
    const response = await api.call(method, path, { ...caller, body: method === 'GET' ? undefined : {} });
    assert.deepEqual([path, response.status, response.body.message], [path, 404, NO_ROUTE]);
  }
}));

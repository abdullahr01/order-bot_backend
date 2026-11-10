// Proves each kind of caller is let in or refused. Uses a temporary local signing key
// and in-memory lookups; a real Supabase sign-in is checked once an account exists.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccessMiddleware } from '../middleware/access.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createRateLimits } from '../middleware/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import { BranchModel } from '../model/branch.model.js';
import { createApiRouter } from '../router/index.js';
import { AuthService } from '../service/auth.service.js';
import { hashToken } from '../shared/crypto.js';
import { createTokenVerifier } from '../shared/token-verifier.js';
import { serve } from './helpers.js';

const SUPABASE = 'https://project.invalid';
const tenantId = randomUUID();
const otherTenant = randomUUID();
const branchId = randomUUID();
const otherBranch = randomUUID();
const ownerId = randomUUID();
const staffId = randomUUID();
const deviceId = randomUUID();
const partnerId = randomUUID();

let signingKey;
let wrongKey;
let verifyToken;

before(async () => {
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  wrongKey = (await generateKeyPair('ES256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'ES256', use: 'sig' };
  verifyToken = createTokenVerifier({ supabaseUrl: SUPABASE, keySet: createLocalJWKSet({ keys: [jwk] }) });
});

function sign(claims, { key = signingKey, issuer = `${SUPABASE}/auth/v1`, audience = 'authenticated', expires = Math.floor(Date.now() / 1000) + 300, sub = ownerId } = {}) {
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'test' }).setSubject(sub)
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(key);
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const adminToken = (metadata = {}, aal = 'aal2') => sign({ email: 'founder@example.invalid', aal, app_metadata: { role: 'super_admin', ...metadata } });
const ownerToken = () => sign({ app_metadata: { role: 'tenant_owner', tenant_id: tenantId } });
const staffToken = (branch = branchId) => sign({ app_metadata: { role: 'tenant_staff', tenant_id: tenantId, branch_id: branch } }, { sub: staffId });

const team = () => new Map([
  [`${ownerId}:${tenantId}`, { name: 'Owner', role: 'tenant_owner', branch_id: null, branch_retired: false }],
  [`${staffId}:${tenantId}`, { name: 'Rabia', role: 'tenant_staff', branch_id: branchId, branch_retired: false }],
]);
const device = (overrides = {}) => ({ id: deviceId, tenant_id: tenantId, branch_id: branchId, name: 'Front counter', status: 'active', branch_retired: false, ...overrides });

function stubRepository({ members = team(), counters = {}, unlocks = {}, tenants = {} } = {}) {
  return {
    findTeamMember: async (user, tenant) => members.get(`${user}:${tenant}`) ?? null,
    findCounter: async (deviceHash, staffHash) => {
      const found = counters[deviceHash];
      return found ? { user_id: null, person_name: null, person_role: null, person_branch_id: null, ...found, ...(unlocks[staffHash] ?? {}) } : null;
    },
    findTenantScope: async (id) => tenants[id] ?? null,
  };
}

const echo = (request, response) => response.json(request.actor ?? null);

async function setup(t, { repository = stubRepository(), entitlements, limits } = {}) {
  const access = createAccessMiddleware({ entitlements, authRepository: repository });
  const portal = express.Router();
  portal.get('/ping', echo);
  portal.get('/figures', access.requirePermission('figures.view'), echo);
  portal.get('/orders', access.requirePermission('orders.manage'), echo);
  portal.get('/stations', access.requireFeature('station_routing'), echo);
  portal.get('/split', access.requireFeature('split_bill'), echo);
  portal.post('/write', access.requireWritable, echo);
  portal.post('/setup', access.requireSetupWritable, echo);
  const admin = express.Router();
  admin.get('/ping', echo);
  admin.get('/tenants/:id', access.requireVisibleTenant, echo);
  admin.post('/tenants/:id/overrides', access.requireNotPartner, echo);
  admin.post('/branches', validateBody(BranchModel.input, { code: 'invalid_input', message: 'Some details need fixing.' }), (request, response) => response.json(request.body));
  const counter = express.Router();
  counter.get('/session', echo);
  counter.post('/pair', echo);
  const diner = express.Router();
  diner.get('/tables/:token', echo);
  const router = createApiRouter({
    auth: createAuthMiddleware(new AuthService({ repository, verifyToken })),
    limits: limits ?? createRateLimits(),
    routers: { admin, portal, counter, public: diner },
  });
  return serve(t, router);
}

const code = (response) => [response.status, response.json().code];

test('signed-in routes refuse missing, forged, expired and wrong-project tokens', async (t) => {
  const app = await setup(t);
  assert.deepEqual(code(await app.request('/portal/ping')), [401, 'unauthorized']);
  assert.deepEqual(code(await app.request('/admin/ping')), [401, 'unauthorized']);
  const claims = { aal: 'aal2', app_metadata: { role: 'super_admin' } };
  const bad = [
    'not-a-token',
    await sign(claims, { key: wrongKey }),
    await sign(claims, { expires: Math.floor(Date.now() / 1000) - 60 }),
    await sign(claims, { issuer: 'https://another.invalid/auth/v1' }),
    await sign(claims, { audience: 'someone-else' }),
  ];
  for (const token of bad) assert.deepEqual(code(await app.request('/admin/ping', { headers: bearer(token) })), [401, 'unauthorized']);
});

test('a problem reaching the signing keys is our fault, so nobody gets signed out', async (t) => {
  const failing = new AuthService({ repository: stubRepository(), verifyToken: async () => { throw Object.assign(new Error('network'), { code: 'ERR_JWKS_TIMEOUT' }); } });
  const router = createApiRouter({ auth: createAuthMiddleware(failing), limits: createRateLimits() });
  const app = await serve(t, router);
  assert.deepEqual(code(await app.request('/admin/ping', { headers: bearer('x.y.z') })), [500, 'server_error']);
});

test('platform team: needs the role, the authenticator code and a valid scope', async (t) => {
  const app = await setup(t);
  const founder = await app.request('/admin/ping', { headers: bearer(await adminToken()) });
  assert.equal(founder.status, 200);
  assert.deepEqual([founder.json().kind, founder.json().name, founder.json().adminScope], ['admin', 'founder@example.invalid', null]);
  assert.deepEqual(code(await app.request('/admin/ping', { headers: bearer(await adminToken({}, 'aal1')) })), [403, 'forbidden']);
  assert.deepEqual(code(await app.request('/admin/ping', { headers: bearer(await ownerToken()) })), [403, 'forbidden']);
  const badScopes = [{ role: 'emperor', countries: ['PK'] }, { role: 'partner', countries: ['GB'] }, { role: 'team', countries: [] }];
  for (const admin_scope of badScopes) {
    assert.deepEqual(code(await app.request('/admin/ping', { headers: bearer(await adminToken({ admin_scope })) })), [403, 'forbidden']);
  }
});

test('the role comes from app_metadata only; user_metadata is ignored', async (t) => {
  const app = await setup(t);
  const token = await sign({ aal: 'aal2', user_metadata: { role: 'super_admin', tenant_id: tenantId }, app_metadata: {} });
  assert.deepEqual(code(await app.request('/admin/ping', { headers: bearer(token) })), [403, 'forbidden']);
  assert.deepEqual(code(await app.request('/portal/ping', { headers: bearer(token) })), [403, 'forbidden']);
});

test('partners carry their scope and country; only the allowed restaurants exist for them', async (t) => {
  const visible = randomUUID();
  const someoneElses = randomUUID();
  const repository = stubRepository({ tenants: { [visible]: { country: 'GB', partnerId }, [someoneElses]: { country: 'GB', partnerId: randomUUID() } } });
  const app = await setup(t, { repository });
  const token = await adminToken({ name: 'Oliver', admin_scope: { role: 'partner', countries: ['GB'], partnerId } });
  const headers = { ...bearer(token), 'x-admin-country': 'GB' };
  const self = (await app.request('/admin/ping', { headers })).json();
  assert.deepEqual([self.name, self.viewCountry, self.adminScope.partnerId], ['Oliver', 'GB', partnerId]);
  assert.equal((await app.request(`/admin/tenants/${visible}`, { headers })).status, 200);
  for (const id of [someoneElses, randomUUID(), 'not-a-uuid']) {
    assert.deepEqual(code(await app.request(`/admin/tenants/${id}`, { headers })), [404, 'tenant_not_found']);
  }
  assert.deepEqual(code(await app.request(`/admin/tenants/${visible}/overrides`, { method: 'POST', headers })), [403, 'forbidden']);
  const founder = bearer(await adminToken());
  assert.equal((await app.request(`/admin/tenants/${someoneElses}`, { headers: founder })).status, 200);
  assert.equal((await app.request(`/admin/tenants/${visible}/overrides`, { method: 'POST', headers: founder })).status, 200);
});

test('restaurant users: the team is checked on every request', async (t) => {
  const members = team();
  const app = await setup(t, { repository: stubRepository({ members }) });
  const owner = await app.request('/portal/ping', { headers: bearer(await ownerToken()) });
  assert.deepEqual([owner.status, owner.json().kind, owner.json().tenantId, owner.json().branchId], [200, 'owner', tenantId, null]);
  const staff = await app.request('/portal/ping', { headers: bearer(await staffToken()) });
  assert.deepEqual([staff.status, staff.json().kind, staff.json().branchId, staff.json().name], [200, 'staff', branchId, 'Rabia']);

  assert.deepEqual(code(await app.request('/portal/ping', { headers: bearer(await adminToken()) })), [403, 'forbidden']);
  assert.deepEqual(code(await app.request('/portal/ping', { headers: bearer(await staffToken(otherBranch)) })), [401, 'account_removed'], 'moved branch');

  members.get(`${staffId}:${tenantId}`).branch_retired = true;
  assert.deepEqual(code(await app.request('/portal/ping', { headers: bearer(await staffToken()) })), [401, 'account_removed'], 'branch closed');

  members.delete(`${staffId}:${tenantId}`);
  assert.deepEqual(code(await app.request('/portal/ping', { headers: bearer(await staffToken()) })), [401, 'account_removed'], 'removed from the team');

  const stolen = await sign({ app_metadata: { role: 'tenant_owner', tenant_id: otherTenant } });
  assert.deepEqual(code(await app.request('/portal/ping', { headers: bearer(stolen) })), [401, 'account_removed'], 'not on that restaurant’s team');
  const demoted = await sign({ app_metadata: { role: 'tenant_owner', tenant_id: tenantId } }, { sub: staffId });
  assert.deepEqual(code(await app.request('/portal/ping', { headers: bearer(demoted) })), [401, 'account_removed']);
  assert.deepEqual(code(await app.request('/portal/ping', { headers: bearer(await sign({ app_metadata: { role: 'tenant_owner' } })) })), [403, 'forbidden']);
});

const counterRepository = (overrides, unlocks = {}) => stubRepository({ counters: { [hashToken('device-token')]: device(overrides) }, unlocks });
const person = (role, branch) => ({ user_id: staffId, person_name: 'Rabia', person_role: role, person_branch_id: branch });

test('counter PC: the device must be paired and someone must have unlocked it', async (t) => {
  const repository = counterRepository({}, { [hashToken('staff-token')]: person('tenant_staff', branchId), [hashToken('moved')]: person('tenant_staff', otherBranch) });
  const app = await setup(t, { repository });
  const pc = { 'x-counter-device': 'device-token' };
  assert.deepEqual(code(await app.request('/portal/ping', { headers: { 'x-counter-device': 'unknown' } })), [401, 'device_revoked']);
  assert.deepEqual(code(await app.request('/portal/ping', { headers: pc })), [401, 'counter_locked'], 'nobody unlocked');
  assert.deepEqual(code(await app.request('/portal/ping', { headers: { ...pc, ...bearer('wrong') } })), [401, 'counter_locked']);
  assert.deepEqual(code(await app.request('/portal/ping', { headers: { ...pc, ...bearer('moved') } })), [401, 'counter_locked'], 'no longer at this branch');
  const unlocked = await app.request('/portal/ping', { headers: { ...pc, ...bearer('staff-token') } });
  assert.equal(unlocked.status, 200);
  assert.deepEqual([unlocked.json().kind, unlocked.json().branchId, unlocked.json().deviceId, unlocked.json().name], ['counter', branchId, deviceId, 'Rabia']);
});

test('an owner at a counter is held to its branch but keeps their real permissions', async (t) => {
  const repository = counterRepository({}, { [hashToken('owner-token')]: person('tenant_owner', null) });
  const app = await setup(t, { repository });
  const headers = { 'x-counter-device': 'device-token', ...bearer('owner-token') };
  const response = await app.request('/portal/figures', { headers });
  assert.deepEqual([response.status, response.json().branchId, response.json().role], [200, branchId, 'tenant_owner']);
});

test('counter routes need only the device; pairing needs nothing', async (t) => {
  const app = await setup(t, { repository: counterRepository() });
  assert.deepEqual(code(await app.request('/counter/session')), [401, 'device_revoked']);
  const session = await app.request('/counter/session', { headers: { 'x-counter-device': 'device-token' } });
  assert.deepEqual([session.status, session.json().kind, session.json().tenantId], [200, 'device', tenantId]);
  const pair = await app.request('/counter/pair', { method: 'POST' });
  assert.deepEqual([pair.status, pair.body], [200, 'null']);
});

test('a cancelled restaurant or closed branch unpairs the counter; suspended stays paired', async (t) => {
  const pc = { 'x-counter-device': 'device-token' };
  for (const [overrides, status] of [[{ status: 'cancelled' }, 401], [{ branch_retired: true }, 401], [{ status: 'suspended' }, 200]]) {
    const app = await setup(t, { repository: counterRepository(overrides) });
    assert.equal((await app.request('/counter/session', { headers: pc })).status, status);
  }
});

test('diners need no credentials', async (t) => {
  const app = await setup(t);
  assert.equal((await app.request('/public/tables/some-token')).status, 200);
});

test('permissions come from the role', async (t) => {
  const app = await setup(t);
  assert.deepEqual(code(await app.request('/portal/figures', { headers: bearer(await staffToken()) })), [403, 'forbidden']);
  assert.equal((await app.request('/portal/orders', { headers: bearer(await staffToken()) })).status, 200);
  assert.equal((await app.request('/portal/figures', { headers: bearer(await ownerToken()) })).status, 200);
});

function fakeEntitlements(state, calls) {
  return { forTenant: async () => { calls.count += 1; return state; } };
}

test('plan features, read-only accounts and the day-30 setup lock', async (t) => {
  const state = { features: new Set(['station_routing', 'split_bill']), readOnly: false, setupLocked: false };
  const calls = { count: 0 };
  const app = await setup(t, { entitlements: fakeEntitlements(state, calls) });
  const headers = bearer(await ownerToken());
  const post = { method: 'POST', headers };
  assert.equal((await app.request('/portal/stations', { headers })).status, 200);
  assert.equal(calls.count, 1);
  assert.deepEqual(code(await app.request('/portal/split', { headers })), [403, 'feature_locked'], 'not built yet, even if on the plan');
  state.features = new Set();
  assert.deepEqual(code(await app.request('/portal/stations', { headers })), [403, 'feature_locked']);

  assert.equal((await app.request('/portal/write', post)).status, 200);
  assert.equal((await app.request('/portal/setup', post)).status, 200);
  state.setupLocked = true;
  assert.equal((await app.request('/portal/write', post)).status, 200, 'day 30: service carries on');
  assert.deepEqual(code(await app.request('/portal/setup', post)), [403, 'account_paused'], 'day 30: owners can’t edit');
  state.setupLocked = false;
  state.readOnly = true;
  assert.deepEqual(code(await app.request('/portal/write', post)), [403, 'account_paused']);
  assert.deepEqual(code(await app.request('/portal/setup', post)), [403, 'account_paused']);
});

test('form errors reach the client with their field names', async (t) => {
  const app = await setup(t);
  const response = await app.request('/admin/branches', {
    method: 'POST', headers: { ...bearer(await adminToken()), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'B', area: 'Bank Road', reason: 'New site' }),
  });
  assert.deepEqual(code(response), [422, 'invalid_input']);
  assert.ok(response.json().fields.name);
});

test('rate limits: pairing per IP, diner page per IP and table', async (t) => {
  const limits = createRateLimits({ dinerReads: { limit: 2, windowMs: 60_000 }, pairing: { limit: 2, windowMs: 60_000 } });
  const app = await setup(t, { limits });
  for (let i = 0; i < 2; i += 1) assert.equal((await app.request('/counter/pair', { method: 'POST' })).status, 200);
  assert.deepEqual(code(await app.request('/counter/pair', { method: 'POST' })), [429, 'rate_limited']);
  for (let i = 0; i < 2; i += 1) assert.equal((await app.request('/public/tables/table-a')).status, 200);
  assert.deepEqual(code(await app.request('/public/tables/table-a')), [429, 'rate_limited']);
  assert.equal((await app.request('/public/tables/table-b')).status, 200, 'another table has its own count');
});

test('credentials never reach the logs or error responses', async (t) => {
  const repository = counterRepository({}, { [hashToken('staff-sentinel')]: person('tenant_staff', branchId) });
  const app = await setup(t, { repository });
  const token = await staffToken();
  const responses = [
    await app.request('/portal/ping', { headers: bearer(token) }),
    await app.request('/portal/ping', { headers: { 'x-counter-device': 'device-token', ...bearer('staff-sentinel') } }),
    await app.request('/portal/ping', { headers: { 'x-counter-device': 'device-sentinel' } }),
  ];
  const seen = app.text() + responses.map((response) => response.body).join('');
  for (const secret of [token, 'staff-sentinel', 'device-sentinel', 'device-token']) assert.ok(!seen.includes(secret), secret);
  assert.match(app.text(), /Restaurant user authenticated/);
});

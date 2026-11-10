// Runs the real API against the development database inside one transaction that is
// always rolled back, so nothing a test does is kept: no restaurants, no accounts.
// Tokens are signed with a local test key; Auth invites and photo uploads are fakes.
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../../app.js';
import { AuthAdminError } from '../../db/auth-admin.js';
import { assertDevelopmentTarget } from '../../db/config.js';
import { Database } from '../../db/database.js';
import { PHOTO_BUCKET } from '../../db/photo-storage.js';
import { createRateLimits } from '../../middleware/rate-limit.js';
import { createApiRouter } from '../../router/index.js';
import { createServices } from '../../service/index.js';
import { createLogger } from '../../shared/logger.js';
import { settings } from '../../shared/settings.js';
import { createTokenVerifier } from '../../shared/token-verifier.js';

const ISSUER = `${settings.supabase.url}/auth/v1`;
const silent = createLogger({ environment: 'test', level: 'silent' });
const rollback = new Error('Intentional test rollback');

const keys = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'stage3-test', alg: 'ES256', use: 'sig' };
const verifyToken = createTokenVerifier({ supabaseUrl: settings.supabase.url, keySet: createLocalJWKSet({ keys: [jwk] }) });

export const FOUNDER = { role: 'founder', countries: ['PK', 'GB'], partnerId: null };

function sign(sub, claims) {
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'stage3-test' }).setSubject(sub)
    .setIssuer(ISSUER).setAudience('authenticated').setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
}

/** Stands in for Supabase Auth: accounts are rows in auth.users inside the test transaction. */
class FakeAuthAdmin {
  invited = [];
  failInvite = null;
  #tx;

  constructor(tx) { this.#tx = tx; }

  async #invite({ email, redirectTo, appMetadata }) {
    if (this.failInvite) throw new AuthAdminError('invite', { code: this.failInvite, status: 429 });
    const id = randomUUID();
    await this.#tx`insert into auth.users (id, email, raw_app_meta_data) values (${id}, ${email}, ${this.#tx.json(appMetadata)})`;
    this.invited.push({ id, email, tenantId: appMetadata.tenant_id, branchId: appMetadata.branch_id ?? null, role: appMetadata.role, redirectTo });
    return id;
  }

  inviteOwner({ email, tenantId, redirectTo }) {
    return this.#invite({ email, redirectTo, appMetadata: { role: 'tenant_owner', tenant_id: tenantId } });
  }

  inviteStaff({ email, tenantId, branchId, redirectTo }) {
    return this.#invite({ email, redirectTo, appMetadata: { role: 'tenant_staff', tenant_id: tenantId, branch_id: branchId } });
  }

  async setStaffBranch(userId, { tenantId, branchId }) {
    await this.#tx`update auth.users set raw_app_meta_data = ${this.#tx.json({ role: 'tenant_staff', tenant_id: tenantId, branch_id: branchId })} where id = ${userId}`;
  }

  async changeEmail(userId, email) { await this.#tx`update auth.users set email = ${email} where id = ${userId}`; }

  async deleteUser(userId) {
    await this.#tx`delete from auth.users where id = ${userId}`;
    this.deleted.push(userId);
  }

  deleted = [];
}

class FakePhotoStorage {
  uploads = [];

  async upload(path, buffer) {
    this.uploads.push({ path, buffer });
    return `${settings.supabase.url}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
  }
}

export function openHarness() {
  assertDevelopmentTarget();
  const database = new Database({ logger: silent });
  let counter = 0;

  async function run(work) {
    try {
      await database.sql.begin(async (tx) => {
        // All requests share this one connection, so their savepoints run one after
        // another, as the database's row locks make real transactions do.
        let queue = Promise.resolve();
        const withTx = (fn) => {
          const run = queue.then(() => tx.savepoint(fn));
          queue = run.catch(() => {});
          return run;
        };
        const testDatabase = { sql: tx, withTx, ping: async () => {}, close: async () => {} };
        const auth = new FakeAuthAdmin(tx);
        const photos = new FakePhotoStorage();
        const services = createServices({
          database: testDatabase, verifyToken, authAdmin: auth, photoStorage: photos,
          limits: createRateLimits({ dinerReads: { limit: 1000, windowMs: 60_000 }, pairing: { limit: 1000, windowMs: 60_000 } }),
        });
        const server = createApp({ appLogger: silent, router: createApiRouter(services) }).listen(0, '127.0.0.1');
        await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;

        async function call(method, path, { token, body, headers = {} } = {}) {
          const response = await fetch(`${base}${path}`, {
            method,
            headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${await token}` } : {}), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const text = await response.text();
          return { status: response.status, body: text ? JSON.parse(text) : null };
        }

        const api = {
          sql: tx, auth, photos, call,
          admin: (scope = FOUNDER, { aal = 'aal2', name = 'Test founder' } = {}) => sign(randomUUID(), {
            email: 'founder@example.invalid', aal, app_metadata: { role: 'super_admin', admin_scope: scope, name },
          }),
          owner: (tenantId, userId) => sign(userId, { app_metadata: { role: 'tenant_owner', tenant_id: tenantId } }),
          staff: (tenantId, branchId, userId) => sign(userId, { app_metadata: { role: 'tenant_staff', tenant_id: tenantId, branch_id: branchId } }),

          /** Signs up a restaurant through the API; returns its detail and the owner's token. */
          async restaurant(overrides = {}, scope = FOUNDER) {
            counter += 1;
            const unique = `${Date.now().toString(36)}${counter}${randomUUID().slice(0, 6)}`;
            const body = {
              businessName: `Stage3 Test ${unique}`, city: 'Rawalpindi', ownerName: 'Test Owner', ownerPhone: '0312 1234567',
              ownerEmail: `stage3-${unique}@example.invalid`, country: 'PK', planId: 'growth', startAs: 'active',
              trialDays: 30, addons: [], reason: 'Signed up in a test', ...overrides,
            };
            const created = await call('POST', '/admin/tenants', { token: api.admin(scope), body });
            if (created.status !== 201) throw new Error(`Test restaurant was not created: ${created.status} ${JSON.stringify(created.body)}`);
            const detail = created.body;
            const ownerId = detail.team.find((member) => member.role === 'tenant_owner').id;
            return {
              detail, id: detail.tenant.id, mainBranchId: detail.branches[0].id, ownerId,
              ownerToken: api.owner(detail.tenant.id, ownerId),
            };
          },

          async addBranch(tenantId, name = 'Second branch') {
            const [row] = await tx`insert into dinein.branches (tenant_id, name, area) values (${tenantId}, ${name}, 'Test area') returning id`;
            return row.id;
          },

          /** Diners: open every day, all day, so ordering tests don't depend on the clock. */
          async openAllDay(ownerToken) {
            const hours = Array.from({ length: 7 }, (_, day) => ({ day, open: true, opensAt: '00:00', closesAt: '00:00' }));
            const saved = await call('PATCH', '/portal/service', { token: ownerToken, body: { hours } });
            if (saved.status !== 200) throw new Error(`Hours not saved: ${saved.status} ${JSON.stringify(saved.body)}`);
          },

          /** Pairs a counter at a branch through the API, and returns its device token. */
          async pairCounter(ownerToken, branchId, name = 'Front counter') {
            const made = await call('POST', '/portal/counters/pairing-codes', { token: ownerToken, body: { branchId } });
            const code = made.body.pairingCodes.find((entry) => entry.branchId === branchId).code;
            const paired = await call('POST', '/counter/pair', { body: { code, name } });
            if (paired.status !== 200) throw new Error(`Counter not paired: ${paired.status} ${JSON.stringify(paired.body)}`);
            return paired.body.deviceToken;
          },

          /** Gives someone a PIN and unlocks a counter with it; returns a caller for /portal as that counter. */
          async unlockCounter(ownerToken, deviceToken, userId, pin = '4321') {
            await call('PUT', `/portal/team/${userId}/pin`, { token: ownerToken, body: { pin } });
            const unlocked = await call('POST', '/counter/unlock', { headers: { 'x-counter-device': deviceToken }, body: { userId, pin } });
            if (unlocked.status !== 200) throw new Error(`Counter not unlocked: ${unlocked.status} ${JSON.stringify(unlocked.body)}`);
            const headers = { 'x-counter-device': deviceToken, authorization: `Bearer ${unlocked.body.staffToken}` };
            return (method, path, body, extra = {}) => call(method, `/portal${path}`, { body, headers: { ...headers, ...extra } });
          },

          /** A staff member at one branch, and their token. */
          async addStaff(tenantId, branchId, name = 'Test Staff') {
            const id = randomUUID();
            const email = `stage3-staff-${id}@example.invalid`;
            await tx`insert into auth.users (id, email) values (${id}, ${email})`;
            await tx`insert into dinein.team_members (id, tenant_id, name, email, role, branch_id)
              values (${id}, ${tenantId}, ${name}, ${email}, 'tenant_staff', ${branchId})`;
            return { id, token: api.staff(tenantId, branchId, id) };
          },
        };

        try {
          await work(api);
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  return { run, close: () => database.close() };
}

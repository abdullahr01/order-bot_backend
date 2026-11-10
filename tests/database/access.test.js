// Real-database checks of the auth and plan lookups. Everything is rolled back.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuthRepository } from '../../db/auth.repository.js';
import { assertDevelopmentTarget } from '../../db/config.js';
import { Database } from '../../db/database.js';
import { EntitlementRepository } from '../../db/entitlement.repository.js';
import { EntitlementModel } from '../../model/entitlement.model.js';
import { AuditService } from '../../service/audit.service.js';
import { EntitlementService } from '../../service/entitlement.service.js';
import { createLogger } from '../../shared/logger.js';
import { createFixture } from './fixtures.js';

let database;
const rollback = new Error('Intentional fixture rollback');
const silent = createLogger({ environment: 'test', level: 'silent' });
const hash = () => randomBytes(32).toString('hex');

before(() => {
  assertDevelopmentTarget();
  database = new Database({ logger: silent });
});
after(async () => { if (database) await database.close(); });

const rolledBack = (work) => assert.rejects(database.withTx(async (tx) => {
  await work(tx);
  throw rollback;
}), (error) => error === rollback);

async function addMember(tx, fixture, role, branchId) {
  const id = randomUUID();
  const email = `access-test-${id}@example.invalid`;
  await tx`insert into auth.users (id, email) values (${id}, ${email})`;
  await tx`insert into dinein.team_members (id, tenant_id, name, email, role, branch_id) values (${id}, ${fixture.tenantId}, 'Test person', ${email}, ${role}, ${branchId})`;
  return id;
}

test('a team member is only found inside their own restaurant', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const b = await createFixture(tx);
  const repository = new AuthRepository(tx);
  const staff = await addMember(tx, a, 'tenant_staff', a.branchId);

  const found = await repository.findTeamMember(staff, a.tenantId);
  assert.deepEqual([found.role, found.branch_id, found.branch_retired], ['tenant_staff', a.branchId, false]);
  assert.equal(await repository.findTeamMember(staff, b.tenantId), null);
  assert.equal(await repository.findTeamMember(randomUUID(), a.tenantId), null);

  await tx`update dinein.branches set retired_at = now() where id = ${a.branchId}`;
  assert.equal((await repository.findTeamMember(staff, a.tenantId)).branch_retired, true);
}));

test('a counter finds its device, and a person only with this device’s own staff token', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const repository = new AuthRepository(tx);
  const person = await addMember(tx, a, 'tenant_staff', a.mainId);
  await tx`insert into dinein.counter_pins (tenant_id, user_id, pin_hash) values (${a.tenantId}, ${person}, '$argon2id$fixture-only')`;
  const [mainDeviceHash, otherDeviceHash, staffHash] = [hash(), hash(), hash()];
  const [main] = await tx`insert into dinein.counter_devices (tenant_id, branch_id, name, token_hash, paired_by) values (${a.tenantId}, ${a.mainId}, 'Front', ${mainDeviceHash}, 'Test') returning id`;
  const [other] = await tx`insert into dinein.counter_devices (tenant_id, branch_id, name, token_hash, paired_by) values (${a.tenantId}, ${a.mainId}, 'Back', ${otherDeviceHash}, 'Test') returning id`;
  await tx`insert into dinein.counter_unlocks (tenant_id, branch_id, device_id, user_id, token_hash) values (${a.tenantId}, ${a.mainId}, ${main.id}, ${person}, ${staffHash})`;

  const unlocked = await repository.findCounter(mainDeviceHash, staffHash);
  assert.deepEqual([unlocked.id, unlocked.tenant_id, unlocked.branch_id, unlocked.status, unlocked.user_id, unlocked.person_role],
    [main.id, a.tenantId, a.mainId, 'active', person, 'tenant_staff']);

  assert.equal((await repository.findCounter(mainDeviceHash, null)).user_id, null);
  assert.equal((await repository.findCounter(mainDeviceHash, hash())).user_id, null);
  const wrongDevice = await repository.findCounter(otherDeviceHash, staffHash);
  assert.deepEqual([wrongDevice.id, wrongDevice.user_id], [other.id, null]);
  assert.equal(await repository.findCounter(hash(), staffHash), null);

  const [{ last_seen_at: seen }] = await tx`select last_seen_at from dinein.counter_devices where id = ${main.id}`;
  assert.ok(seen, 'last seen is recorded');
}));

test('platform-team scope reads the restaurant’s country and partner', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const repository = new AuthRepository(tx);
  assert.deepEqual(await repository.findTenantScope(a.tenantId), { country: 'PK', partnerId: null });
  assert.equal(await repository.findTenantScope(randomUUID()), null);
}));

test('access uses the restaurant’s own country price list, add-ons and overrides', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const service = new EntitlementService({ repository: new EntitlementRepository(tx) });

  const pakistan = await service.forTenant(a.tenantId);
  assert.equal(pakistan.catalog.plans.starter.monthlyPrice, 15000);
  assert.equal(pakistan.tenant.timezone, 'Asia/Karachi');
  assert.equal(pakistan.limits.tables, 10);
  assert.ok(pakistan.features.has('qr_ordering') && !pakistan.features.has('time_menus'));

  await tx`update dinein.tenants set country = 'GB', currency = 'GBP', timezone = 'Europe/London', tax_profile = 'gb_vat' where id = ${a.tenantId}`;
  await tx`insert into dinein.tenant_addons (tenant_id, addon_id, quantity) values (${a.tenantId}, 'extra_tables', 3)`;
  await tx`insert into dinein.tenant_overrides (tenant_id, feature_key, granted, reason, created_by) values (${a.tenantId}, 'time_menus', true, 'Pilot offer', 'Test')`;
  const uk = await service.forTenant(a.tenantId);
  assert.equal(uk.catalog.plans.starter.monthlyPrice, 99);
  assert.equal(uk.catalog.addons.extra_tables.monthlyPrice, 5);
  assert.deepEqual(uk.catalog.addons.extra_tables.unit, { limit: 'tables', one: 'table', many: 'tables' });
  assert.equal(uk.limits.tables, 13);
  assert.ok(uk.features.has('time_menus'));
  assert.match(uk.overrides[0].createdAt, /Z$/);

  await tx`update dinein.subscriptions set status = 'past_due', past_due_since = now() - interval '31 days' where tenant_id = ${a.tenantId}`;
  const overdue = await service.forTenant(a.tenantId);
  assert.ok(overdue.setupLocked && !overdue.readOnly);
  assert.ok(overdue.paused.includes('reports_basic') && !overdue.features.has('reports_basic'));

  await tx`update dinein.subscriptions set status = 'suspended' where tenant_id = ${a.tenantId}`;
  assert.ok((await service.forTenant(a.tenantId)).readOnly);
  assert.equal(await service.forTenant(randomUUID()), null);
}));

test('the model handles a restaurant with no add-ons or overrides', () => {
  const plan = { id: 'starter', name: 'Starter', monthly_price: 1, setup_fee: 1, tagline: null, features: [], limits: {} };
  const row = { id: 't', country: 'PK', currency: 'PKR', timezone: 'Asia/Karachi', plan_id: 'starter', status: 'active', setup_fee: 1, tenant_addons: [], tenant_overrides: [], catalog_plans: [plan], catalog_addons: [] };
  const mapped = EntitlementModel.fromRow(row);
  assert.deepEqual(mapped.addons, []);
  assert.equal(mapped.catalog.plans.starter.tagline, '');
});

test('audit records name the restaurant and can stand alone for price-list changes', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const audit = new AuditService();
  const tenantEvent = await audit.record(tx, { tenantId: a.tenantId, action: 'plan_changed', actor: 'Founder', before: 'Starter', after: 'Growth', reason: 'Asked to upgrade' });
  const [row] = await tx`select tenant_name, "before", "after", reason from dinein.entitlement_events where id = ${tenantEvent}`;
  assert.deepEqual({ ...row }, { tenant_name: `schema-test-${a.tenantId}`, before: 'Starter', after: 'Growth', reason: 'Asked to upgrade' });

  const catalogEvent = await audit.record(tx, { tenantName: 'Starter plan', action: 'catalog_plan_updated', actor: 'Founder', after: '£109/mo', reason: 'Agreed UK pricing', country: 'GB' });
  const [catalog] = await tx`select tenant_id, tenant_name, country from dinein.entitlement_events where id = ${catalogEvent}`;
  assert.deepEqual({ ...catalog }, { tenant_id: null, tenant_name: 'Starter plan', country: 'GB' });
}));

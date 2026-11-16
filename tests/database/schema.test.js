// Real-database checks. Most fixtures live inside rolled-back transactions; the
// concurrency test commits its own uniquely named rows and deletes only those.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { assertDevelopmentTarget } from '../../db/config.js';
import { Database, allocateOrderNumber } from '../../db/database.js';
import { createFixture, cleanupFixture } from './fixtures.js';
import { createLogger } from '../../shared/logger.js';

let database;
const rollback = new Error('Intentional fixture rollback');
const silent = createLogger({ environment: 'test', level: 'silent' });

before(() => {
  assertDevelopmentTarget();
  database = new Database({ logger: silent });
});
after(async () => { if (database) await database.close(); });

async function rolledBack(work) {
  await assert.rejects(database.withTx(async (tx) => {
    await work(tx);
    throw rollback;
  }), (error) => error === rollback);
}
async function rejected(tx, work, code) {
  await assert.rejects(tx.savepoint(work), (error) => error.code === code);
}
const token = () => randomBytes(24).toString('base64url');

test('all 36 tables have RLS and only the API connection can reach them', async () => {
  const rows = await database.sql`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'dinein' and c.relkind = 'r'`;
  assert.equal(rows.length, 36);
  assert.ok(rows.some((row) => row.relname === 'idempotency_keys'), 'the Idempotency-Key table (Stage 4)');
  assert.ok(rows.some((row) => row.relname === 'job_runs'), 'the notebook of the daily jobs (Stage 6)');
  assert.ok(rows.every((row) => row.relrowsecurity));
  const [privileges] = await database.sql`select
    has_schema_privilege('anon','dinein','USAGE') as anon,
    has_schema_privilege('authenticated','dinein','USAGE') as authenticated,
    has_table_privilege('service_role','dinein.orders','SELECT') as service_role,
    has_table_privilege('service_role','dinein.idempotency_keys','SELECT') as service_role_keys,
    has_table_privilege('service_role','dinein.job_runs','SELECT') as service_role_jobs`;
  assert.deepEqual({ ...privileges }, { anon: false, authenticated: false, service_role: false, service_role_keys: false, service_role_jobs: false });
});

test('each country has its own catalogue: Pakistan confirmed, UK prices still placeholders', async () => {
  const plans = await database.sql`select country, id, monthly_price, setup_fee, tagline, limits from dinein.catalog_plans order by country desc, monthly_price`;
  assert.deepEqual(plans.map((plan) => [plan.country, plan.id, plan.monthly_price, plan.setup_fee, plan.limits.tables, plan.limits.staff_accounts]), [
    ['PK','starter',15000,30000,10,3],['PK','growth',25000,40000,20,6],['PK','pro',35000,50000,50,10],
    ['GB','starter',99,199,10,3],['GB','growth',169,299,20,6],['GB','pro',249,399,50,10],
  ]);
  assert.ok(plans.every((plan) => plan.tagline));
  assert.equal(plans[2].limits.stations, null);
  const addons = await database.sql`select country, id, monthly_price, plan_share, available_to from dinein.catalog_addons order by id`;
  assert.equal(addons.length, 8);
  const addon = (country, id) => addons.find((row) => row.country === country && row.id === id);
  assert.equal(addon('PK', 'extra_tables').monthly_price, 1000);
  assert.equal(addon('GB', 'extra_tables').monthly_price, 5);
  assert.equal(addon('GB', 'extra_branch').plan_share, 80);
  assert.equal(addon('GB', 'extra_branch').monthly_price, null);
  assert.deepEqual(addon('GB', 'extra_station').available_to, ['starter']);
  const countries = await database.sql`select country, prices_confirmed from dinein.catalog_countries order by country`;
  assert.deepEqual(countries.map((row) => [row.country, row.prices_confirmed]), [['GB', false], ['PK', true]]);
});

test('core rules: table numbers reuse, overrides stack, waiter names, partners and countries', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  await tx`update dinein.dining_tables set active = false where id = ${a.tableId}`;
  await tx`insert into dinein.dining_tables (tenant_id,branch_id,number,seats,token) values (${a.tenantId},${a.mainId},1,4,${token()})`;
  await rejected(tx, (sql) => sql`insert into dinein.dining_tables (tenant_id,branch_id,number,seats,token) values (${a.tenantId},${a.mainId},1,4,${token()})`, '23505');
  for (let i = 0; i < 2; i++) {
    await tx`insert into dinein.tenant_overrides (tenant_id,feature_key,granted,reason,created_by) values (${a.tenantId},'time_menus',true,'Pilot offer','Test')`;
  }
  const [waiter] = await tx`insert into dinein.waiters (tenant_id,branch_id,name) values (${a.tenantId},${a.mainId},'Shahid') returning id`;
  await rejected(tx, (sql) => sql`insert into dinein.waiters (tenant_id,branch_id,name) values (${a.tenantId},${a.mainId},'shahid')`, '23505');
  await tx`update dinein.waiters set retired_at = now() where id = ${waiter.id}`;
  await tx`insert into dinein.waiters (tenant_id,branch_id,name) values (${a.tenantId},${a.mainId},'Shahid')`;
  const [partner] = await tx`insert into dinein.partners (name,countries,contact_name,contact_email) values ('Test partner',array['GB'],'Contact','partner@example.invalid') returning id`;
  await tx`update dinein.tenants set country = 'GB', currency = 'GBP', timezone = 'Europe/London', tax_profile = 'gb_vat', partner_id = ${partner.id} where id = ${a.tenantId}`;
  await tx`insert into dinein.partner_settlements (partner_id,month,amount,recorded_by) values (${partner.id},'2026-10-01',120.50,'Founder')`;
  await rejected(tx, (sql) => sql`insert into dinein.partner_settlements (partner_id,month,amount,recorded_by) values (${partner.id},'2026-10-01',1,'Founder')`, '23505');
  await rejected(tx, (sql) => sql`update dinein.tenants set country = 'FR' where id = ${a.tenantId}`, '23514');
  await rejected(tx, (sql) => sql`update dinein.subscriptions set plan_id = 'gold' where tenant_id = ${a.tenantId}`, '23514');
  await tx`insert into dinein.entitlement_events (tenant_name,action,actor,"before","after",reason,country) values ('Test partner','partner_payment_recorded','Founder',null,'2026-10: 120',null,'GB')`;
}));

test('a restaurant requires one main branch and cannot have two', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  await tx`set constraints all immediate`;
  await rejected(tx, (sql) => sql`update dinein.branches set is_main = true where id = ${a.branchId}`, '23505');
  await rejected(tx, (sql) => sql`update dinein.branches set is_main = false where id = ${a.mainId}`, '23514');
  await rejected(tx, (sql) => sql`insert into dinein.tenants (business_name,slug,city,owner_name,owner_phone,owner_email)
    values ('Missing main test', ${`schema-test-${randomUUID()}`},'Test','Owner','000',${`${randomUUID()}@example.invalid`})`, '23514');
}));

test('foreign keys prevent cross-restaurant and cross-branch links', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const b = await createFixture(tx);
  await rejected(tx, (sql) => sql`insert into dinein.table_sessions (tenant_id,branch_id,table_id) values (${a.tenantId},${a.mainId},${b.tableId})`, '23503');
  await rejected(tx, (sql) => sql`insert into dinein.table_sessions (tenant_id,branch_id,table_id) values (${a.tenantId},${a.branchId},${a.tableId})`, '23503');
  await rejected(tx, (sql) => sql`insert into dinein.menu_items (tenant_id,category_id,name,price,position) values (${a.tenantId},${b.categoryId},'Invalid dish',1,0)`, '23503');
}));

test('sessions, table numbers, stations, payments and open requests enforce uniqueness', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const [session] = await tx`insert into dinein.table_sessions (tenant_id,branch_id,table_id,status) values (${a.tenantId},${a.mainId},${a.tableId},'bill_requested') returning id`;
  await rejected(tx, (sql) => sql`insert into dinein.table_sessions (tenant_id,branch_id,table_id) values (${a.tenantId},${a.mainId},${a.tableId})`, '23505');
  await rejected(tx, (sql) => sql`insert into dinein.dining_tables (tenant_id,branch_id,number,seats,token) values (${a.tenantId},${a.mainId},1,4,${token()})`, '23505');
  await tx`insert into dinein.stations (tenant_id,name,position) values (${a.tenantId},'Tandoor',0)`;
  await rejected(tx, (sql) => sql`insert into dinein.stations (tenant_id,name,position) values (${a.tenantId},'tandoor ',1)`, '23505');
  await tx`insert into dinein.payments (tenant_id,kind,month,amount,method,recorded_by) values (${a.tenantId},'monthly','2026-10-01',15000,'cash','Test')`;
  await rejected(tx, (sql) => sql`insert into dinein.payments (tenant_id,kind,month,amount,method,recorded_by) values (${a.tenantId},'monthly','2026-10-01',15000,'cash','Test')`, '23505');
  await tx`insert into dinein.payments (tenant_id,kind,amount,method,recorded_by) values (${a.tenantId},'setup',30000,'cash','Test')`;
  await rejected(tx, (sql) => sql`insert into dinein.payments (tenant_id,kind,amount,method,recorded_by) values (${a.tenantId},'setup',30000,'cash','Test')`, '23505');
  await tx`insert into dinein.service_requests (tenant_id,branch_id,table_id,table_number,session_id,kind) values (${a.tenantId},${a.mainId},${a.tableId},1,${session.id},'water')`;
  await rejected(tx, (sql) => sql`insert into dinein.service_requests (tenant_id,branch_id,table_id,table_number,session_id,kind) values (${a.tenantId},${a.mainId},${a.tableId},1,${session.id},'water')`, '23505');
  await rejected(tx, (sql) => sql`insert into dinein.service_requests (tenant_id,branch_id,table_id,table_number,session_id,kind) values (${a.tenantId},${a.mainId},${a.tableId},1,${session.id},'pizza')`, '23514');
}));

test('orders follow the guide: 3-character cancel reason, finished time required, onboarding may be absent', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const order = (sql, number, status, reason, by, finished) => sql`insert into dinein.orders
    (tenant_id,branch_id,number,business_day,items,total,status,source,entered_by,cancel_reason,cancelled_by,finished_at)
    values (${a.tenantId},${a.mainId},${number},'2026-11-09','[{"name":"Test dish","quantity":1,"unitPrice":100}]',100,${status},'staff','staff',${reason},${by},${finished})`;
  await order(tx, 1200, 'cancelled', 'Off', 'Test', new Date());
  await order(tx, 1201, 'new', null, null, null);
  await rejected(tx, (sql) => order(sql, 1202, 'cancelled', 'No', 'Test', new Date()), '23514');
  await rejected(tx, (sql) => order(sql, 1203, 'served', null, null, null), '23514');
  await rejected(tx, (sql) => order(sql, 1204, 'new', null, null, new Date()), '23514');
  await tx`update dinein.tenants set onboarding = null where id = ${a.tenantId}`;
}));

test('audit rows cannot be changed or deleted', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const [event] = await tx`insert into dinein.entitlement_events (tenant_id,action,actor,reason) values (${a.tenantId},'test','Schema test','Testing audit') returning id`;
  await rejected(tx, (sql) => sql`update dinein.entitlement_events set reason = 'Changed reason' where id = ${event.id}`, '42501');
  await rejected(tx, (sql) => sql`delete from dinein.entitlement_events where id = ${event.id}`, '42501');
}));

test('PIN/device ownership and one unlock per device are enforced; PIN change revokes unlocks', async () => rolledBack(async (tx) => {
  const a = await createFixture(tx);
  const hash = () => randomBytes(32).toString('hex');
  // Transactional fixture only: no Auth API call, no invite, rolled back at end.
  await tx`insert into auth.users (id,email) values (${a.userId},${`schema-test-${a.userId}@example.invalid`})`;
  await tx`insert into dinein.team_members (id,tenant_id,name,email,role,branch_id) values (${a.userId},${a.tenantId},'Test staff',${`schema-test-${a.userId}@example.invalid`},'tenant_staff',${a.mainId})`;
  await tx`insert into dinein.counter_pins (tenant_id,user_id,pin_hash) values (${a.tenantId},${a.userId},'$argon2id$fixture-only')`;
  const [device] = await tx`insert into dinein.counter_devices (tenant_id,branch_id,name,token_hash,paired_by) values (${a.tenantId},${a.mainId},'Test PC',${hash()},'Test') returning id`;
  await tx`insert into dinein.counter_unlocks (tenant_id,branch_id,device_id,user_id,token_hash) values (${a.tenantId},${a.mainId},${device.id},${a.userId},${hash()})`;
  await rejected(tx, (sql) => sql`insert into dinein.counter_unlocks (tenant_id,branch_id,device_id,user_id,token_hash) values (${a.tenantId},${a.mainId},${device.id},${a.userId},${hash()})`, '23505');
  await tx`update dinein.counter_pins set pin_hash = '$argon2id$changed-fixture-only' where user_id = ${a.userId}`;
  assert.equal((await tx`select token_hash from dinein.counter_unlocks where device_id = ${device.id}`).length, 0);
  const [wrongDevice] = await tx`insert into dinein.counter_devices (tenant_id,branch_id,name,token_hash,paired_by) values (${a.tenantId},${a.branchId},'Other PC',${hash()},'Test') returning id`;
  await rejected(tx, (sql) => sql`insert into dinein.counter_unlocks (tenant_id,branch_id,device_id,user_id,token_hash) values (${a.tenantId},${a.branchId},${wrongDevice.id},${a.userId},${hash()})`, '23514');
}));

test('transactions roll back, order numbers never collide and a table gets one session', { timeout: 60000 }, async () => {
  let a;
  try {
    a = await database.withTx((tx) => createFixture(tx));
    await assert.rejects(database.withTx(async (tx) => {
      await tx`insert into dinein.waiters (tenant_id,branch_id,name) values (${a.tenantId},${a.mainId},'Rolled back')`;
      throw rollback;
    }), (error) => error === rollback);
    assert.equal((await database.sql`select id from dinein.waiters where tenant_id = ${a.tenantId}`).length, 0);
    const allocated = await Promise.all(Array.from({ length: 6 }, () => database.withTx(async (tx) => {
      const number = await allocateOrderNumber(tx, a.tenantId);
      await tx`insert into dinein.orders (tenant_id,branch_id,number,business_day,items,total,status,source,entered_by,entered_by_name)
        values (${a.tenantId},${a.mainId},${number.number},${number.day},'[{"name":"Test dish","quantity":1,"unitPrice":100}]',100,'accepted','staff','staff','Test')`;
      return number.number;
    })));
    assert.deepEqual(allocated.sort((x, y) => x - y), [1200,1201,1202,1203,1204,1205]);
    await assert.rejects(database.withTx(async (tx) => { await allocateOrderNumber(tx, a.tenantId); throw rollback; }), (error) => error === rollback);
    assert.equal((await database.withTx((tx) => allocateOrderNumber(tx, a.tenantId))).number, 1206);
    const sessions = await Promise.allSettled(Array.from({ length: 2 }, () => database.withTx(
      (tx) => tx`insert into dinein.table_sessions (tenant_id,branch_id,table_id) values (${a.tenantId},${a.mainId},${a.tableId})`)));
    assert.equal(sessions.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(sessions.find((result) => result.status === 'rejected').reason.code, '23505');
  } finally {
    if (a) await database.withTx((tx) => cleanupFixture(tx, a));
  }
});

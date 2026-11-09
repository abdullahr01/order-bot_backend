import { randomUUID, randomBytes } from 'node:crypto';

export async function createFixture(tx) {
  const tenantId = randomUUID();
  const mainId = randomUUID();
  const branchId = randomUUID();
  const tableId = randomUUID();
  const otherTableId = randomUUID();
  const categoryId = randomUUID();
  const userId = randomUUID();
  const label = `schema-test-${tenantId}`;
  await tx`insert into dinein.tenants (id, business_name, slug, city, owner_name, owner_phone, owner_email)
    values (${tenantId}, ${label}, ${label}, 'Test city', 'Test owner', '00000000000', ${`${label}@example.invalid`})`;
  await tx`insert into dinein.branches (id, tenant_id, name, area, is_main) values
    (${mainId}, ${tenantId}, 'Main branch', 'Test area', true),
    (${branchId}, ${tenantId}, 'Second branch', 'Test area', false)`;
  await tx`insert into dinein.subscriptions (tenant_id, plan_id, status, setup_fee) values (${tenantId}, 'starter', 'active', 30000)`;
  await tx`insert into dinein.dining_tables (id, tenant_id, branch_id, number, seats, token) values
    (${tableId}, ${tenantId}, ${mainId}, 1, 4, ${randomBytes(24).toString('base64url')}),
    (${otherTableId}, ${tenantId}, ${branchId}, 1, 4, ${randomBytes(24).toString('base64url')})`;
  await tx`insert into dinein.menu_categories (id, tenant_id, name, position) values (${categoryId}, ${tenantId}, 'Test dishes', 0)`;
  await tx`insert into dinein.menu_items (tenant_id, category_id, name, price, position) values (${tenantId}, ${categoryId}, 'Test dish', 100, 0)`;
  return { tenantId, mainId, branchId, tableId, otherTableId, userId, categoryId };
}

export async function cleanupFixture(tx, fixture) {
  // Exact fixture tenant only. Never run a blanket delete/truncate/reset.
  const tenantId = fixture.tenantId;
  await tx`delete from dinein.service_requests where tenant_id = ${tenantId}`;
  await tx`delete from dinein.diner_order_refs where tenant_id = ${tenantId}`;
  await tx`delete from dinein.orders where tenant_id = ${tenantId}`;
  await tx`delete from dinein.table_sessions where tenant_id = ${tenantId}`;
  await tx`delete from dinein.waiters where tenant_id = ${tenantId}`;
  await tx`delete from dinein.dining_tables where tenant_id = ${tenantId}`;
  await tx`delete from dinein.menu_items where tenant_id = ${tenantId}`;
  await tx`delete from dinein.menu_categories where tenant_id = ${tenantId}`;
  await tx`delete from dinein.tenants where id = ${tenantId}`;
}

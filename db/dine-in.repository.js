// Tables and waiters. Every query filters by the tenant from the verified credentials;
// the service also limits staff and counters to their own branch.
export class DineInRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  /** The Setup screen's tables (retired ones too) and waiters, for these branches. */
  async setup(tenantId, branchIds, sql = this.#sql) {
    const [row] = await sql`
      select
        coalesce((select json_agg(t order by t.number, t.active desc) from dinein.dining_tables t
          where t.tenant_id = ${tenantId} and t.branch_id = any(${branchIds}::uuid[])), '[]') as tables,
        coalesce((select json_agg(w order by lower(w.name)) from dinein.waiters w
          where w.tenant_id = ${tenantId} and w.branch_id = any(${branchIds}::uuid[]) and w.retired_at is null), '[]') as waiters`;
    return row;
  }

  /** Locks the restaurant's table count for the transaction, so two adds can't pass the limit together. */
  async lockTables(tx, tenantId) {
    await tx`select 1 from dinein.subscriptions where tenant_id = ${tenantId} for update`;
    const [row] = await tx`select count(*)::int as active from dinein.dining_tables where tenant_id = ${tenantId} and active`;
    return row.active;
  }

  async findTable(tx, tenantId, id) {
    const [row] = await tx`
      select t.*,
        exists (select 1 from dinein.table_sessions s where s.table_id = t.id and s.status <> 'closed') as has_party,
        exists (select 1 from dinein.table_sessions s where s.table_id = t.id) as has_history
      from dinein.dining_tables t where t.tenant_id = ${tenantId} and t.id = ${id}`;
    return row ?? null;
  }

  async numberTaken(tx, tenantId, branchId, number, exceptId = null) {
    const [row] = await tx`select exists (select 1 from dinein.dining_tables
      where tenant_id = ${tenantId} and branch_id = ${branchId} and number = ${number} and active
        and (${exceptId}::uuid is null or id <> ${exceptId}::uuid)) as taken`;
    return row.taken;
  }

  async insertTable(tx, tenantId, { branchId, number, label, seats }, token) {
    await tx`insert into dinein.dining_tables (tenant_id, branch_id, number, label, seats, token)
      values (${tenantId}, ${branchId}, ${number}, ${label}, ${seats}, ${token})`;
  }

  async updateTable(tx, tenantId, id, { branchId, number, label, seats, active }) {
    await tx`update dinein.dining_tables set branch_id = ${branchId}, number = ${number}, label = ${label},
      seats = ${seats}, active = ${active} where tenant_id = ${tenantId} and id = ${id}`;
  }

  /** The old code stops working at once: the token is the only thing in it. */
  async replaceToken(tx, tenantId, id, token) {
    await tx`update dinein.dining_tables set token = ${token} where tenant_id = ${tenantId} and id = ${id}`;
  }

  async waiterNameTaken(tx, tenantId, branchId, name) {
    const [row] = await tx`select exists (select 1 from dinein.waiters where tenant_id = ${tenantId} and branch_id = ${branchId}
      and retired_at is null and lower(btrim(name)) = lower(btrim(${name}))) as taken`;
    return row.taken;
  }

  async insertWaiter(tx, tenantId, { branchId, name }) {
    await tx`insert into dinein.waiters (tenant_id, branch_id, name) values (${tenantId}, ${branchId}, ${name})`;
  }

  async findWaiter(tx, tenantId, id) {
    const [row] = await tx`
      select w.*, exists (select 1 from dinein.table_sessions s where s.tenant_id = w.tenant_id and s.waiter_id = w.id and s.status <> 'closed') as busy
      from dinein.waiters w where w.tenant_id = ${tenantId} and w.id = ${id} and w.retired_at is null`;
    return row ?? null;
  }

  /** Kept, not deleted: past orders and tables still name the waiter. */
  async retireWaiter(tx, tenantId, id, now) {
    await tx`update dinein.waiters set retired_at = ${now} where tenant_id = ${tenantId} and id = ${id}`;
  }
}

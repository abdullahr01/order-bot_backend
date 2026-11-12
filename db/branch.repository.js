// A restaurant's branches, for the platform console. Removed branches are retired
// (`retired_at`), never deleted: orders, tables and sessions still refer to them.
export class BranchRepository {
  async live(tx, tenantId) {
    return tx`select * from dinein.branches where tenant_id = ${tenantId} and retired_at is null order by is_main desc, created_at`;
  }

  async insert(tx, tenantId, { name, area, now }) {
    await tx`insert into dinein.branches (tenant_id, name, area, is_main, created_at) values (${tenantId}, ${name}, ${area}, false, ${now})`;
  }

  async update(tx, tenantId, id, { name, area }) {
    await tx`update dinein.branches set name = ${name}, area = ${area} where tenant_id = ${tenantId} and id = ${id}`;
  }

  /** What still belongs to the branch: active tables and staff logins (waiters don't block, as in core). */
  async inUse(tx, tenantId, id) {
    const [row] = await tx`select
      (select count(*)::int from dinein.dining_tables where tenant_id = ${tenantId} and branch_id = ${id} and active) as tables,
      (select count(*)::int from dinein.team_members where tenant_id = ${tenantId} and branch_id = ${id}) as staff`;
    return row;
  }

  /** Its counter PCs stop working at once (the auth check refuses a retired branch). */
  async retire(tx, tenantId, id, now) {
    await tx`update dinein.branches set retired_at = ${now} where tenant_id = ${tenantId} and id = ${id} and not is_main`;
  }
}

// The signed-in restaurant's own records. Every query filters by the restaurant
// (and, for staff and counters, the branch) taken from the verified credentials.
export class PortalRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  /** The restaurant and the branches this person may see: every branch for owners, main first. */
  async findAccount(tenantId, branchId = null) {
    const [row] = await this.#sql`
      select t.id, t.business_name, t.city, t.slug, t.owner_name,
        coalesce((select json_agg(b order by b.is_main desc, b.created_at) from dinein.branches b
          where b.tenant_id = t.id and b.retired_at is null and (${branchId}::uuid is null or b.id = ${branchId}::uuid)), '[]') as branches
      from dinein.tenants t where t.id = ${tenantId}`;
    return row ?? null;
  }

  /** Branches this person works with, as rows (owners: all, staff and counters: their own). */
  async visibleBranches(tenantId, branchId = null, sql = this.#sql) {
    return sql`select * from dinein.branches
      where tenant_id = ${tenantId} and retired_at is null and (${branchId}::uuid is null or id = ${branchId}::uuid)
      order by is_main desc, created_at`;
  }
}

// Opening hours, the owner's restaurant-wide pause and each branch's own pause.
// Every query filters by the tenant (and branch) from the verified credentials.
export class ServiceSettingsRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  async settings(tenantId, sql = this.#sql) {
    const [row] = await sql`select hours, paused_until from dinein.service_settings where tenant_id = ${tenantId}`;
    return row ?? null;
  }

  async save(tx, tenantId, { hours, pausedUntil }) {
    await tx`
      insert into dinein.service_settings (tenant_id, hours, paused_until) values (${tenantId}, ${tx.json(hours)}, ${pausedUntil})
      on conflict (tenant_id) do update set hours = excluded.hours, paused_until = excluded.paused_until`;
  }

  /**
   * A staff member's start page: their branch (an owner's main branch), its pause, and
   * today's counts. Waiting and in progress include any order still open from earlier.
   */
  async today(tenantId, branchId, sql = this.#sql) {
    const [row] = await sql`
      with branch as (
        select * from dinein.branches
        where tenant_id = ${tenantId} and retired_at is null and (case when ${branchId}::uuid is null then is_main else id = ${branchId}::uuid end)
      ), local_day as (
        select (now() at time zone timezone)::date as day from dinein.tenants where id = ${tenantId}
      )
      select to_jsonb(b) as branch, s.hours, s.paused_until as restaurant_paused_until, p.paused_until as branch_paused_until,
        (select count(*)::int from dinein.orders o where o.tenant_id = ${tenantId} and o.branch_id = b.id and o.status = 'new') as waiting,
        (select count(*)::int from dinein.orders o where o.tenant_id = ${tenantId} and o.branch_id = b.id and o.status = 'accepted') as in_progress,
        (select count(*)::int from dinein.orders o, local_day d where o.tenant_id = ${tenantId} and o.branch_id = b.id
          and o.status = 'served' and o.business_day = d.day) as completed,
        (select count(*)::int from dinein.orders o, local_day d where o.tenant_id = ${tenantId} and o.branch_id = b.id
          and o.status = 'cancelled' and o.business_day = d.day) as cancelled
      from branch b
      left join dinein.service_settings s on s.tenant_id = ${tenantId}
      left join dinein.branch_pauses p on p.tenant_id = ${tenantId} and p.branch_id = b.id`;
    return row ?? null;
  }

  async pauseBranch(tx, tenantId, branchId, pausedUntil) {
    await tx`
      insert into dinein.branch_pauses (branch_id, tenant_id, paused_until) values (${branchId}, ${tenantId}, ${pausedUntil})
      on conflict (branch_id) do update set paused_until = excluded.paused_until
      where dinein.branch_pauses.tenant_id = ${tenantId}`;
  }
}

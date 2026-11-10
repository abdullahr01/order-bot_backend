// Lookups behind every signed-in request. Combined into single statements because
// the portal and counters poll these constantly.
export class AuthRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  async findTeamMember(userId, tenantId) {
    const [row] = await this.#sql`
      select m.name, m.role, m.branch_id, b.retired_at is not null as branch_retired
      from dinein.team_members m
      left join dinein.branches b on b.tenant_id = m.tenant_id and b.id = m.branch_id
      where m.id = ${userId} and m.tenant_id = ${tenantId}`;
    return row ?? null;
  }

  /** The device, and the person unlocked on it when the staff token matches this device. */
  async findCounter(deviceHash, staffHash) {
    const [row] = await this.#sql`
      with seen as (
        update dinein.counter_devices set last_seen_at = now()
        where token_hash = ${deviceHash} and (last_seen_at is null or last_seen_at < now() - interval '1 minute')
        returning id
      )
      select d.id, d.tenant_id, d.branch_id, d.name, s.status, b.retired_at is not null as branch_retired,
        m.id as user_id, m.name as person_name, m.role as person_role, m.branch_id as person_branch_id
      from dinein.counter_devices d
      join dinein.subscriptions s on s.tenant_id = d.tenant_id
      join dinein.branches b on b.tenant_id = d.tenant_id and b.id = d.branch_id
      left join dinein.counter_unlocks u on u.device_id = d.id and u.token_hash = ${staffHash}
      left join dinein.team_members m on m.tenant_id = d.tenant_id and m.id = u.user_id
      where d.token_hash = ${deviceHash}`;
    return row ?? null;
  }

  /** What the platform-team scope rules need to know about a restaurant. */
  async findTenantScope(tenantId) {
    const [row] = await this.#sql`select country, partner_id from dinein.tenants where id = ${tenantId}`;
    return row ? { country: row.country, partnerId: row.partner_id } : null;
  }
}

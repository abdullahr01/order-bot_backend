// Counter PCs: pairing codes, paired devices and who is unlocked on each. Tokens are
// stored only as SHA-256 hashes. Every query filters by the tenant (and branch) from
// the verified device or owner.
export class CounterRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  async list(tenantId, now, sql = this.#sql) {
    const [row] = await sql`
      select
        coalesce((select json_agg(d order by d.paired_at) from (
          select id, tenant_id, branch_id, name, paired_at, paired_by, last_seen_at
          from dinein.counter_devices where tenant_id = ${tenantId}) d), '[]') as devices,
        coalesce((select json_agg(c order by c.expires_at desc) from dinein.pairing_codes c
          where c.tenant_id = ${tenantId} and c.expires_at > ${now}), '[]') as codes`;
    return row;
  }

  /**
   * A new code, unless that number is still open somewhere. An expired code with the
   * same digits is taken over (expired codes do nothing). Returns false to try another.
   */
  async insertCode(tx, { code, tenantId, branchId, expiresAt, createdBy, now }) {
    const rows = await tx`
      insert into dinein.pairing_codes (code, tenant_id, branch_id, expires_at, created_by)
      values (${code}, ${tenantId}, ${branchId}, ${expiresAt}, ${createdBy})
      on conflict (code) do update set tenant_id = excluded.tenant_id, branch_id = excluded.branch_id,
        expires_at = excluded.expires_at, created_by = excluded.created_by
      where dinein.pairing_codes.expires_at <= ${now}
      returning code`;
    return rows.length === 1;
  }

  /** The code being used, locked so it can only pair one PC. */
  async findCode(tx, code, now) {
    const [row] = await tx`
      select c.*, s.status, b.retired_at is not null as branch_retired
      from dinein.pairing_codes c
      join dinein.subscriptions s on s.tenant_id = c.tenant_id
      join dinein.branches b on b.tenant_id = c.tenant_id and b.id = c.branch_id
      where c.code = ${code} and c.expires_at > ${now}
      for update of c`;
    return row ?? null;
  }

  async pair(tx, { code, tenantId, branchId, name, tokenHash, pairedBy, now }) {
    const [device] = await tx`
      insert into dinein.counter_devices (tenant_id, branch_id, name, token_hash, paired_at, paired_by, last_seen_at)
      values (${tenantId}, ${branchId}, ${name}, ${tokenHash}, ${now}, ${pairedBy}, ${now})
      returning id`;
    await tx`delete from dinein.pairing_codes where code = ${code} and tenant_id = ${tenantId}`;
    return device.id;
  }

  /** Unpairs a PC; its unlock goes with it (cascade). */
  async remove(tx, tenantId, id) {
    const rows = await tx`delete from dinein.counter_devices where tenant_id = ${tenantId} and id = ${id} returning id`;
    return rows.length === 1;
  }

  /** The lock screen: the device, its restaurant and branch, and who can unlock it. */
  async session(tenantId, deviceId, sql = this.#sql) {
    const [row] = await sql`
      select d.id, d.tenant_id, d.branch_id, d.name, d.paired_at, d.paired_by, d.last_seen_at,
        t.business_name, to_jsonb(b) as branch,
        coalesce((select json_agg(json_build_object('id', m.id, 'name', m.name, 'role', m.role)
            order by m.role = 'tenant_owner', lower(m.name))
          from dinein.team_members m
          join dinein.counter_pins p on p.tenant_id = m.tenant_id and p.user_id = m.id
          where m.tenant_id = d.tenant_id and (m.role = 'tenant_owner' or m.branch_id = d.branch_id)), '[]') as people
      from dinein.counter_devices d
      join dinein.tenants t on t.id = d.tenant_id
      join dinein.branches b on b.tenant_id = d.tenant_id and b.id = d.branch_id
      where d.tenant_id = ${tenantId} and d.id = ${deviceId}`;
    return row ?? null;
  }

  /** Someone who may unlock this device (owner, or staff at its branch, with a PIN), locked for the PIN check. */
  async unlockable(tx, { tenantId, branchId, userId }) {
    const [row] = await tx`
      select m.id, m.name, m.role, p.pin_hash, p.failures, p.held_until
      from dinein.team_members m
      join dinein.counter_pins p on p.tenant_id = m.tenant_id and p.user_id = m.id
      where m.tenant_id = ${tenantId} and m.id = ${userId}
        and (m.role = 'tenant_owner' or m.branch_id = ${branchId})
      for update of p`;
    return row ?? null;
  }

  async setFailures(tx, tenantId, userId, { failures, heldUntil }) {
    await tx`update dinein.counter_pins set failures = ${failures}, held_until = ${heldUntil}
      where tenant_id = ${tenantId} and user_id = ${userId}`;
  }

  /** One person at a time per counter: unlocking replaces whoever was on it. */
  async replaceUnlock(tx, { tokenHash, tenantId, branchId, deviceId, userId }) {
    await tx`delete from dinein.counter_unlocks where tenant_id = ${tenantId} and device_id = ${deviceId}`;
    await tx`insert into dinein.counter_unlocks (token_hash, tenant_id, branch_id, device_id, user_id)
      values (${tokenHash}, ${tenantId}, ${branchId}, ${deviceId}, ${userId})`;
  }

  async lock(tenantId, deviceId) {
    await this.#sql`delete from dinein.counter_unlocks where tenant_id = ${tenantId} and device_id = ${deviceId}`;
  }
}

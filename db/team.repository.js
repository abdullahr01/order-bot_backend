// The restaurant's people and their counter PINs. Every query filters by the tenant
// from the verified credentials.
export class TeamRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  /** Owner first, then staff by name; `has_pin` only, never the PIN. */
  async members(tenantId, sql = this.#sql) {
    return sql`
      select m.*, p.user_id is not null as has_pin
      from dinein.team_members m
      left join dinein.counter_pins p on p.tenant_id = m.tenant_id and p.user_id = m.id
      where m.tenant_id = ${tenantId}
      order by m.role = 'tenant_owner' desc, lower(m.name)`;
  }

  async findMember(tx, tenantId, id) {
    const [row] = await tx`select * from dinein.team_members where tenant_id = ${tenantId} and id = ${id} for update`;
    return row ?? null;
  }

  /** Locks the restaurant for the transaction, so two adds can't pass the account limit together. */
  async lockAndCount(tx, tenantId) {
    await tx`select 1 from dinein.subscriptions where tenant_id = ${tenantId} for update`;
    const [row] = await tx`select count(*)::int as count from dinein.team_members where tenant_id = ${tenantId}`;
    return row.count;
  }

  async insertStaff(tx, tenantId, { id, name, email, branchId, now }) {
    await tx`insert into dinein.team_members (id, tenant_id, name, email, role, branch_id, created_at)
      values (${id}, ${tenantId}, ${name}, ${email}, 'tenant_staff', ${branchId}, ${now})`;
  }

  /** Moving branch ends the person's counter sessions (a database trigger). */
  async updateStaff(tx, tenantId, id, { name, branchId }) {
    await tx`update dinein.team_members set name = ${name}, branch_id = ${branchId}
      where tenant_id = ${tenantId} and id = ${id} and role = 'tenant_staff'`;
  }

  /** Their PIN and counter sessions go with them; orders keep their name as text. */
  async deleteStaff(tx, tenantId, id) {
    await tx`delete from dinein.counter_pins where tenant_id = ${tenantId} and user_id = ${id}`;
    await tx`delete from dinein.team_members where tenant_id = ${tenantId} and id = ${id} and role = 'tenant_staff'`;
  }

  /** A new PIN clears failed tries; the trigger ends the person's counter sessions. */
  async setPin(tx, tenantId, userId, pinHash) {
    await tx`
      insert into dinein.counter_pins (tenant_id, user_id, pin_hash, failures, held_until)
      values (${tenantId}, ${userId}, ${pinHash}, 0, null)
      on conflict (user_id) do update set pin_hash = excluded.pin_hash, failures = 0, held_until = null`;
  }

  /** Removing the PIN removes their counter sessions too (foreign key cascade). */
  async removePin(tx, tenantId, userId) {
    await tx`delete from dinein.counter_pins where tenant_id = ${tenantId} and user_id = ${userId}`;
  }
}

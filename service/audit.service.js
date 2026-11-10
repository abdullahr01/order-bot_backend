// The append-only record of every platform-team write (guide 2.4).
export class AuditService {
  /** Must receive the transaction doing the write, so the two commit together. */
  async record(tx, { tenantId = null, tenantName = null, action, featureKey = null, actor, before = null, after = null, reason = null, country = null }) {
    const [event] = await tx`
      insert into dinein.entitlement_events (tenant_id, tenant_name, action, feature_key, actor, "before", "after", reason, country)
      values (${tenantId}, coalesce(${tenantName}::text, (select business_name from dinein.tenants where id = ${tenantId}::uuid)),
        ${action}, ${featureKey}, ${actor}, ${before}, ${after}, ${reason}, ${country})
      returning id`;
    return event.id;
  }
}

export class EntitlementRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  /** Everything the access rules need, in one round trip, using the restaurant's own price list. */
  async loadForTenant(tenantId) {
    const [row] = await this.#sql`
      select t.id, t.country, t.currency, t.timezone,
        s.plan_id, s.status, s.trial_ends_at, s.current_period_end, s.past_due_since,
        s.scheduled_plan_id, s.billing_starts_at, s.setup_fee,
        coalesce((select json_agg(a) from dinein.tenant_addons a where a.tenant_id = t.id), '[]') as tenant_addons,
        coalesce((select json_agg(o) from dinein.tenant_overrides o where o.tenant_id = t.id), '[]') as tenant_overrides,
        (select json_agg(p) from dinein.catalog_plans p where p.country = t.country) as catalog_plans,
        (select json_agg(c) from dinein.catalog_addons c where c.country = t.country) as catalog_addons
      from dinein.tenants t
      join dinein.subscriptions s on s.tenant_id = t.id
      where t.id = ${tenantId}`;
    return row ?? null;
  }
}

// Each country's price list (plans and add-ons). Edits apply at once to every restaurant
// on the plan, because monthly values are always worked out from the live list.
export class CatalogRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  async load(country, sql = this.#sql) {
    const [row] = await sql`
      select
        (select json_agg(p order by p.monthly_price) from dinein.catalog_plans p where p.country = ${country}) as plans,
        (select json_agg(a order by a.id) from dinein.catalog_addons a where a.country = ${country}) as addons,
        (select prices_confirmed from dinein.catalog_countries where country = ${country}) as prices_confirmed`;
    return row;
  }

  /** Locks the country's list for the transaction: plan prices are checked against their neighbours. */
  async lock(tx, country) {
    await tx`select 1 from dinein.catalog_plans where country = ${country} for update`;
    return this.load(country, tx);
  }

  /** Restaurants in the country that aren't cancelled, with their live add-ons, for the usage figures. */
  async usageRows(country, now) {
    return this.#sql`
      select s.plan_id, s.status,
        coalesce((select json_agg(json_build_object('addon_id', a.addon_id, 'quantity', a.quantity))
          from dinein.tenant_addons a where a.tenant_id = t.id and (a.cancels_at is null or a.cancels_at > ${now})), '[]') as addons
      from dinein.tenants t join dinein.subscriptions s on s.tenant_id = t.id
      where t.country = ${country} and s.status <> 'cancelled'`;
  }

  async updatePlan(tx, country, id, plan) {
    await tx`update dinein.catalog_plans set monthly_price = ${plan.monthlyPrice}, setup_fee = ${plan.setupFee}, tagline = ${plan.tagline},
      features = ${tx.json(plan.features)}, limits = ${tx.json(plan.limits)}, updated_at = now()
      where country = ${country} and id = ${id}`;
  }

  async updateAddon(tx, country, id, addon) {
    await tx`update dinein.catalog_addons set monthly_price = ${addon.monthlyPrice}, plan_share = ${addon.planShare},
      available_to = ${addon.availableTo}::text[], updated_at = now()
      where country = ${country} and id = ${id}`;
  }

  /** Setting a price confirms that country's list (the UK starts with placeholders). */
  async confirmPrices(tx, country) {
    await tx`update dinein.catalog_countries set prices_confirmed = true where country = ${country}`;
  }
}

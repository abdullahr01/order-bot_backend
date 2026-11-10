// Restaurants for the platform console. Every method takes the restaurant id the
// route guard has already checked against the caller's scope.
const SUBSCRIPTION_COLUMNS = (sql) => sql`
  s.plan_id, s.status, s.trial_ends_at, s.current_period_end, s.past_due_since,
  s.scheduled_plan_id, s.billing_starts_at, s.setup_fee`;

const ENTITLEMENT_JSON = (sql) => sql`
  coalesce((select json_agg(a) from dinein.tenant_addons a where a.tenant_id = t.id), '[]') as tenant_addons,
  coalesce((select json_agg(o) from dinein.tenant_overrides o where o.tenant_id = t.id), '[]') as tenant_overrides`;

export class TenantRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  /** A country's price list, as catalogue rows. */
  async catalogRows(country, sql = this.#sql) {
    const [row] = await sql`
      select
        (select json_agg(p) from dinein.catalog_plans p where p.country = ${country}) as catalog_plans,
        (select json_agg(c) from dinein.catalog_addons c where c.country = ${country}) as catalog_addons`;
    return row;
  }

  /** Every restaurant on screen: one country, and only a partner's own when the caller is one. */
  async listInView({ country, partnerId }) {
    return this.#sql`
      select t.id, t.business_name, t.country, t.partner_id, t.owner_name, t.city, t.currency, t.timezone,
        t.created_at, t.last_order_at, ${SUBSCRIPTION_COLUMNS(this.#sql)}, ${ENTITLEMENT_JSON(this.#sql)},
        (select count(*)::int from dinein.dining_tables d where d.tenant_id = t.id and d.active) as active_tables,
        (select count(*)::int from dinein.orders o
          where o.tenant_id = t.id and o.business_day = (now() at time zone t.timezone)::date) as orders_today
      from dinein.tenants t
      join dinein.subscriptions s on s.tenant_id = t.id
      where t.country = ${country} and (${partnerId}::uuid is null or t.partner_id = ${partnerId}::uuid)`;
  }

  /** Everything the console's restaurant page shows, in one round trip. */
  async findDetail(tenantId, sql = this.#sql) {
    const [row] = await sql`
      select t.*, ${SUBSCRIPTION_COLUMNS(sql)}, ${ENTITLEMENT_JSON(sql)},
        (select json_agg(p) from dinein.catalog_plans p where p.country = t.country) as catalog_plans,
        (select json_agg(c) from dinein.catalog_addons c where c.country = t.country) as catalog_addons,
        coalesce((select json_agg(b order by b.is_main desc, b.created_at)
          from dinein.branches b where b.tenant_id = t.id and b.retired_at is null), '[]') as branches,
        coalesce((select json_agg(to_jsonb(m) || jsonb_build_object('has_pin', p.user_id is not null)
            order by m.role = 'tenant_owner' desc, m.name)
          from dinein.team_members m left join dinein.counter_pins p on p.tenant_id = m.tenant_id and p.user_id = m.id
          where m.tenant_id = t.id), '[]') as team,
        coalesce((select json_agg(p order by p.month desc nulls last, p.recorded_at desc)
          from dinein.payments p where p.tenant_id = t.id), '[]') as payments,
        coalesce((select json_agg(e order by e.created_at desc) from (
          select * from dinein.entitlement_events where tenant_id = t.id order by created_at desc limit 25) e), '[]') as events,
        (select count(*)::int from dinein.menu_items where tenant_id = t.id) as usage_menu_items,
        (select count(*)::int from dinein.dining_tables where tenant_id = t.id and active) as usage_tables,
        (select count(*)::int from dinein.team_members where tenant_id = t.id) as usage_staff,
        (select count(*)::int from dinein.stations where tenant_id = t.id) as usage_stations,
        (select count(*)::int from dinein.branches where tenant_id = t.id and retired_at is null) as usage_branches
      from dinein.tenants t
      join dinein.subscriptions s on s.tenant_id = t.id
      where t.id = ${tenantId}`;
    return row ?? null;
  }

  /** Locks the restaurant's subscription for the rest of the transaction, so writes queue up. */
  async lockForWrite(tx, tenantId) {
    const [row] = await tx`
      select t.id, t.business_name, t.city, t.owner_name, t.owner_phone, t.owner_email, t.country, t.currency,
        t.timezone, t.onboarding, ${SUBSCRIPTION_COLUMNS(tx)},
        (select m.id from dinein.team_members m where m.tenant_id = t.id and m.role = 'tenant_owner') as owner_id
      from dinein.tenants t
      join dinein.subscriptions s on s.tenant_id = t.id
      where t.id = ${tenantId}
      for update of s, t`;
    return row ?? null;
  }

  async nameTaken(name, exceptId = null, sql = this.#sql) {
    const [row] = await sql`
      select exists (select 1 from dinein.tenants
        where lower(btrim(business_name)) = lower(btrim(${name})) and (${exceptId}::uuid is null or id <> ${exceptId}::uuid)) as taken`;
    return row.taken;
  }

  /** Emails are unique across the platform: Supabase accounts, team members and owners. */
  async emailTaken(email, exceptUserId = null, sql = this.#sql) {
    const [row] = await sql`
      select exists (select 1 from auth.users where lower(email) = lower(${email}) and (${exceptUserId}::uuid is null or id <> ${exceptUserId}::uuid))
        or exists (select 1 from dinein.team_members where lower(btrim(email)) = lower(btrim(${email})) and (${exceptUserId}::uuid is null or id <> ${exceptUserId}::uuid))
        or exists (select 1 from dinein.tenants t where lower(btrim(t.owner_email)) = lower(btrim(${email}))
          and (${exceptUserId}::uuid is null or not exists (
            select 1 from dinein.team_members m where m.tenant_id = t.id and m.id = ${exceptUserId}::uuid and m.role = 'tenant_owner')))
        as taken`;
    return row.taken;
  }

  async partnerCovers(partnerId, country) {
    const [row] = await this.#sql`select exists (select 1 from dinein.partners where id = ${partnerId}::uuid and ${country}::text = any(countries)) as covers`;
    return row.covers;
  }

  /** The first free slug: base, base-2, base-3... */
  async freeSlug(tx, base) {
    const rows = await tx`select slug from dinein.tenants where slug = ${base} or slug like ${`${base}-%`}`;
    const taken = new Set(rows.map((row) => row.slug));
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
    return slug;
  }

  /** The restaurant and everything it needs on day one, inside the caller's transaction. */
  async insertRestaurant(tx, { tenant, subscription, addons, branch, hours, owner }) {
    await tx`
      insert into dinein.tenants (id, business_name, slug, city, owner_name, owner_phone, owner_email, country, currency,
        timezone, tax_profile, partner_id, onboarding, created_at)
      values (${tenant.id}, ${tenant.businessName}, ${tenant.slug}, ${tenant.city}, ${tenant.ownerName}, ${tenant.ownerPhone},
        ${tenant.ownerEmail}, ${tenant.country}, ${tenant.currency}, ${tenant.timezone}, ${tenant.taxProfile}, ${tenant.partnerId},
        ${tx.json({ completed_steps: [], completed_at: null })}, ${tenant.createdAt})`;
    await tx`
      insert into dinein.subscriptions (tenant_id, plan_id, status, trial_ends_at, current_period_end, billing_starts_at, setup_fee)
      values (${tenant.id}, ${subscription.planId}, ${subscription.status}, ${subscription.trialEndsAt},
        ${subscription.currentPeriodEnd}, ${subscription.billingStartsAt}, ${subscription.setupFee})`;
    for (const addon of addons) {
      await tx`insert into dinein.tenant_addons (tenant_id, addon_id, quantity, activated_at)
        values (${tenant.id}, ${addon.addonId}, ${addon.quantity}, ${tenant.createdAt})`;
    }
    await tx`insert into dinein.branches (tenant_id, name, area, is_main, created_at)
      values (${tenant.id}, ${branch.name}, ${branch.area}, true, ${tenant.createdAt})`;
    await tx`insert into dinein.service_settings (tenant_id, hours) values (${tenant.id}, ${tx.json(hours)})`;
    await tx`insert into dinein.menu_versions (tenant_id, version) values (${tenant.id}, 1)`;
    await tx`insert into dinein.team_members (id, tenant_id, name, email, role, created_at)
      values (${owner.id}, ${tenant.id}, ${owner.name}, ${owner.email}, 'tenant_owner', ${tenant.createdAt})`;
  }

  async updateDetails(tx, tenantId, { businessName, city, ownerName, ownerPhone, ownerEmail }) {
    await tx`update dinein.tenants set business_name = ${businessName}, city = ${city}, owner_name = ${ownerName},
      owner_phone = ${ownerPhone}, owner_email = ${ownerEmail} where id = ${tenantId}`;
    await tx`update dinein.team_members set email = ${ownerEmail} where tenant_id = ${tenantId} and role = 'tenant_owner'`;
  }

  async setOnboarding(tx, tenantId, { completedSteps, completedAt }) {
    await tx`update dinein.tenants set onboarding = ${tx.json({ completed_steps: completedSteps, completed_at: completedAt })}
      where id = ${tenantId}`;
  }
}

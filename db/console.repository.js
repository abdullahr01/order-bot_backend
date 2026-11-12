// What the platform console reads besides restaurants: the history log, owners' upgrade
// requests, locked-feature clicks, payments for the revenue trend, and the monthly audit.
// Every query is limited to the country on screen, and to a partner's own restaurants.
const inScope = (sql, alias, { country, partnerId }) =>
  sql`${sql(alias)}.country = ${country} and (${partnerId}::uuid is null or ${sql(alias)}.partner_id = ${partnerId}::uuid)`;

export class ConsoleRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  /**
   * History log rows in view: the restaurants' own events, and (not for partners)
   * price-list and partner changes recorded for this country.
   */
  #eventScope(scope) {
    const sql = this.#sql;
    return sql`(
      (e.tenant_id is not null and exists (select 1 from dinein.tenants t where t.id = e.tenant_id and ${inScope(sql, 't', scope)}))
      or (${scope.partnerId}::uuid is null and e.tenant_id is null and coalesce(e.country, 'PK') = ${scope.country})
    )`;
  }

  async events(scope, { tenantId, actor, actions, from, to, search, limit, offset }) {
    const sql = this.#sql;
    const where = sql`${this.#eventScope(scope)}
      and (${tenantId ?? null}::uuid is null or e.tenant_id = ${tenantId ?? null}::uuid)
      and (${actor ?? null}::text is null or e.actor = ${actor ?? null}::text)
      and (${actions ?? null}::text[] is null or e.action = any(${actions ?? null}::text[]))
      and (${from ?? null}::timestamptz is null or e.created_at >= ${from ?? null}::timestamptz)
      and (${to ?? null}::timestamptz is null or e.created_at < ${to ?? null}::timestamptz)
      and (${search ?? null}::text is null or concat_ws(' ', e.tenant_name, e."before", e."after", e.reason, e.actor) ilike ${search ? `%${search}%` : null})`;
    const [rows, [{ total }], actors, tenants] = await Promise.all([
      sql`select e.* from dinein.entitlement_events e where ${where} order by e.created_at desc, e.id limit ${limit} offset ${offset}`,
      sql`select count(*)::int as total from dinein.entitlement_events e where ${where}`,
      sql`select distinct e.actor from dinein.entitlement_events e where ${this.#eventScope(scope)} order by e.actor`,
      sql`select t.id, t.business_name as name from dinein.tenants t where ${inScope(sql, 't', scope)} order by lower(t.business_name)`,
    ]);
    return { rows, total, actors: actors.map((row) => row.actor), tenants };
  }

  async recentEvents(scope, limit = 6) {
    return this.#sql`select e.* from dinein.entitlement_events e where ${this.#eventScope(scope)} order by e.created_at desc, e.id limit ${limit}`;
  }

  // ---------------------------------------------------------------- Upgrade requests

  async upgradeRequests(scope, { status, tenantId }) {
    const sql = this.#sql;
    return sql`
      select r.*, t.business_name as tenant_name, t.country, s.plan_id
      from dinein.upgrade_requests r
      join dinein.tenants t on t.id = r.tenant_id
      join dinein.subscriptions s on s.tenant_id = r.tenant_id
      where ${inScope(sql, 't', scope)} and (${status ?? null}::text is null or r.status = ${status ?? null}::text)
        and (${tenantId ?? null}::uuid is null or r.tenant_id = ${tenantId ?? null}::uuid)
      order by ${status === 'handled' ? sql`r.handled_at desc` : sql`r.last_at desc`}`;
  }

  async findRequest(tx, scope, id) {
    const [row] = await tx`
      select r.* from dinein.upgrade_requests r join dinein.tenants t on t.id = r.tenant_id
      where r.id = ${id} and ${inScope(tx, 't', scope)} for update of r`;
    return row ?? null;
  }

  async handleRequest(tx, id, { by, note, now }) {
    await tx`update dinein.upgrade_requests set status = 'handled', handled_by = ${by}, handled_at = ${now}, note = ${note} where id = ${id}`;
  }

  /** One open request per subject per restaurant: asking again counts up. */
  async askFor(tx, tenantId, { featureKey, limitKey, by, now }) {
    if (featureKey) {
      await tx`insert into dinein.upgrade_requests (tenant_id, feature_key, requested_by, first_at, last_at)
        values (${tenantId}, ${featureKey}, ${by}, ${now}, ${now})
        on conflict (tenant_id, feature_key) where status = 'open' and feature_key is not null
        do update set count = dinein.upgrade_requests.count + 1, last_at = excluded.last_at, requested_by = excluded.requested_by`;
      await tx`insert into dinein.locked_clicks (tenant_id, feature_key, clicks) values (${tenantId}, ${featureKey}, 1)
        on conflict (tenant_id, feature_key) do update set clicks = dinein.locked_clicks.clicks + 1`;
    } else {
      await tx`insert into dinein.upgrade_requests (tenant_id, limit_key, requested_by, first_at, last_at)
        values (${tenantId}, ${limitKey}, ${by}, ${now}, ${now})
        on conflict (tenant_id, limit_key) where status = 'open' and limit_key is not null
        do update set count = dinein.upgrade_requests.count + 1, last_at = excluded.last_at, requested_by = excluded.requested_by`;
    }
  }

  // ---------------------------------------------------------------- Dashboard and audit inputs

  /** Monthly fees received per month, for the revenue trend (no made-up history). */
  async monthlyPayments(scope, fromMonth) {
    const sql = this.#sql;
    return sql`
      select to_char(p.month, 'YYYY-MM') as month, sum(p.amount)::int as amount
      from dinein.payments p join dinein.tenants t on t.id = p.tenant_id
      where ${inScope(sql, 't', scope)} and p.kind = 'monthly' and p.month >= ${`${fromMonth}-01`}::date
      group by 1`;
  }

  async paymentsForMonth(scope, month) {
    const sql = this.#sql;
    return sql`select p.* from dinein.payments p join dinein.tenants t on t.id = p.tenant_id
      where ${inScope(sql, 't', scope)} and p.kind = 'monthly' and p.month = ${`${month}-01`}::date`;
  }

  async lockedClicks(scope) {
    const sql = this.#sql;
    return sql`select l.*, t.business_name as tenant_name, s.plan_id
      from dinein.locked_clicks l join dinein.tenants t on t.id = l.tenant_id join dinein.subscriptions s on s.tenant_id = l.tenant_id
      where ${inScope(sql, 't', scope)} and s.status <> 'cancelled' and l.clicks > 0 order by l.clicks desc`;
  }

  // ---------------------------------------------------------------- Monthly audit runs (per country)

  async auditRun(country, month, sql = this.#sql) {
    const [row] = await sql`select * from dinein.audit_runs where country = ${country} and month = ${`${month}-01`}::date`;
    return row ?? null;
  }

  async previousRun(country, month) {
    const [row] = await this.#sql`select * from dinein.audit_runs where country = ${country} and month < ${`${month}-01`}::date
      order by month desc limit 1`;
    return row ?? null;
  }

  /** The month's row, created if needed and locked for the change. */
  async lockRun(tx, country, month) {
    await tx`insert into dinein.audit_runs (country, month) values (${country}, ${`${month}-01`}::date) on conflict do nothing`;
    const [row] = await tx`select * from dinein.audit_runs where country = ${country} and month = ${`${month}-01`}::date for update`;
    return row;
  }

  async saveRun(tx, country, month, { reviewed, notes, completedAt, completedBy }) {
    await tx`update dinein.audit_runs set reviewed = ${reviewed}::text[], notes = ${notes}, completed_at = ${completedAt}, completed_by = ${completedBy}
      where country = ${country} and month = ${`${month}-01`}::date`;
  }
}

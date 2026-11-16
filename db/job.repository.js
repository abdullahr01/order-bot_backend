// The daily jobs' reads and writes. Every candidate query filters out work already
// written in the notebook (`job_runs`); each write re-checks inside its transaction.
// `fromHour` keeps automatic runs to 9 am in each restaurant's own time zone.
export class JobRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  /** Writes the work down. True when this call did; false when it was already done. */
  async claim(tx, job, key, tenantId = null) {
    const rows = await tx`insert into dinein.job_runs (job, run_key, tenant_id) values (${job}, ${key}, ${tenantId})
      on conflict do nothing returning job`;
    return rows.length === 1;
  }

  /** Gives the work back, after a failed email, so the next run tries again. */
  async release(job, key, sql = this.#sql) {
    await sql`delete from dinein.job_runs where job = ${job} and run_key = ${key}`;
  }

  // ---------------------------------------------------------------- 1st of the month

  /**
   * Active restaurants with no monthly payment for their last local month, not yet
   * checked this month. From 9 am on the 1st, or any time later in the month.
   */
  async billingMonthCandidates(now, fromHour, sql = this.#sql) {
    return sql`
      select t.id, t.timezone, l.this_month, l.last_month
      from dinein.tenants t
      join dinein.subscriptions s on s.tenant_id = t.id
      cross join lateral (
        select ${now}::timestamptz at time zone t.timezone as at
      ) z
      cross join lateral (
        select to_char(z.at, 'YYYY-MM') as this_month,
          to_char(date_trunc('month', z.at) - interval '1 month', 'YYYY-MM') as last_month,
          (date_trunc('month', z.at) - interval '1 month')::date as last_month_date
      ) l
      where s.status = 'active' and s.billing_starts_at is not null
        and (extract(day from z.at) > 1 or extract(hour from z.at) >= ${fromHour})
        and not exists (select 1 from dinein.payments p
          where p.tenant_id = t.id and p.kind = 'monthly' and p.month = l.last_month_date)
        and not exists (select 1 from dinein.job_runs r
          where r.job = 'billing_month' and r.run_key = t.id::text || ':' || l.this_month)
      order by t.id`;
  }

  /** Past due from the start of the restaurant's local month, as core does on the 1st. */
  async markPastDue(tx, tenantId, since) {
    await tx`update dinein.subscriptions set status = 'past_due', past_due_since = ${since}
      where tenant_id = ${tenantId} and status = 'active'`;
  }

  async monthlyPaid(tx, tenantId, month) {
    const [row] = await tx`select exists (select 1 from dinein.payments
      where tenant_id = ${tenantId} and kind = 'monthly' and month = ${`${month}-01`}::date) as paid`;
    return row.paid;
  }

  // ---------------------------------------------------------------- Unpaid ladder

  /** Restaurants on the ladder, with what the emails need. */
  async pastDue(now, fromHour, sql = this.#sql) {
    return sql`
      select t.id, t.business_name, t.owner_name, t.owner_email, t.timezone, t.currency, s.past_due_since
      from dinein.tenants t
      join dinein.subscriptions s on s.tenant_id = t.id
      where s.status = 'past_due' and s.past_due_since is not null
        and extract(hour from (${now}::timestamptz at time zone t.timezone)) >= ${fromHour}
      order by t.id`;
  }

  async isDone(job, key, sql = this.#sql) {
    const [row] = await sql`select exists (select 1 from dinein.job_runs where job = ${job} and run_key = ${key}) as done`;
    return row.done;
  }

  // ---------------------------------------------------------------- Billing period

  /** Paying restaurants whose 30-day period has ended. */
  async periodsEnded(now, sql = this.#sql) {
    return sql`
      select s.tenant_id as id, s.current_period_end
      from dinein.subscriptions s
      where s.status in ('active', 'past_due') and s.current_period_end is not null and s.current_period_end <= ${now}
      order by s.tenant_id`;
  }

  /** Moves the period on only if nobody else already did. */
  async movePeriod(tx, tenantId, from, to) {
    const rows = await tx`update dinein.subscriptions set current_period_end = ${to}
      where tenant_id = ${tenantId} and current_period_end = ${from} returning tenant_id`;
    return rows.length === 1;
  }

  // ---------------------------------------------------------------- Clean-ups

  async cleanUp(now, { dryRun }, sql = this.#sql) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    if (dryRun) {
      const [row] = await sql`select
        (select count(*)::int from dinein.pairing_codes where expires_at <= ${now}) as pairing_codes,
        (select count(*)::int from dinein.diner_order_refs where created_at < ${dayAgo}) as diner_order_refs,
        (select count(*)::int from dinein.idempotency_keys where created_at < ${dayAgo}) as idempotency_keys`;
      return row;
    }
    const codes = await sql`delete from dinein.pairing_codes where expires_at <= ${now} returning code`;
    const refs = await sql`delete from dinein.diner_order_refs where created_at < ${dayAgo} returning client_ref`;
    const keys = await sql`delete from dinein.idempotency_keys where created_at < ${dayAgo} returning key`;
    return { pairing_codes: codes.length, diner_order_refs: refs.length, idempotency_keys: keys.length };
  }

  /** Every dish photo URL a restaurant uses now. */
  async photoUrls(tenantId, sql = this.#sql) {
    const rows = await sql`select photo_url from dinein.menu_items where tenant_id = ${tenantId} and photo_url is not null`;
    return new Set(rows.map((row) => row.photo_url));
  }

  async tenantExists(tenantId, sql = this.#sql) {
    const [row] = await sql`select exists (select 1 from dinein.tenants where id = ${tenantId}) as found`;
    return row.found;
  }
}

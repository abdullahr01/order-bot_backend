// The owner's figures: worked out in the database, in the restaurant's own day and time
// zone, never by loading months of orders into the server. Every query filters by the
// tenant from the verified credentials; `branchId` null means every branch.
const scoped = (sql, tenantId, branchId, alias = 'o') =>
  sql`${sql(alias)}.tenant_id = ${tenantId} and (${branchId}::uuid is null or ${sql(alias)}.branch_id = ${branchId}::uuid)`;
const NOT_CANCELLED = (sql) => sql`o.status <> 'cancelled'`;

export class OwnerRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  async branches(tenantId) {
    return this.#sql`select * from dinein.branches where tenant_id = ${tenantId} and retired_at is null order by is_main desc, created_at`;
  }

  async tenant(tenantId) {
    const [row] = await this.#sql`select id, business_name, created_at, onboarding, timezone, currency from dinein.tenants where id = ${tenantId}`;
    return row;
  }

  // ---------------------------------------------------------------- Dashboard

  async today(tenantId, branchId, { today, yesterday, timeZone }) {
    const sql = this.#sql;
    const [figures, active, hours, top, dineIn, usage] = await Promise.all([
      sql`select
          count(*) filter (where o.business_day = ${today}::date and o.status <> 'cancelled')::int as orders,
          coalesce(sum(o.total) filter (where o.business_day = ${today}::date and o.status <> 'cancelled'), 0)::int as revenue,
          count(*) filter (where o.business_day = ${yesterday}::date and o.status <> 'cancelled')::int as orders_yesterday,
          coalesce(sum(o.total) filter (where o.business_day = ${yesterday}::date and o.status <> 'cancelled'), 0)::int as revenue_yesterday,
          count(*) filter (where o.status = 'new')::int as waiting,
          count(*) filter (where o.status = 'accepted')::int as in_progress,
          coalesce(sum(jsonb_array_length(o.items)) filter (where o.business_day = ${today}::date and o.status <> 'cancelled'), 0)::int as lines
        from dinein.orders o
        where ${scoped(sql, tenantId, branchId)} and (o.business_day >= ${yesterday}::date or o.status in ('new', 'accepted'))`,
      sql`select o.* from dinein.orders o where ${scoped(sql, tenantId, branchId)} and o.status in ('new', 'accepted')
        order by o.created_at desc limit 8`,
      sql`select extract(hour from o.created_at at time zone ${timeZone})::int as hour, count(*)::int as orders
        from dinein.orders o where ${scoped(sql, tenantId, branchId)} and o.business_day = ${today}::date group by 1`,
      this.#topItems(tenantId, branchId, today, today, 5),
      sql`select
          (select count(*)::int from dinein.dining_tables t where ${scoped(sql, tenantId, branchId, 't')} and t.active) as tables,
          (select count(*)::int from dinein.table_sessions s where ${scoped(sql, tenantId, branchId, 's')} and s.status <> 'closed') as seated,
          (select count(*)::int from dinein.table_sessions s where ${scoped(sql, tenantId, branchId, 's')} and s.status = 'bill_requested') as bill_requested`,
      sql`select
          (select count(*)::int from dinein.dining_tables where tenant_id = ${tenantId} and active) as tables,
          (select count(*)::int from dinein.team_members where tenant_id = ${tenantId}) as staff_accounts`,
    ]);
    return { figures: figures[0], active, hours, top, dineIn: dineIn[0], usage: usage[0] };
  }

  /** Best sellers between two restaurant days, cancelled orders left out. */
  async #topItems(tenantId, branchId, from, to, limit) {
    const sql = this.#sql;
    return sql`select item ->> 'name' as name, sum((item ->> 'quantity')::int)::int as quantity,
        sum((item ->> 'quantity')::int * (item ->> 'unitPrice')::int)::int as revenue
      from dinein.orders o, jsonb_array_elements(o.items) item
      where ${scoped(sql, tenantId, branchId)} and o.business_day between ${from}::date and ${to}::date and ${NOT_CANCELLED(sql)}
      group by 1 order by 2 desc, 3 desc limit ${limit}`;
  }

  // ---------------------------------------------------------------- Void log

  /** Cancelled orders and tables closed without payment since `since`. */
  async voids(tenantId, branchId, since, tableClosedPrefix) {
    const sql = this.#sql;
    const [orders, tables] = await Promise.all([
      sql`select o.* from dinein.orders o where ${scoped(sql, tenantId, branchId)} and o.status = 'cancelled'
        and o.finished_at >= ${since} and o.cancel_reason not like ${`${tableClosedPrefix}%`}`,
      sql`select s.id, s.branch_id, s.closed_at, s.close_reason, s.closed_by, d.number as table_number,
          coalesce((select sum(o.total) from dinein.orders o where o.session_id = s.id
            and (o.status <> 'cancelled' or o.cancel_reason like ${`${tableClosedPrefix}%`})), 0)::int as amount,
          coalesce((select json_agg(o.items order by o.created_at) from dinein.orders o where o.session_id = s.id
            and (o.status <> 'cancelled' or o.cancel_reason like ${`${tableClosedPrefix}%`})), '[]') as items
        from dinein.table_sessions s
        join dinein.dining_tables d on d.id = s.table_id
        where ${scoped(sql, tenantId, branchId, 's')} and s.closed_as = 'force_closed' and s.closed_at >= ${since}`,
    ]);
    return { orders, tables };
  }

  // ---------------------------------------------------------------- Cash close

  /** Tables paid at this branch on this restaurant day, by how they paid. */
  async payments(tenantId, branchId, day, timeZone, sql = this.#sql) {
    return sql`select s.paid_by, count(*)::int as count, coalesce(sum(s.amount_paid), 0)::int as amount
      from dinein.table_sessions s
      where ${scoped(sql, tenantId, branchId, 's')} and s.closed_as = 'paid' and (s.closed_at at time zone ${timeZone})::date = ${day}::date
      group by s.paid_by`;
  }

  async openTables(tenantId, branchId) {
    const [row] = await this.#sql`select count(*)::int as count from dinein.table_sessions
      where tenant_id = ${tenantId} and branch_id = ${branchId} and status <> 'closed'`;
    return row.count;
  }

  async closes(tenantId, branchId, sql = this.#sql) {
    return sql`select * from dinein.cash_closes where tenant_id = ${tenantId} and branch_id = ${branchId} order by day desc limit 15`;
  }

  /** One count per branch per day: a recount replaces the earlier one. */
  async saveClose(tx, tenantId, { branchId, day, expectedCash, countedCash, note, closedBy, now }) {
    await tx`insert into dinein.cash_closes (tenant_id, branch_id, day, expected_cash, counted_cash, note, closed_by, closed_at)
      values (${tenantId}, ${branchId}, ${day}::date, ${expectedCash}, ${countedCash}, ${note}, ${closedBy}, ${now})
      on conflict (branch_id, day) do update set expected_cash = excluded.expected_cash, counted_cash = excluded.counted_cash,
        note = excluded.note, closed_by = excluded.closed_by, closed_at = excluded.closed_at`;
  }

  // ---------------------------------------------------------------- Daily summary

  async day(tenantId, branchId, { day, weekBefore, upToMinute, timeZone }) {
    const sql = this.#sql;
    const lastWeekCut = upToMinute === null ? sql`` : sql`and extract(hour from o.created_at at time zone ${timeZone}) * 60
      + extract(minute from o.created_at at time zone ${timeZone}) <= ${upToMinute}`;
    const [figures, lastWeek, hours, top, forced, closes, payments] = await Promise.all([
      sql`select count(*) filter (where o.status <> 'cancelled')::int as orders,
          coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0)::int as revenue,
          count(*) filter (where o.status = 'cancelled' and o.cancel_reason not like 'Table closed: %')::int as cancelled,
          coalesce(sum(o.total) filter (where o.status = 'cancelled'), 0)::int as cancelled_amount
        from dinein.orders o where ${scoped(sql, tenantId, branchId)} and o.business_day = ${day}::date`,
      sql`select count(*)::int as orders, coalesce(sum(o.total), 0)::int as revenue
        from dinein.orders o where ${scoped(sql, tenantId, branchId)} and o.business_day = ${weekBefore}::date and ${NOT_CANCELLED(sql)} ${lastWeekCut}`,
      sql`select extract(hour from o.created_at at time zone ${timeZone})::int as hour, count(*)::int as orders
        from dinein.orders o where ${scoped(sql, tenantId, branchId)} and o.business_day = ${day}::date and ${NOT_CANCELLED(sql)} group by 1`,
      this.#topItems(tenantId, branchId, day, day, 5),
      sql`select count(*)::int as count from dinein.table_sessions s
        where ${scoped(sql, tenantId, branchId, 's')} and s.closed_as = 'force_closed' and (s.closed_at at time zone ${timeZone})::date = ${day}::date`,
      sql`select c.*, b.name as branch_name from dinein.cash_closes c join dinein.branches b on b.id = c.branch_id
        where ${scoped(sql, tenantId, branchId, 'c')} and c.day = ${day}::date order by b.is_main desc, b.name`,
      this.payments(tenantId, branchId, day, timeZone),
    ]);
    return { figures: figures[0], lastWeek: lastWeek[0], hours, top, forced: forced[0].count, closes, payments };
  }

  // ---------------------------------------------------------------- Branches today

  async branchesToday(tenantId, { today, timeZone, onlineSince, now }) {
    return this.#sql`
      select to_jsonb(b) as branch,
        (select count(*)::int from dinein.orders o where o.tenant_id = b.tenant_id and o.branch_id = b.id and o.business_day = ${today}::date and o.status <> 'cancelled') as orders,
        (select coalesce(sum(o.total), 0)::int from dinein.orders o where o.tenant_id = b.tenant_id and o.branch_id = b.id and o.business_day = ${today}::date and o.status <> 'cancelled') as sales,
        (select count(*)::int from dinein.orders o where o.tenant_id = b.tenant_id and o.branch_id = b.id and o.status = 'new') as waiting,
        (select count(*)::int from dinein.orders o where o.tenant_id = b.tenant_id and o.branch_id = b.id and o.business_day = ${today}::date and o.status = 'cancelled') as voids,
        (select count(*)::int from dinein.table_sessions s where s.tenant_id = b.tenant_id and s.branch_id = b.id and s.status <> 'closed') as seated,
        (select count(*)::int from dinein.dining_tables t where t.tenant_id = b.tenant_id and t.branch_id = b.id and t.active) as tables,
        (select coalesce(sum(s.amount_paid), 0)::int from dinein.table_sessions s where s.tenant_id = b.tenant_id and s.branch_id = b.id
          and s.closed_as = 'paid' and s.paid_by = 'cash' and (s.closed_at at time zone ${timeZone})::date = ${today}::date) as expected_cash,
        (select c.difference from dinein.cash_closes c where c.tenant_id = b.tenant_id and c.branch_id = b.id and c.day = ${today}::date) as cash_difference,
        (select count(*)::int from dinein.team_members m where m.tenant_id = b.tenant_id and m.branch_id = b.id) as staff,
        (select count(*)::int from dinein.counter_devices d where d.tenant_id = b.tenant_id and d.branch_id = b.id) as counters,
        (select count(*)::int from dinein.counter_devices d where d.tenant_id = b.tenant_id and d.branch_id = b.id and d.last_seen_at >= ${onlineSince}) as online,
        (select p.paused_until from dinein.branch_pauses p where p.tenant_id = b.tenant_id and p.branch_id = b.id and p.paused_until > ${now}) as paused_until
      from dinein.branches b
      where b.tenant_id = ${tenantId} and b.retired_at is null
      order by b.is_main desc, b.created_at`;
  }

  // ---------------------------------------------------------------- Reports

  /** One month's figures between two restaurant days. */
  async report(tenantId, branchId, { from, to, timeZone }) {
    const sql = this.#sql;
    const where = sql`${scoped(sql, tenantId, branchId)} and o.business_day between ${from}::date and ${to}::date`;
    const [daily, totals, weekdays, hours, top, sources, branches] = await Promise.all([
      sql`select to_char(o.business_day, 'YYYY-MM-DD') as date, count(*)::int as orders, coalesce(sum(o.total), 0)::int as revenue
        from dinein.orders o where ${where} and ${NOT_CANCELLED(sql)} group by 1`,
      sql`select count(*) filter (where o.status <> 'cancelled')::int as orders,
          coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0)::int as revenue,
          count(*) filter (where o.status = 'cancelled')::int as cancelled
        from dinein.orders o where ${where}`,
      sql`select extract(isodow from o.business_day)::int - 1 as day, count(*)::int as orders
        from dinein.orders o where ${where} and ${NOT_CANCELLED(sql)} group by 1`,
      sql`select extract(hour from o.created_at at time zone ${timeZone})::int as hour, count(*)::int as orders
        from dinein.orders o where ${where} and ${NOT_CANCELLED(sql)} group by 1`,
      this.#topItems(tenantId, branchId, from, to, 10),
      sql`select o.source, count(*)::int as orders, coalesce(sum(o.total), 0)::int as revenue
        from dinein.orders o where ${where} and ${NOT_CANCELLED(sql)} group by 1`,
      sql`select o.branch_id, count(*)::int as orders, coalesce(sum(o.total), 0)::int as revenue
        from dinein.orders o where ${where} and ${NOT_CANCELLED(sql)} group by 1`,
    ]);
    return { daily, totals: totals[0], weekdays, hours, top, sources, branches };
  }

  /** Orders and revenue per month between two restaurant days, for the six-month trend. */
  async monthly(tenantId, branchId, { from, to }) {
    const sql = this.#sql;
    return sql`select to_char(o.business_day, 'YYYY-MM') as month, count(*)::int as orders, coalesce(sum(o.total), 0)::int as revenue
      from dinein.orders o where ${scoped(sql, tenantId, branchId)} and o.business_day between ${from}::date and ${to}::date and ${NOT_CANCELLED(sql)}
      group by 1`;
  }

  async totals(tenantId, branchId, { from, to }) {
    const sql = this.#sql;
    const [row] = await sql`select count(*) filter (where o.status <> 'cancelled')::int as orders,
        coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0)::int as revenue,
        count(*) filter (where o.status = 'cancelled')::int as cancelled
      from dinein.orders o where ${scoped(sql, tenantId, branchId)} and o.business_day between ${from}::date and ${to}::date`;
    return row;
  }

  // ---------------------------------------------------------------- Billing

  async monthlyPayments(tenantId) {
    return this.#sql`select to_char(month, 'YYYY-MM') as month, amount, method, recorded_at from dinein.payments
      where tenant_id = ${tenantId} and kind = 'monthly' order by month desc limit 12`;
  }
}

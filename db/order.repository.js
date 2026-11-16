// Orders, table sessions (one party at one table) and diner requests. Every query
// filters by the tenant from the verified credentials or the table's token; staff and
// counters are further limited to their branch by the services.
const ACTIVE = ['new', 'accepted'];

export class OrderRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  // ---------------------------------------------------------------- Tables and sessions

  /** The table behind a QR token, with what the diner page needs about its restaurant. */
  async tableByToken(token, sql = this.#sql) {
    const [row] = await sql`
      select t.id, t.tenant_id, t.branch_id, t.number, t.label,
        te.business_name, te.city, te.timezone, b.name as branch_name, b.is_main,
        s.hours, s.paused_until as restaurant_paused_until, p.paused_until as branch_paused_until,
        (select to_jsonb(x) from dinein.table_sessions x where x.table_id = t.id and x.status <> 'closed') as session
      from dinein.dining_tables t
      join dinein.tenants te on te.id = t.tenant_id
      join dinein.branches b on b.tenant_id = t.tenant_id and b.id = t.branch_id and b.retired_at is null
      left join dinein.service_settings s on s.tenant_id = t.tenant_id
      left join dinein.branch_pauses p on p.tenant_id = t.tenant_id and p.branch_id = t.branch_id
      where t.token = ${token} and t.active`;
    return row ?? null;
  }

  /** Locks a table for the transaction: orders and closes at one table queue up, never two parties at once. */
  async lockTable(tx, tenantId, tableId) {
    const [row] = await tx`select * from dinein.dining_tables where tenant_id = ${tenantId} and id = ${tableId} for update`;
    return row ?? null;
  }

  async openSession(tx, tenantId, tableId) {
    const [row] = await tx`select * from dinein.table_sessions
      where tenant_id = ${tenantId} and table_id = ${tableId} and status <> 'closed' for update`;
    return row ?? null;
  }

  /** The table's party right now, for reading (no lock). */
  async currentSession(sql = this.#sql, tenantId, tableId) {
    const [row] = await sql`select * from dinein.table_sessions
      where tenant_id = ${tenantId} and table_id = ${tableId} and status <> 'closed'`;
    return row ?? null;
  }

  async createSession(tx,{ tenantId, branchId, tableId, waiterId = null, now }) {
    const [row] = await tx`insert into dinein.table_sessions (tenant_id, branch_id, table_id, waiter_id, opened_at)
      values (${tenantId}, ${branchId}, ${tableId}, ${waiterId}, ${now}) returning *`;
    return row;
  }

  async setSession(tx, tenantId, sessionId, { status, waiterId, billRequestedAt }) {
    await tx`update dinein.table_sessions set
        status = coalesce(${status ?? null}::text, status),
        waiter_id = coalesce(waiter_id, ${waiterId ?? null}::uuid),
        bill_requested_at = case when ${billRequestedAt ?? null}::timestamptz is null then bill_requested_at else ${billRequestedAt ?? null}::timestamptz end
      where tenant_id = ${tenantId} and id = ${sessionId}`;
  }

  async waiterAt(sql = this.#sql, tenantId, branchId, waiterId) {
    const [row] = await sql`select * from dinein.waiters
      where tenant_id = ${tenantId} and branch_id = ${branchId} and id = ${waiterId} and retired_at is null`;
    return row ?? null;
  }

  async waitersAt(sql = this.#sql, tenantId, branchIds) {
    return sql`select * from dinein.waiters where tenant_id = ${tenantId} and branch_id = any(${branchIds}::uuid[])
      and retired_at is null order by lower(name)`;
  }

  // ---------------------------------------------------------------- Orders

  async insertOrder(tx, order) {
    const [row] = await tx`
      insert into dinein.orders (number, business_day, tenant_id, branch_id, table_number, table_id, session_id, waiter_id,
        items, total, notes, status, source, entered_by, entered_by_name, history, created_at)
      values (${order.number}, ${order.businessDay}::date, ${order.tenantId}, ${order.branchId}, ${order.tableNumber}, ${order.tableId},
        ${order.sessionId}, ${order.waiterId}, ${tx.json(order.items)}, ${order.total}, ${order.notes}, ${order.status},
        ${order.source}, ${order.enteredBy}, ${order.enteredByName}, ${tx.json(order.history)}, ${order.now})
      returning *`;
    await tx`update dinein.tenants set last_order_at = ${order.now} where id = ${order.tenantId}`;
    return row;
  }

  /** Diner orders this party sent in the last hour (the prank limit). */
  async recentDinerOrders(tx, sessionId, since) {
    const [row] = await tx`select count(*)::int as count from dinein.orders
      where session_id = ${sessionId} and entered_by = 'customer' and created_at > ${since}`;
    return row.count;
  }

  async findClientRef(tx, clientRef) {
    const [row] = await tx`select * from dinein.diner_order_refs where client_ref = ${clientRef}`;
    return row ?? null;
  }

  async saveClientRef(tx, { clientRef, tenantId, branchId, orderId }) {
    await tx`insert into dinein.diner_order_refs (client_ref, tenant_id, branch_id, order_id)
      values (${clientRef}, ${tenantId}, ${branchId}, ${orderId})`;
  }

  /** One order in scope (`branchId` null = every branch), optionally locked for a change. */
  async findOrder(sql = this.#sql, tenantId, branchId, id, { lock = false } = {}) {
    const [row] = lock
      ? await sql`select * from dinein.orders where tenant_id = ${tenantId} and id = ${id}
          and (${branchId}::uuid is null or branch_id = ${branchId}::uuid) for update`
      : await sql`select * from dinein.orders where tenant_id = ${tenantId} and id = ${id}
          and (${branchId}::uuid is null or branch_id = ${branchId}::uuid)`;
    return row ?? null;
  }

  /**
   * Moves an order on only if it is still in `from`: two counters tapping at once can
   * never both succeed, whatever the timing. Null means someone else got there first.
   */
  async setStatus(tx, tenantId, id, { from, status, waiterId, cancelReason, cancelledBy, now }) {
    const [row] = await tx`
      update dinein.orders set
        status = ${status},
        waiter_id = coalesce(${waiterId ?? null}::uuid, waiter_id),
        cancel_reason = coalesce(${cancelReason ?? null}::text, cancel_reason),
        cancelled_by = coalesce(${cancelledBy ?? null}::text, cancelled_by),
        finished_at = case when ${status}::text in ('served', 'cancelled') then ${now}::timestamptz else finished_at end,
        history = history || ${tx.json([{ status, at: now.toISOString() }])}
      where tenant_id = ${tenantId} and id = ${id} and status = ${from}
      returning *`;
    return row ?? null;
  }

  /**
   * The order board. Active: every unfinished order, oldest first (also from before
   * midnight). Completed: served and cancelled since `since`, latest finished first.
   */
  async list(tenantId, { branchId, view, since, number, table, limit = 500 }) {
    const sql = this.#sql;
    const scope = sql`o.tenant_id = ${tenantId} and (${branchId}::uuid is null or o.branch_id = ${branchId}::uuid)`;
    const search = number !== undefined ? sql`and o.number::text like ${`${number}%`}`
      : table !== undefined ? sql`and o.table_number = ${table}` : sql``;
    return view === 'active'
      ? sql`select o.* from dinein.orders o where ${scope} and o.status = any(${ACTIVE}::text[]) ${search}
          order by o.created_at, o.number limit ${limit}`
      : sql`select o.* from dinein.orders o where ${scope} and o.status in ('served', 'cancelled') and o.finished_at >= ${since} ${search}
          order by o.finished_at desc limit ${limit}`;
  }

  /** Today's orders per status in the restaurant's own day, ignoring any search. */
  async countsToday(tenantId, branchId) {
    return this.#sql`
      select o.status, count(*)::int as count from dinein.orders o
      join dinein.tenants t on t.id = o.tenant_id
      where o.tenant_id = ${tenantId} and (${branchId}::uuid is null or o.branch_id = ${branchId}::uuid)
        and o.business_day = (now() at time zone t.timezone)::date
      group by o.status`;
  }

  async sessionOrders(sql = this.#sql, tenantId, sessionId) {
    return sql`select * from dinein.orders where tenant_id = ${tenantId} and session_id = ${sessionId} order by created_at, number`;
  }

  // ---------------------------------------------------------------- Floor and tables

  /** Every active table at these branches with its party, in one round trip. */
  async floor(tenantId, branchIds) {
    return this.#sql`
      select to_jsonb(t) as table, to_jsonb(s) as session,
        coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0)::int as total,
        (count(o.id) filter (where o.status <> 'cancelled'))::int as order_count,
        (count(o.id) filter (where o.status = 'new'))::int as waiting,
        (select count(*)::int from dinein.service_requests r where r.session_id = s.id and r.handled_at is null) as open_requests
      from dinein.dining_tables t
      left join dinein.table_sessions s on s.table_id = t.id and s.status <> 'closed'
      left join dinein.orders o on o.tenant_id = t.tenant_id and o.session_id = s.id
      where t.tenant_id = ${tenantId} and t.branch_id = any(${branchIds}::uuid[]) and t.active
      group by t.id, s.id
      order by t.number, t.id`;
  }

  async findTable(sql = this.#sql, tenantId, tableId) {
    const [row] = await sql`select * from dinein.dining_tables where tenant_id = ${tenantId} and id = ${tableId}`;
    return row ?? null;
  }

  async lastClosedSession(sql = this.#sql, tenantId, sessionId) {
    const [row] = await sql`select * from dinein.table_sessions where tenant_id = ${tenantId} and id = ${sessionId}`;
    return row ?? null;
  }

  /** Paid: orders with a waiter count as served; the amount is the bill without cancelled orders. */
  async closePaid(tx, { tenantId, sessionId, paidBy, closedBy, now }) {
    await tx`update dinein.orders set status = 'served', finished_at = ${now},
        history = history || ${tx.json([{ status: 'served', at: now.toISOString() }])}
      where tenant_id = ${tenantId} and session_id = ${sessionId} and status = 'accepted'`;
    const [row] = await tx`
      update dinein.table_sessions set status = 'closed', closed_at = ${now}, closed_as = 'paid', paid_by = ${paidBy},
        closed_by = ${closedBy},
        amount_paid = (select coalesce(sum(total), 0) from dinein.orders where tenant_id = ${tenantId} and session_id = ${sessionId} and status <> 'cancelled')
      where tenant_id = ${tenantId} and id = ${sessionId} returning *`;
    await this.#seenTo(tx, tenantId, sessionId, closedBy, now);
    return row;
  }

  /** The party left without paying: anything open is cancelled, so it never reaches the next party. */
  async closeForced(tx, { tenantId, sessionId, reason, closedBy, cancelReason, now }) {
    await tx`update dinein.orders set status = 'cancelled', cancel_reason = ${cancelReason}, cancelled_by = ${closedBy},
        finished_at = ${now}, history = history || ${tx.json([{ status: 'cancelled', at: now.toISOString() }])}
      where tenant_id = ${tenantId} and session_id = ${sessionId} and status = any(${ACTIVE}::text[])`;
    const [row] = await tx`
      update dinein.table_sessions set status = 'closed', closed_at = ${now}, closed_as = 'force_closed',
        close_reason = ${reason}, closed_by = ${closedBy}
      where tenant_id = ${tenantId} and id = ${sessionId} returning *`;
    await this.#seenTo(tx, tenantId, sessionId, closedBy, now);
    return row;
  }

  /** The party has gone: whatever they asked for is moot. */
  async #seenTo(tx, tenantId, sessionId, by, now) {
    await tx`update dinein.service_requests set handled_at = ${now}, handled_by = ${by}
      where tenant_id = ${tenantId} and session_id = ${sessionId} and handled_at is null`;
  }

  // ---------------------------------------------------------------- Diner requests

  async recentRequests(tx, sessionId, since) {
    const [row] = await tx`select count(*)::int as count from dinein.service_requests where session_id = ${sessionId} and created_at > ${since}`;
    return row.count;
  }

  /** One open request per kind per session: asking again before it is seen to changes nothing. */
  async addRequest(tx, { tenantId, branchId, tableId, tableNumber, sessionId, kind, now }) {
    const rows = await tx`
      insert into dinein.service_requests (tenant_id, branch_id, table_id, table_number, session_id, kind, created_at)
      values (${tenantId}, ${branchId}, ${tableId}, ${tableNumber}, ${sessionId}, ${kind}, ${now})
      on conflict (session_id, kind) where handled_at is null do nothing
      returning id`;
    return rows.length === 1;
  }

  async requests(tenantId, branchIds, { recent = 8 } = {}) {
    const [row] = await this.#sql`
      select
        coalesce((select json_agg(r order by r.created_at) from dinein.service_requests r
          where r.tenant_id = ${tenantId} and r.branch_id = any(${branchIds}::uuid[]) and r.handled_at is null), '[]') as open,
        coalesce((select json_agg(r order by r.handled_at desc) from (
          select * from dinein.service_requests where tenant_id = ${tenantId} and branch_id = any(${branchIds}::uuid[])
            and handled_at is not null order by handled_at desc limit ${recent}) r), '[]') as recent`;
    return row;
  }

  /** Seen to. Doing it twice is harmless: the first time and name are kept. */
  async handleRequest(tx, tenantId, branchIds, id, { by, now }) {
    const rows = await tx`
      update dinein.service_requests set handled_at = coalesce(handled_at, ${now}), handled_by = coalesce(handled_by, ${by})
      where tenant_id = ${tenantId} and branch_id = any(${branchIds}::uuid[]) and id = ${id}
      returning id, branch_id, table_id`;
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------- Diner page

  /** The menu as diners see it (hidden dishes left out), and this party's bill and open requests. */
  async dinerPage(tenantId, sessionId, sql = this.#sql) {
    const [row] = await sql`
      select
        coalesce((select json_agg(c order by c.position) from dinein.menu_categories c where c.tenant_id = ${tenantId}), '[]') as categories,
        coalesce((select json_agg(i order by i.position, i.name) from dinein.menu_items i where i.tenant_id = ${tenantId} and i.available), '[]') as items,
        coalesce((select version from dinein.menu_versions where tenant_id = ${tenantId}), 1) as version,
        coalesce((select json_agg(o order by o.created_at, o.number) from dinein.orders o
          where o.tenant_id = ${tenantId} and o.session_id = ${sessionId}::uuid), '[]') as orders,
        coalesce((select json_agg(distinct r.kind) from dinein.service_requests r
          where r.tenant_id = ${tenantId} and r.session_id = ${sessionId}::uuid and r.handled_at is null), '[]') as requests,
        (select bill_requested_at from dinein.table_sessions where id = ${sessionId}::uuid) as bill_requested_at`;
    return row;
  }
}

import { allocateOrderNumber } from '../db/database.js';
import { BranchModel } from '../model/branch.model.js';
import { DineInModel } from '../model/dine-in.model.js';
import { OrderModel } from '../model/order.model.js';
import { MIN_FORCE_CLOSE_REASON, TABLE_CLOSED_PREFIX } from '../shared/rules/dine-in.js';
import { TABLE_PAYMENTS } from '../shared/rules/constants.js';
import { apiError } from '../shared/error-codes.js';
import { isUuid } from '../shared/validation.js';
import { priceLines } from './order-pricing.js';

const NOT_FOUND = () => apiError('not_found', 'That table could not be found.');
const fieldError = (message, fields) => apiError('validation_failed', message, fields);

/**
 * The floor, one table's bill, staff-entered orders and settling a table (guide 8.3,
 * core's portal-dinein). Only the counter settles: a diner's "Pay bill" is a request.
 */
export class FloorService {
  #repository;
  #menu;
  #branches;
  #idempotency;

  constructor({ repository, menu, branches, idempotency }) {
    this.#repository = repository;
    this.#menu = menu;
    this.#branches = branches;
    this.#idempotency = idempotency;
  }

  /** Branches this person sees; an owner may narrow to one. */
  async #branchesFor(actor, requested, sql) {
    const all = await this.#branches.visibleBranches(actor.tenantId, actor.branchId ?? null, sql);
    return !actor.branchId && isUuid(requested) && all.some((branch) => branch.id === requested)
      ? all.filter((branch) => branch.id === requested) : all;
  }

  /** A table this person may act on: another restaurant's or branch's is "not found". */
  async #table(sql, actor, id, { lock = false } = {}) {
    if (!isUuid(id)) throw NOT_FOUND();
    const table = lock ? await this.#repository.lockTable(sql, actor.tenantId, id) : await this.#repository.findTable(sql, actor.tenantId, id);
    if (!table || (actor.branchId && table.branch_id !== actor.branchId)) throw NOT_FOUND();
    if (!actor.branchId && !(await this.#branches.visibleBranches(actor.tenantId, null, sql)).some((branch) => branch.id === table.branch_id)) throw NOT_FOUND();
    return table;
  }

  async floor({ actor, now }, query = {}) {
    const branches = await this.#branchesFor(actor, query.branch);
    const ids = branches.map((branch) => branch.id);
    const [rows, waiters] = await Promise.all([this.#repository.floor(actor.tenantId, ids), this.#repository.waitersAt(undefined, actor.tenantId, ids)]);
    return {
      branches: branches.map(BranchModel.toBranch),
      tables: rows.map((row) => ({
        table: DineInModel.toTable(row.table), session: OrderModel.toSession(row.session), total: row.total,
        orderCount: row.order_count, waitingForWaiter: row.waiting, openRequests: row.open_requests,
      })),
      waiters: waiters.map(DineInModel.toWaiter),
      generatedAt: now.toISOString(),
    };
  }

  /** TableDetail: the table, its open party, the party's orders (the running bill) and the branch's waiters. */
  async table({ actor }, id, sql, { session: closed } = {}) {
    const table = await this.#table(sql, actor, id);
    const session = closed ?? await this.#repository.currentSession(sql, actor.tenantId, table.id);
    const [orders, waiters] = await Promise.all([
      session ? this.#repository.sessionOrders(sql, actor.tenantId, session.id) : [],
      this.#repository.waitersAt(sql, actor.tenantId, [table.branch_id]),
    ]);
    return {
      table: DineInModel.toTable(table),
      session: OrderModel.toSession(session),
      orders: orders.map(OrderModel.toOrder),
      waiters: waiters.map(DineInModel.toWaiter),
    };
  }

  /**
   * Staff enter items for a table: a party that won't scan, or dessert after the bill
   * was asked for. Priced exactly as diner orders are. Created accepted: staff are at
   * the table. Recorded as entered by the person, which settles disputes over the bill.
   */
  addOrder(context, access, { body = {}, key }) {
    const { actor, log, now } = context;
    return this.#idempotency.run(context, { key, method: 'POST', path: '/portal/dine-in/orders', body }, async (tx) => {
      const table = await this.#table(tx, actor, body?.tableId, { lock: true });
      if (!table.active) throw NOT_FOUND();
      const notes = OrderModel.notes(body?.notes);
      if (notes.error) throw fieldError('Check the highlighted fields.', { notes: notes.error });
      const { items, total } = await priceLines(this.#menu, tx, { tenantId: actor.tenantId, lines: body?.items, features: access.features, now, timeZone: access.tenant.timezone });

      let session = await this.#repository.openSession(tx, actor.tenantId, table.id);
      const waiterId = session?.waiter_id ?? (isUuid(body?.waiterId) ? body.waiterId : null);
      const waiter = waiterId ? await this.#repository.waiterAt(tx, actor.tenantId, table.branch_id, waiterId) : null;
      if (!waiter) throw fieldError('Choose the waiter serving this table.', { waiterId: 'Choose the waiter serving this table.' });
      if (!session) session = await this.#repository.createSession(tx, { tenantId: actor.tenantId, branchId: table.branch_id, tableId: table.id, waiterId: waiter.id, now });
      else if (!session.waiter_id) await this.#repository.setSession(tx, actor.tenantId, session.id, { waiterId: waiter.id });

      const { day, number } = await allocateOrderNumber(tx, actor.tenantId);
      const at = now.toISOString();
      const order = await this.#repository.insertOrder(tx, {
        number, businessDay: day, tenantId: actor.tenantId, branchId: table.branch_id, tableNumber: table.number, tableId: table.id,
        sessionId: session.id, waiterId: waiter.id, items, total, notes: notes.value, status: 'accepted', source: 'staff',
        enteredBy: 'staff', enteredByName: actor.name, history: [{ status: 'new', at }, { status: 'accepted', at }], now,
      });
      log.info({ tenantId: actor.tenantId, tableId: table.id, orderId: order.id, number, lines: items.length }, 'Staff order entered');
      return this.table(context, table.id, tx);
    });
  }

  /**
   * Settles the table. Paid: refused while an order still waits for a waiter (nobody has
   * looked at it); orders with a waiter count as served. Force closed: for a party that
   * left without paying; anything open is cancelled and lands in the void log.
   */
  close(context, access, id, { body = {}, key }) {
    const { actor, log, now } = context;
    return this.#idempotency.run(context, { key, method: 'POST', path: `/portal/dine-in/tables/${id}/close`, body }, async (tx) => {
      const table = await this.#table(tx, actor, id, { lock: true });
      const session = await this.#repository.openSession(tx, actor.tenantId, table.id);
      if (!session) throw apiError('no_session', `Table ${table.number} is already free.`);
      const orders = await this.#repository.sessionOrders(tx, actor.tenantId, session.id);
      let closed;
      if (body?.outcome === 'paid') {
        const waiting = orders.filter((order) => order.status === 'new').length;
        if (waiting > 0) {
          throw apiError('orders_waiting', `${waiting} order${waiting === 1 ? ' is' : 's are'} still waiting for a waiter. Give ${waiting === 1 ? 'it' : 'them'} to a waiter or cancel before taking payment.`);
        }
        if (!TABLE_PAYMENTS.includes(body.paidBy)) throw fieldError('How did they pay?', { paidBy: 'Choose how they paid.' });
        closed = await this.#repository.closePaid(tx, { tenantId: actor.tenantId, sessionId: session.id, paidBy: body.paidBy, closedBy: actor.name, now });
      } else if (body?.outcome === 'force_closed') {
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < MIN_FORCE_CLOSE_REASON) throw fieldError('Say why the table is being closed.', { reason: 'Say why the table is being closed.' });
        closed = await this.#repository.closeForced(tx, {
          tenantId: actor.tenantId, sessionId: session.id, reason, closedBy: actor.name, cancelReason: `${TABLE_CLOSED_PREFIX}${reason}`, now,
        });
      } else {
        throw fieldError('Check the highlighted fields.', { outcome: 'Choose paid or closed without payment.' });
      }
      log.info({ tenantId: actor.tenantId, tableId: table.id, outcome: closed.closed_as, amountPaid: closed.amount_paid }, 'Table settled');
      return this.table(context, table.id, tx, { session: closed });
    });
  }
}

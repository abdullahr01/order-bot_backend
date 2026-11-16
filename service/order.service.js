import { OrderModel } from '../model/order.model.js';
import { HISTORY_DAYS } from '../shared/rules/access.js';
import { ORDER_RANGES, ORDER_STATUSES } from '../shared/rules/constants.js';
import { canTransition, MIN_CANCEL_REASON_LENGTH } from '../shared/rules/orders.js';
import { apiError } from '../shared/error-codes.js';
import { startOfLocalDay } from '../shared/time.js';
import { isUuid } from '../shared/validation.js';
import { NO_LIVE } from './live.service.js';

const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30 };
const STATUS_WORDS = { new: 'new', accepted: 'with a waiter', served: 'served', cancelled: 'cancelled' };
const NOT_FOUND = () => apiError('not_found', 'That order could not be found.');
const fieldError = (message, fields) => apiError('validation_failed', message, fields);

/**
 * The branch a person works on. Staff and counters: their own, whatever they ask for
 * (the owner too, at a counter). Owners in the portal: the one they ask for, or all.
 */
export function branchScope(actor, requested) {
  if (actor.branchId) return actor.branchId;
  return isUuid(requested) ? requested : null;
}

/** "1247", "#1247" → an order number; "t7", "Table 7" → a table (core's matchesOrderSearch). */
function parseSearch(value) {
  const q = typeof value === 'string' ? value.trim().toLowerCase().replace(/^#/, '') : '';
  if (!q) return {};
  const table = /^(?:t|table)\s*(\d+)$/.exec(q);
  if (table) return { table: Number(table[1]) };
  return /^\d{1,9}$/.test(q) ? { number: q } : { none: true };
}

/** The counter's order board and the portal's order record (guide 8.2). */
export class OrderService {
  #database;
  #repository;

  #live;

  constructor({ database, repository, live = NO_LIVE }) {
    this.#live = live;
    this.#database = database;
    this.#repository = repository;
  }

  async list({ actor, now }, access, query = {}) {
    const branchId = branchScope(actor, query.branch);
    const view = query.view === 'completed' ? 'completed' : 'active';
    // History goes back as far as the role allows: owners 30 days, staff 7.
    const range = ORDER_RANGES.includes(query.range) ? query.range : 'today';
    const days = Math.min(RANGE_DAYS[range], HISTORY_DAYS[actor.role === 'tenant_owner' ? 'owner' : 'staff']);
    const since = startOfLocalDay(now, access.tenant.timezone, -(days - 1));
    const search = parseSearch(query.q);
    const [rows, counts] = await Promise.all([
      search.none ? [] : this.#repository.list(actor.tenantId, { branchId, view, since, ...search }),
      this.#repository.countsToday(actor.tenantId, branchId),
    ]);
    return {
      items: rows.map(OrderModel.toOrder),
      counts: Object.fromEntries(ORDER_STATUSES.map((status) => [status, counts.find((row) => row.status === status)?.count ?? 0])),
      generatedAt: now.toISOString(),
    };
  }

  async get({ actor }, id) {
    const row = isUuid(id) ? await this.#repository.findOrder(undefined, actor.tenantId, branchScope(actor), id) : null;
    if (!row) throw NOT_FOUND();
    return OrderModel.toOrder(row);
  }

  /**
   * Gives an order to a waiter, marks it served, or cancels it. `from` is what the person
   * saw: if another counter changed the order meanwhile, this one is refused, never a
   * skipped or doubled step. The row is locked, so two taps can't both pass.
   */
  async updateStatus({ actor, log, now }, id, body = {}) {
    const { from, status } = body ?? {};
    if (!ORDER_STATUSES.includes(from) || !ORDER_STATUSES.includes(status)) {
      throw fieldError('Check the highlighted fields.', { ...(ORDER_STATUSES.includes(from) ? {} : { from: 'Send the status you saw.' }), ...(ORDER_STATUSES.includes(status) ? {} : { status: 'Choose a status.' }) });
    }
    const updated = await this.#database.withTx(async (tx) => {
      const order = isUuid(id) ? await this.#repository.findOrder(tx, actor.tenantId, branchScope(actor), id, { lock: true }) : null;
      if (!order) throw NOT_FOUND();
      if (order.status !== from) {
        throw apiError('order_changed', `Order #${order.number} is already ${STATUS_WORDS[order.status]}. The list has been refreshed.`);
      }
      if (!canTransition(order.status, status)) {
        throw apiError('invalid_transition', `Order #${order.number} can’t be marked ${STATUS_WORDS[status]} now.`);
      }
      const change = { from, status, now };
      if (status === 'accepted') {
        // Assigning a waiter is the check that someone is really at the table.
        const waiter = isUuid(body.waiterId) ? await this.#repository.waiterAt(tx, actor.tenantId, order.branch_id, body.waiterId) : null;
        if (!waiter) throw fieldError('Choose a waiter.', { waiterId: 'Choose the waiter who will serve this table.' });
        change.waiterId = waiter.id;
        // Later orders from the same party go straight to this waiter.
        if (order.session_id) await this.#repository.setSession(tx, actor.tenantId, order.session_id, { waiterId: waiter.id });
      }
      if (status === 'cancelled') {
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < MIN_CANCEL_REASON_LENGTH) throw fieldError('Give a reason.', { reason: 'Give a short reason; it is kept in the void log.' });
        change.cancelReason = reason;
        change.cancelledBy = actor.name;
      }
      const saved = await this.#repository.setStatus(tx, actor.tenantId, order.id, change);
      if (!saved) {
        const current = await this.#repository.findOrder(tx, actor.tenantId, branchScope(actor), order.id);
        throw apiError('order_changed', `Order #${order.number} is already ${STATUS_WORDS[current.status]}. The list has been refreshed.`);
      }
      return saved;
    }, { logger: log });
    log.success({ tenantId: actor.tenantId, orderId: updated.id, number: updated.number, status }, 'Order status changed');
    this.#live.orderUpdated({ branchId: updated.branch_id, tableId: updated.table_id, orderId: updated.id });
    return OrderModel.toOrder(updated);
  }
}

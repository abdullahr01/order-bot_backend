import { allocateOrderNumber } from '../db/database.js';
import { MenuModel } from '../model/menu.model.js';
import { OrderModel } from '../model/order.model.js';
import { SERVICE_REQUEST_KINDS } from '../shared/rules/constants.js';
import { sessionTotal } from '../shared/rules/dine-in.js';
import { itemAvailability, scheduleOpen, scheduleText } from '../shared/rules/menu.js';
import { defaultHours, openStatus } from '../shared/rules/service.js';
import { apiError } from '../shared/error-codes.js';
import { priceLines } from './order-pricing.js';
import { NO_LIVE } from './live.service.js';

const HOUR_MS = 60 * 60 * 1000;
/** Orders one party can send in an hour (guide §13). A real party never gets near it; a prank does. */
const MAX_ORDERS_PER_HOUR = 8;
const MAX_REQUESTS_PER_HOUR = 20;
const CLIENT_REF_MAX = 64;
const NOT_IN_USE = () => apiError('table_not_found', 'This QR code isn’t in use any more. Please ask a waiter.');
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

const NOT_TAKING = {
  paused: 'The kitchen has paused new orders for a few minutes. Please try again shortly, or ask a waiter.',
  closed: 'The restaurant isn’t taking orders right now.',
  unavailable: 'Ordering from the table isn’t available here. Please order with a waiter.',
};

/**
 * The page behind a table's QR code (guide 7.1, core's diner handlers). No sign-in: the
 * table's token is the only key and leads to one table. Nothing internal is returned:
 * no other tables, restaurant id, staff names or hidden dishes.
 */
export class DinerService {
  #database;
  #repository;
  #menu;
  #entitlements;

  #live;

  constructor({ database, repository, menu, entitlements, live = NO_LIVE }) {
    this.#live = live;
    this.#database = database;
    this.#repository = repository;
    this.#menu = menu;
    this.#entitlements = entitlements;
  }

  /** Opening hours, the owner's pause and the branch's own pause (whichever is later). */
  static ordering(row, access, now) {
    if (access.readOnly || !access.features.has('qr_ordering')) return { state: 'unavailable' };
    const pauses = [row.restaurant_paused_until, row.branch_paused_until].filter((value) => value && new Date(value) > now).map((value) => new Date(value));
    const pausedUntil = pauses.length ? new Date(Math.max(...pauses)) : null;
    const status = openStatus({ hours: row.hours ?? defaultHours(), pausedUntil }, now, row.timezone);
    if (status.state === 'open') return { state: 'open' };
    if (status.state === 'paused') return { state: 'paused', until: iso(status.until) };
    return { state: 'closed', opensAt: iso(status.opensAt) };
  }

  async #load(token, now, sql) {
    const row = typeof token === 'string' && token.length <= 100 ? await this.#repository.tableByToken(token, sql) : null;
    if (!row) throw NOT_IN_USE();
    const access = await this.#entitlements.forTenant(row.tenant_id, now);
    if (!access) throw NOT_IN_USE();
    return { row, access };
  }

  async page(token, now) {
    const { row, access } = await this.#load(token, now);
    const timed = access.features.has('time_menus');
    const page = await this.#repository.dinerPage(row.tenant_id, row.session?.id ?? null);
    const orders = page.orders;
    return {
      // Prices on the page are in this currency. No logo upload yet: null shows the initials.
      restaurant: { name: row.business_name, city: row.city, logoUrl: null, currency: access.tenant.currency },
      branch: { name: row.branch_name, isMain: row.is_main },
      table: { number: row.number, label: row.label },
      ordering: DinerService.ordering(row, access, now),
      menu: {
        // Without time-based menus on the plan, schedules are ignored.
        categories: page.categories.map((category) => {
          const scheduled = timed && category.schedule;
          return {
            id: category.id, name: category.name,
            servedNow: scheduled ? scheduleOpen(category.schedule, now, row.timezone) : true,
            servedText: scheduled ? scheduleText(category.schedule) : null,
          };
        }),
        items: page.items.map((item) => {
          const dish = MenuModel.toItem(item);
          return {
            id: dish.id, categoryId: dish.categoryId, name: dish.name, description: dish.description, price: dish.price,
            photoUrl: dish.photoUrl, soldOut: itemAvailability(dish, now) === 'sold_out', options: dish.options,
          };
        }),
        version: page.version,
      },
      // Cancelled orders stay on the bill (struck through) but don't count.
      bill: { orders: orders.map(OrderModel.toDinerOrder), total: sessionTotal(orders), billRequestedAt: iso(page.bill_requested_at) },
      openRequests: page.requests,
      features: { quickRequests: access.features.has('quick_requests'), billRequest: access.features.has('bill_request') },
      generatedAt: now.toISOString(),
    };
  }

  /**
   * A diner sends their cart. It reaches the counter as new, for staff to check someone
   * is at the table and give it to a waiter; a party that already has a waiter skips that.
   */
  async order({ log, now }, token, body = {}) {
    const clientRef = typeof body?.clientRef === 'string' ? body.clientRef.trim() : '';
    if (clientRef.length > CLIENT_REF_MAX) throw apiError('validation_failed', 'Check the highlighted fields.', { clientRef: `Up to ${CLIENT_REF_MAX} characters.` });
    const notes = OrderModel.notes(body?.notes);
    if (notes.error) throw apiError('validation_failed', 'Check the highlighted fields.', { notes: notes.error });

    const placed = await this.#database.withTx(async (tx) => {
      const { row, access } = await this.#load(token, now, tx);
      // Every order at one table waits its turn, so two phones can't open two parties.
      await this.#repository.lockTable(tx, row.tenant_id, row.id);
      // Sent before and the answer was lost: the order exists, show the page.
      if (clientRef) {
        const seen = await this.#repository.findClientRef(tx, clientRef);
        if (seen) return { repeated: true, tenantId: row.tenant_id };
      }
      const ordering = DinerService.ordering(row, access, now);
      if (ordering.state !== 'open') throw apiError('not_taking_orders', NOT_TAKING[ordering.state]);
      const { items, total } = await priceLines(this.#menu, tx, { tenantId: row.tenant_id, lines: body?.items, features: access.features, now, timeZone: row.timezone });

      let session = await this.#repository.openSession(tx, row.tenant_id, row.id);
      if (session && await this.#repository.recentDinerOrders(tx, session.id, new Date(now.getTime() - HOUR_MS)) >= MAX_ORDERS_PER_HOUR) {
        throw apiError('too_many_orders', 'This table has sent a lot of orders. Please ask a waiter to add more.');
      }
      session ??= await this.#repository.createSession(tx, { tenantId: row.tenant_id, branchId: row.branch_id, tableId: row.id, now });
      // A party that already has a waiter: later rounds go straight to them.
      const waiter = session.waiter_id ? await this.#repository.waiterAt(tx, row.tenant_id, row.branch_id, session.waiter_id) : null;
      const at = now.toISOString();
      const { day, number } = await allocateOrderNumber(tx, row.tenant_id);
      const order = await this.#repository.insertOrder(tx, {
        number, businessDay: day, tenantId: row.tenant_id, branchId: row.branch_id, tableNumber: row.number, tableId: row.id,
        sessionId: session.id, waiterId: waiter?.id ?? null, items, total, notes: notes.value,
        status: waiter ? 'accepted' : 'new', source: 'qr', enteredBy: 'customer', enteredByName: null,
        history: waiter ? [{ status: 'new', at }, { status: 'accepted', at }] : [{ status: 'new', at }], now,
      });
      // After the bill was asked for, another round reopens the table.
      if (session.status === 'bill_requested') await this.#repository.setSession(tx, row.tenant_id, session.id, { status: 'open' });
      if (clientRef) await this.#repository.saveClientRef(tx, { clientRef, tenantId: row.tenant_id, branchId: row.branch_id, orderId: order.id });
      return { tenantId: row.tenant_id, branchId: row.branch_id, tableId: row.id, orderId: order.id, number, status: order.status, lines: items.length };
    }, { logger: log });

    if (placed.repeated) log.info({ tenantId: placed.tenantId }, 'Repeated diner order: already placed');
    else {
      log.success({ tenantId: placed.tenantId, orderId: placed.orderId, number: placed.number, status: placed.status, lines: placed.lines }, 'Diner order placed');
      this.#live.orderCreated({ branchId: placed.branchId, tableId: placed.tableId, orderId: placed.orderId });
    }
    return this.page(token, now);
  }

  /** Water, roti, the bill: one tap. Asking again before it is seen to changes nothing. */
  async request({ log, now }, token, body = {}) {
    const kind = body?.kind;
    if (!SERVICE_REQUEST_KINDS.includes(kind)) throw apiError('validation_failed', 'Choose what you need.', { kind: 'Choose what you need.' });
    const result = await this.#database.withTx(async (tx) => {
      const { row, access } = await this.#load(token, now, tx);
      if (!access.features.has(kind === 'bill' ? 'bill_request' : 'quick_requests')) throw apiError('feature_locked', 'Please ask a waiter.');
      await this.#repository.lockTable(tx, row.tenant_id, row.id);
      const session = await this.#repository.openSession(tx, row.tenant_id, row.id);
      if (!session) throw apiError('no_session', 'Order first, then you can ask from here. For anything now, please call a waiter.');
      if (await this.#repository.recentRequests(tx, session.id, new Date(now.getTime() - HOUR_MS)) >= MAX_REQUESTS_PER_HOUR) {
        throw apiError('rate_limited', 'This table has asked a lot already. Please call a waiter.');
      }
      const added = await this.#repository.addRequest(tx, {
        tenantId: row.tenant_id, branchId: row.branch_id, tableId: row.id, tableNumber: row.number, sessionId: session.id, kind, now,
      });
      if (added && kind === 'bill') await this.#repository.setSession(tx, row.tenant_id, session.id, { status: 'bill_requested', billRequestedAt: now });
      return { tenantId: row.tenant_id, branchId: row.branch_id, tableId: row.id, added };
    }, { logger: log });
    log.success({ tenantId: result.tenantId, kind, added: result.added }, 'Diner request received');
    if (result.added) this.#live.requestCreated({ branchId: result.branchId, tableId: result.tableId });
    return this.page(token, now);
  }
}

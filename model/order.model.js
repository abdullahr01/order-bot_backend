// Orders, table sessions and diner requests as the apps see them (core's Order,
// TableSession, ServiceRequest, DinerOrder).
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

export class OrderModel {
  /** Different dishes in one order, and how many of one dish (guide 11.4). */
  static MAX_LINES = 30;
  static MAX_QUANTITY = 50;
  static NOTE_MAX = 200;

  static toOrder(row) {
    return {
      id: row.id, number: row.number, tenantId: row.tenant_id, branchId: row.branch_id,
      items: row.items, total: row.total, table: row.table_number, notes: row.notes, status: row.status,
      source: row.source, createdAt: iso(row.created_at), cancelReason: row.cancel_reason, history: row.history,
      tableId: row.table_id, sessionId: row.session_id, waiterId: row.waiter_id,
      enteredBy: row.entered_by, enteredByName: row.entered_by_name, cancelledBy: row.cancelled_by,
    };
  }

  /** What the diner sees on the bill: nothing internal to the restaurant. */
  static toDinerOrder(row) {
    return {
      id: row.id, number: row.number, items: row.items, total: row.total, notes: row.notes,
      status: row.status, createdAt: iso(row.created_at), byStaff: row.entered_by === 'staff',
    };
  }

  static toSession(row) {
    if (!row) return null;
    return {
      id: row.id, tenantId: row.tenant_id, branchId: row.branch_id, tableId: row.table_id, status: row.status,
      waiterId: row.waiter_id, openedAt: iso(row.opened_at), billRequestedAt: iso(row.bill_requested_at),
      closedAt: iso(row.closed_at), closedAs: row.closed_as, paidBy: row.paid_by, amountPaid: row.amount_paid,
      closedBy: row.closed_by, closeReason: row.close_reason,
    };
  }

  static toRequest(row) {
    return {
      id: row.id, tenantId: row.tenant_id, branchId: row.branch_id, tableId: row.table_id, table: row.table_number,
      sessionId: row.session_id, kind: row.kind, createdAt: iso(row.created_at), handledAt: iso(row.handled_at), handledBy: row.handled_by,
    };
  }

  /** The note on an order: trimmed, at most 200 characters, or null. */
  static notes(value) {
    if (value === undefined || value === null || value === '') return { value: null };
    if (typeof value !== 'string') return { error: 'Notes must be text.' };
    const text = value.trim();
    if (text.length > OrderModel.NOTE_MAX) return { error: `Keep notes under ${OrderModel.NOTE_MAX} characters.` };
    return { value: text || null };
  }
}

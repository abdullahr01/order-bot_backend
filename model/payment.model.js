// A fee marked received in the console (core's Payment).
export class PaymentModel {
  /** Large enough for any fee in rupees or pounds; stops an integer overflow in the database. */
  static MAX_AMOUNT = 10_000_000;

  static toPayment(row) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      kind: row.kind,
      // "YYYY-MM": the billing month, or the month the setup fee was received.
      month: (row.month instanceof Date ? row.month.toISOString() : String(row.month ?? new Date(row.recorded_at).toISOString())).slice(0, 7),
      amount: row.amount,
      method: row.method,
      reference: row.reference ?? '',
      recordedBy: row.recorded_by,
      recordedAt: new Date(row.recorded_at).toISOString(),
    };
  }
}

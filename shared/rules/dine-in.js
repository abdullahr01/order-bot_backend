// Ported from the partner's packages/core/src/dine-in. Keep the two in step.
export const STALE_SESSION_MINUTES = 150;
/** Orders cancelled because their table was closed without payment carry this before the reason. */
export const TABLE_CLOSED_PREFIX = 'Table closed: ';
export const MIN_FORCE_CLOSE_REASON = 5;

/** The bill so far: every order at the table except cancelled ones. */
export function sessionTotal(orders) {
  return orders.filter((order) => order.status !== 'cancelled').reduce((sum, order) => sum + order.total, 0);
}

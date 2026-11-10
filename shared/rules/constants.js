// Fixed values from the partner's packages/core/src/types. Keep the two in step.
export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'];
export const TENANT_SORTS = ['last_order', 'name', 'value', 'newest'];
export const PAYMENT_METHODS = ['cash', 'cheque', 'bank_transfer', 'easypaisa', 'jazzcash', 'card'];
export const PAYMENT_METHOD_LABELS = {
  cash: 'Cash', cheque: 'Cheque', bank_transfer: 'Bank transfer', easypaisa: 'Easypaisa', jazzcash: 'JazzCash', card: 'Card',
};
export const PAYMENT_REFERENCE_MAX = 60;
export const AUDIT_CHECKS = ['billing', 'limits', 'locked', 'overrides', 'activity', 'orphans'];
export const ORDER_STATUSES = ['new', 'accepted', 'served', 'cancelled'];
export const ORDER_RANGES = ['today', '7d', '30d'];
export const TABLE_PAYMENTS = ['cash', 'card', 'wallet'];
export const SERVICE_REQUEST_KINDS = ['water', 'roti', 'napkins', 'cutlery', 'waiter', 'bill'];
export const COUNTER_PIN_LENGTH = 4;
export const PAIRING_CODE_MINUTES = 15;
export const ADMIN_ROLES = ['founder', 'team', 'partner'];

/** Audit log filter groups for the console. */
export const EVENT_GROUPS = {
  restaurants: ['tenant_created', 'tenant_updated', 'branch_added', 'branch_updated', 'branch_removed'],
  plans: ['plan_changed', 'plan_change_scheduled', 'plan_change_cancelled'],
  addons: ['addon_added', 'addon_removed'],
  access: ['override_granted', 'override_revoked', 'override_removed', 'limit_changed'],
  status: ['status_changed'],
  billing: ['payment_recorded'],
  catalog: ['catalog_plan_updated', 'catalog_addon_updated'],
  partners: ['partner_updated', 'partner_payment_recorded'],
};

import { ApiError } from './api-error.js';

// Every code the apps may receive (guide section 14). `unauthorized` covers a
// missing or expired sign-in, and `month_open` comes from core's partner routes.
const CODES_BY_STATUS = {
  400: ['bad_request'],
  401: ['unauthorized', 'account_removed', 'counter_locked', 'device_revoked'],
  403: ['forbidden', 'feature_locked', 'limit_reached', 'account_paused'],
  404: ['not_found', 'table_not_found', 'tenant_not_found', 'branch_not_found', 'plan_not_found',
    'addon_not_found', 'addon_not_active', 'override_not_found'],
  409: ['order_changed', 'orders_waiting', 'no_session', 'not_taking_orders', 'table_in_use', 'waiter_busy',
    'category_not_empty', 'in_use', 'branch_in_use', 'main_branch', 'menu_changed', 'already_paid',
    'already_handled', 'already_enabled', 'same_plan', 'same_status', 'nothing_scheduled', 'no_changes',
    'no_onboarding', 'duplicate_name', 'duplicate_branch', 'branch_limit', 'closed_month', 'audit_completed',
    'month_open'],
  413: ['photo_too_large'],
  422: ['validation_failed', 'invalid_input', 'invalid_transition', 'wrong_pin', 'reason_required',
    'confirmation_mismatch', 'invalid_plan', 'invalid_status', 'invalid_addon', 'addon_unavailable',
    'duplicate_addon', 'invalid_feature', 'invalid_limit', 'invalid_limit_value', 'invalid_expiry',
    'missing_dependency', 'invalid_quantity', 'invalid_step', 'invalid_method', 'invalid_amount',
    'invalid_reference', 'invalid_price', 'invalid_tagline', 'no_plans', 'invalid_check', 'invalid_action',
    'incomplete', 'invalid_photo'],
  429: ['pin_held', 'too_many_orders', 'rate_limited'],
};

export const ERROR_STATUS = Object.freeze(Object.fromEntries(
  Object.entries(CODES_BY_STATUS).flatMap(([status, codes]) => codes.map((code) => [code, Number(status)])),
));

/** An intentional API error. The status comes from the code, so the two can't disagree. */
export function apiError(code, message, fields) {
  const status = ERROR_STATUS[code];
  if (!status) throw new TypeError(`Unknown API error code: ${code}`);
  return new ApiError(status, code, message, fields);
}

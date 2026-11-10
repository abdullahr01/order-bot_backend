import { canSee, isPartner } from '../shared/rules/admin-scope.js';
import { can } from '../shared/rules/access.js';
import { apiError } from '../shared/error-codes.js';
import { FEATURES } from '../shared/rules/features.js';
import { isUuid } from '../shared/validation.js';

const PAUSED_MESSAGE = 'Your account is paused, so changes can’t be saved. Call us to switch it back on.';
const SETUP_LOCKED_MESSAGE = 'Your payment is overdue, so the menu, tables and team can’t be changed. Call us to sort it out.';

export function createAccessMiddleware({ entitlements, authRepository }) {
  /** Loaded at most once per request, then shared by every check on that route. */
  function accessOf(request) {
    request.access ??= entitlements.forTenant(request.actor.tenantId).then((access) => {
      if (!access) throw apiError('tenant_not_found', 'This restaurant does not exist.');
      return access;
    });
    return request.access;
  }

  return {
    accessOf,

    requirePermission(permission) {
      return (request, _response, next) => {
        if (!can(request.actor.role, permission)) throw apiError('forbidden', 'Only the restaurant owner can do this.');
        next();
      };
    },

    requireFeature(key, message) {
      return async (request, _response, next) => {
        const access = await accessOf(request);
        // Phase 2 features can sit in a plan but aren't built yet.
        if (FEATURES[key].phase === 2 || !access.features.has(key)) {
          throw apiError('feature_locked', message ?? `${FEATURES[key].label} isn’t on your plan.`);
        }
        next();
      };
    },

    /** Any change at all: a suspended or cancelled restaurant can only look. */
    async requireWritable(request, _response, next) {
      if ((await accessOf(request)).readOnly) throw apiError('account_paused', PAUSED_MESSAGE);
      next();
    },

    /** Menu, table and team edits: also refused from day 30 of non-payment. */
    async requireSetupWritable(request, _response, next) {
      const access = await accessOf(request);
      if (access.readOnly) throw apiError('account_paused', PAUSED_MESSAGE);
      if (access.setupLocked) throw apiError('account_paused', SETUP_LOCKED_MESSAGE);
      next();
    },

    /** /admin/tenants/:id: a restaurant outside this person's scope doesn't exist for them. */
    async requireVisibleTenant(request, _response, next) {
      const tenant = isUuid(request.params.id) ? await authRepository.findTenantScope(request.params.id) : null;
      if (!tenant || !canSee(request.actor, tenant)) throw apiError('tenant_not_found', 'This restaurant does not exist.');
      next();
    },

    requireNotPartner(request, _response, next) {
      if (isPartner(request.actor)) throw apiError('forbidden', 'Only our own team can grant access outside a plan.');
      next();
    },
  };
}

import { EntitlementModel } from '../model/entitlement.model.js';
import { explainEntitlements, isReadOnly, isSetupLocked } from '../shared/rules/entitlements.js';

export class EntitlementService {
  #repository;

  constructor({ repository }) { this.#repository = repository; }

  /**
   * Resolved fresh on each request, so an override expiring or a past-due day
   * passing takes effect at once. Add a cache only if polling needs it.
   */
  async forTenant(tenantId, now = new Date()) {
    const row = await this.#repository.loadForTenant(tenantId);
    return row ? EntitlementService.resolve(EntitlementModel.fromRow(row), now) : null;
  }

  static resolve(input, now) {
    const { tenant, subscription, addons, overrides, catalog } = input;
    const explanation = explainEntitlements({ subscription, addons, overrides, now, catalog });
    return {
      tenant, subscription, catalog, addons, overrides, explanation,
      features: new Set(explanation.features.filter((feature) => feature.enabled).map((feature) => feature.key)),
      paused: explanation.features.filter((feature) => feature.blockedBy !== null).map((feature) => feature.key),
      limits: Object.fromEntries(explanation.limits.map((limit) => [limit.key, limit.value])),
      readOnly: isReadOnly(subscription),
      setupLocked: isSetupLocked(subscription, now),
    };
  }
}

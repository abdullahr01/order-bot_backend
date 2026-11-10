import { BranchModel } from '../model/branch.model.js';
import { FEATURE_KEYS } from '../shared/rules/features.js';
import { cheapestUnlock } from '../shared/rules/subscriptions.js';
import { apiError } from '../shared/error-codes.js';

/** The restaurant portal's starting point (guide 8.1, core's getMe). */
export class PortalService {
  #repository;

  constructor({ repository }) { this.#repository = repository; }

  async me({ actor, log }, access) {
    // At a counter everyone works on its branch, the owner included.
    const account = await this.#repository.findAccount(actor.tenantId, actor.branchId);
    if (!account) throw apiError('tenant_not_found', 'This restaurant does not exist.');
    const { subscription, catalog, explanation } = access;
    const features = explanation.features.filter((feature) => feature.enabled).map((feature) => feature.key);
    const paused = access.paused;

    // Paused features are already paid for, so they are never offered for sale.
    const held = new Set([...features, ...paused]);
    const unlocks = {};
    for (const key of FEATURE_KEYS) {
      if (held.has(key)) continue;
      const unlock = cheapestUnlock(key, subscription.planId, catalog);
      if (!unlock) continue;
      unlocks[key] = unlock.kind === 'addon'
        ? { kind: 'addon', label: `${catalog.addons[unlock.addonId].name} add-on`, price: unlock.price }
        : { kind: 'plan', label: `${catalog.plans[unlock.planId].name} plan`, price: unlock.price };
    }

    log.success({ tenantId: actor.tenantId, features: features.length, paused: paused.length }, 'Portal account loaded');
    return {
      tenant: { id: account.id, businessName: account.business_name, city: account.city, slug: account.slug, ownerName: account.owner_name },
      plan: { id: subscription.planId, name: catalog.plans[subscription.planId].name },
      subscription: {
        status: subscription.status, trialEndsAt: subscription.trialEndsAt, currentPeriodEnd: subscription.currentPeriodEnd,
        pastDueSince: subscription.pastDueSince, scheduledPlanId: subscription.scheduledPlanId,
      },
      features,
      paused,
      limits: access.limits,
      branches: account.branches.map(BranchModel.toBranch),
      unlocks,
    };
  }
}

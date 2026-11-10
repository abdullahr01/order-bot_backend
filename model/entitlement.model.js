import { ADDONS } from '../shared/rules/plans.js';

const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

const toPlan = (row) => ({
  id: row.id, name: row.name, monthlyPrice: row.monthly_price, setupFee: row.setup_fee,
  tagline: row.tagline ?? '', features: row.features, limits: row.limits,
});

const toAddon = (row) => ({
  id: row.id, name: row.name, monthlyPrice: row.monthly_price, planShare: row.plan_share,
  availableTo: row.available_to, grants: row.features,
  // Unit wording is fixed in code; the limit it adds to comes from the catalogue.
  unit: { ...ADDONS[row.id].unit, limit: row.limit_key }, hint: ADDONS[row.id].hint,
});

export class EntitlementModel {
  static fromRow(row) {
    return {
      tenant: { id: row.id, country: row.country, currency: row.currency, timezone: row.timezone },
      subscription: {
        tenantId: row.id, planId: row.plan_id, status: row.status, trialEndsAt: iso(row.trial_ends_at),
        currentPeriodEnd: iso(row.current_period_end), pastDueSince: iso(row.past_due_since),
        scheduledPlanId: row.scheduled_plan_id, billingStartsAt: iso(row.billing_starts_at), setupFee: row.setup_fee,
      },
      addons: row.tenant_addons.map((addon) => ({
        tenantId: addon.tenant_id, addonId: addon.addon_id, quantity: addon.quantity,
        activatedAt: iso(addon.activated_at), cancelsAt: iso(addon.cancels_at),
      })),
      overrides: row.tenant_overrides.map((override) => ({
        id: override.id, tenantId: override.tenant_id, featureKey: override.feature_key, limitKey: override.limit_key,
        limitValue: override.limit_value, granted: override.granted ?? true, reason: override.reason,
        expiresAt: iso(override.expires_at), createdBy: override.created_by, createdAt: iso(override.created_at),
      })),
      catalog: {
        plans: Object.fromEntries(row.catalog_plans.map((plan) => [plan.id, toPlan(plan)])),
        addons: Object.fromEntries(row.catalog_addons.map((addon) => [addon.id, toAddon(addon)])),
      },
    };
  }
}

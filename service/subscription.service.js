import { isUniqueViolation } from '../db/database.js';
import { EntitlementModel } from '../model/entitlement.model.js';
import { PaymentModel } from '../model/payment.model.js';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, PAYMENT_REFERENCE_MAX, SUBSCRIPTION_STATUSES } from '../shared/rules/constants.js';
import { formatMoney } from '../shared/rules/format.js';
import { FEATURES, isFeatureKey } from '../shared/rules/features.js';
import { LIMIT_KEYS, LIMIT_LABELS, PLAN_IDS } from '../shared/rules/plans.js';
import { addonsEndingOnPlan, addonState, missingForGrant, planChangeKind, requiresTypedConfirmation, STATUS_INFO } from '../shared/rules/subscriptions.js';
import { apiError } from '../shared/error-codes.js';
import { monthKey } from '../shared/time.js';
import { isUuid, requireReason } from '../shared/validation.js';

const ALREADY_PAID_SETUP = () => apiError('already_paid', 'The setup fee is already recorded.');
const ALREADY_PAID_MONTH = () => apiError('already_paid', 'A payment is already recorded for this month.');

/** Plan, status and fees (guide 9.3 and 9.5). Each write returns the restaurant's TenantDetail. */
export class SubscriptionService {
  #database;
  #tenants;
  #repository;
  #audit;
  #tenantService;

  #entitlements;

  constructor({ database, tenants, repository, audit, tenantService, entitlements }) {
    this.#database = database;
    this.#tenants = tenants;
    this.#repository = repository;
    this.#audit = audit;
    this.#tenantService = tenantService;
    this.#entitlements = entitlements;
  }

  // ---------------------------------------------------------------- Add-ons (guide 9.3)

  async #liveAddons(tx, tenantId, now) {
    return (await this.#repository.liveAddons(tx, tenantId, now)).map((addon) => ({
      addonId: addon.addon_id, quantity: addon.quantity, activatedAt: new Date(addon.activated_at).toISOString(),
      cancelsAt: addon.cancels_at ? new Date(addon.cancels_at).toISOString() : null,
    }));
  }

  /** Adding one already active adds to its quantity; adding one that is ending keeps it going. */
  async addAddon({ actor, log, now }, tenantId, body = {}) {
    const reason = requireReason(body.reason);
    const quantity = body.quantity === undefined ? 1 : Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 200) throw apiError('invalid_quantity', 'Enter a number from 1 to 200.', { quantity: 'Enter a number from 1 to 200.' });
    await this.#database.withTx(async (tx) => {
      const { current, catalog } = await this.#locked(tx, tenantId);
      const def = catalog.addons[body.addonId];
      if (!def) throw apiError('invalid_addon', 'Choose a valid add-on.');
      const live = await this.#liveAddons(tx, tenantId, now);
      const state = addonState(body.addonId, current.plan_id, live, now, catalog);
      if (state.state === 'unavailable') throw apiError('addon_unavailable', `${def.name}: ${state.reason}.`);
      if (state.state === 'ending') {
        await this.#repository.setAddon(tx, tenantId, body.addonId, { cancelsAt: null });
        await this.#audit.record(tx, { tenantId, action: 'addon_added', actor: actor.name, before: `${def.name} (ending)`, after: def.name, reason });
        return;
      }
      if (state.state === 'active') {
        const total = state.addon.quantity + quantity;
        if (total > 200) throw apiError('invalid_quantity', 'At most 200 of one add-on.', { quantity: 'At most 200 of one add-on.' });
        await this.#repository.setAddon(tx, tenantId, body.addonId, { quantity: total });
        await this.#audit.record(tx, { tenantId, action: 'addon_added', actor: actor.name, before: `${def.name} × ${state.addon.quantity}`, after: `${def.name} × ${total}`, reason });
        return;
      }
      await this.#repository.upsertAddon(tx, tenantId, body.addonId, quantity, now);
      await this.#audit.record(tx, { tenantId, action: 'addon_added', actor: actor.name, after: `${def.name} × ${quantity}`, reason });
    }, { logger: log });
    log.success({ tenantId, addonId: body.addonId }, 'Add-on added');
    return this.#tenantService.detail(tenantId, now);
  }

  /** Never lowered below what is in use: retire tables, logins or branches first. */
  async setAddonQuantity({ actor, log, now }, tenantId, addonId, body = {}) {
    const reason = requireReason(body.reason);
    const access = await this.#entitlements.forTenant(tenantId, now);
    await this.#database.withTx(async (tx) => {
      const { catalog } = await this.#locked(tx, tenantId);
      const addon = (await this.#liveAddons(tx, tenantId, now)).find((entry) => entry.addonId === addonId && entry.cancelsAt === null);
      const def = addon && catalog.addons[addonId];
      if (!addon || !def) throw apiError('addon_not_active', 'This add-on is not active.');
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 200) throw apiError('invalid_quantity', 'Enter a number from 1 to 200.', { quantity: 'Enter a number from 1 to 200.' });
      if (quantity === addon.quantity) throw apiError('no_changes', 'Nothing has changed.');
      const key = def.unit.limit;
      const inUse = (await this.#repository.usage(tx, tenantId))[key];
      const limit = access.explanation.limits.find((entry) => entry.key === key);
      // An override sets the limit outright, so units bought don't change it.
      const after = limit?.value === null || limit?.value === undefined ? Infinity
        : limit.source === 'override' ? limit.value : limit.value - addon.quantity + quantity;
      if (inUse > after) {
        throw apiError('in_use', `${inUse} ${LIMIT_LABELS[key]} are in use. The restaurant must retire some before the number bought is lowered.`, { quantity: `${inUse} ${LIMIT_LABELS[key]} are in use.` });
      }
      await this.#repository.setAddon(tx, tenantId, addonId, { quantity });
      const unit = (count) => (count === 1 ? def.unit.one : def.unit.many);
      await this.#audit.record(tx, { tenantId, action: 'limit_changed', actor: actor.name, before: `${addon.quantity} ${unit(addon.quantity)}`, after: `${quantity} ${unit(quantity)}`, reason });
    }, { logger: log });
    log.success({ tenantId, addonId }, 'Add-on quantity changed');
    return this.#tenantService.detail(tenantId, now);
  }

  /** Removal takes effect at the end of the paid period; it keeps working until then. */
  async removeAddon({ actor, log, now }, tenantId, addonId, body = {}) {
    const reason = requireReason(body.reason);
    await this.#database.withTx(async (tx) => {
      const { current, catalog } = await this.#locked(tx, tenantId);
      const addon = (await this.#liveAddons(tx, tenantId, now)).find((entry) => entry.addonId === addonId && entry.cancelsAt === null);
      if (!addon || !catalog.addons[addonId]) throw apiError('addon_not_active', 'This add-on is not active.');
      const ends = current.current_period_end && new Date(current.current_period_end) > now ? new Date(current.current_period_end) : now;
      await this.#repository.setAddon(tx, tenantId, addonId, { cancelsAt: ends });
      await this.#audit.record(tx, { tenantId, action: 'addon_removed', actor: actor.name, before: catalog.addons[addonId].name, after: 'Ends at period end', reason });
    }, { logger: log });
    log.success({ tenantId, addonId }, 'Add-on removal scheduled');
    return this.#tenantService.detail(tenantId, now);
  }

  // ---------------------------------------------------------------- Overrides (guide 9.3)

  /** Grants or revokes a feature, or sets a limit, outside the plan. Not for partners (router). */
  async createOverride({ actor, log, now }, tenantId, body = {}) {
    const reason = requireReason(body.reason);
    const expiresAt = body.expiresAt === null || body.expiresAt === undefined ? null : new Date(body.expiresAt);
    if (expiresAt !== null && (Number.isNaN(expiresAt.getTime()) || expiresAt <= now)) {
      throw apiError('invalid_expiry', 'The end date must be in the future.', { expiresAt: 'The end date must be in the future.' });
    }
    const access = await this.#entitlements.forTenant(tenantId, now);
    const describe = (key, value) => (value === null ? `Unlimited ${LIMIT_LABELS[key]}` : `${value.toLocaleString('en-US')} ${LIMIT_LABELS[key]}`);
    let event;
    if (body.kind === 'feature') {
      if (!isFeatureKey(body.featureKey)) throw apiError('invalid_feature', 'Choose a valid feature.');
      const granted = body.granted !== false;
      if (granted) {
        const missing = missingForGrant(body.featureKey, access.features);
        if (missing.length) {
          throw apiError('missing_dependency', `${FEATURES[body.featureKey].label} needs ${missing.map((key) => FEATURES[key].label).join(' and ')} first.`);
        }
      }
      event = { override: { featureKey: body.featureKey, granted }, action: granted ? 'override_granted' : 'override_revoked', featureKey: body.featureKey, after: FEATURES[body.featureKey].label };
    } else {
      if (!LIMIT_KEYS.includes(body.limitKey)) throw apiError('invalid_limit', 'Choose a valid limit.');
      const value = body.limitValue;
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100_000)) {
        throw apiError('invalid_limit_value', 'Enter a whole number of zero or more, or choose unlimited.', { limitValue: 'Enter a whole number of zero or more, or choose unlimited.' });
      }
      const currentValue = access.limits[body.limitKey] ?? null;
      event = { override: { limitKey: body.limitKey, limitValue: value }, action: 'limit_changed', before: describe(body.limitKey, currentValue), after: describe(body.limitKey, value) };
    }
    await this.#database.withTx(async (tx) => {
      await this.#locked(tx, tenantId);
      await this.#repository.replaceOverride(tx, tenantId, { ...event.override, reason, expiresAt, createdBy: actor.name, now });
      await this.#audit.record(tx, { tenantId, action: event.action, featureKey: event.featureKey ?? null, actor: actor.name, before: event.before ?? null, after: event.after, reason });
    }, { logger: log });
    log.success({ tenantId, action: event.action }, 'Override saved');
    return this.#tenantService.detail(tenantId, now);
  }

  /** The plan applies again. The row is ended, never deleted. */
  async removeOverride({ actor, log, now }, tenantId, overrideId, body = {}) {
    const reason = requireReason(body.reason);
    await this.#database.withTx(async (tx) => {
      await this.#locked(tx, tenantId);
      const override = isUuid(overrideId) ? await this.#repository.liveOverride(tx, tenantId, overrideId, now) : null;
      if (!override) throw apiError('override_not_found', 'This override is no longer in force.');
      await this.#repository.endOverride(tx, tenantId, override.id, now);
      const what = override.feature_key ? FEATURES[override.feature_key].label
        : override.limit_value === null ? `Unlimited ${LIMIT_LABELS[override.limit_key]}` : `${override.limit_value} ${LIMIT_LABELS[override.limit_key]}`;
      await this.#audit.record(tx, { tenantId, action: 'override_removed', featureKey: override.feature_key, actor: actor.name, before: what, after: 'Back to plan default', reason });
    }, { logger: log });
    log.success({ tenantId, overrideId }, 'Override removed');
    return this.#tenantService.detail(tenantId, now);
  }

  async #locked(tx, tenantId) {
    const current = await this.#tenants.lockForWrite(tx, tenantId);
    if (!current) throw apiError('tenant_not_found', 'This restaurant does not exist.');
    const rows = await this.#tenants.catalogRows(current.country, tx);
    return { current, catalog: EntitlementModel.catalog(rows.catalog_plans, rows.catalog_addons) };
  }

  async changePlan({ actor, log, now }, tenantId, body = {}) {
    const reason = requireReason(body.reason);
    if (!PLAN_IDS.includes(body.planId)) throw apiError('invalid_plan', 'Choose a valid plan.');
    let outcome;
    await this.#database.withTx(async (tx) => {
      const { current, catalog } = await this.#locked(tx, tenantId);
      if (body.planId === current.plan_id && !current.scheduled_plan_id) throw apiError('same_plan', 'The restaurant is already on this plan.');
      const from = catalog.plans[current.plan_id].name;
      const to = catalog.plans[body.planId].name;

      // Downgrades wait for the end of the paid period, except during a trial.
      if (planChangeKind(current.plan_id, body.planId, catalog) === 'downgrade' && current.status !== 'trial') {
        await this.#repository.schedulePlan(tx, tenantId, body.planId);
        const when = current.current_period_end
          ? new Date(current.current_period_end).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: current.timezone })
          : 'the end of the billing period';
        await this.#audit.record(tx, { tenantId, action: 'plan_change_scheduled', actor: actor.name, before: from, after: `${to} from ${when}`, reason });
        outcome = 'scheduled';
        return;
      }

      // An upgrade, or the current plan again (which cancels a waiting downgrade): applies now.
      const live = (await this.#repository.liveAddons(tx, tenantId, now)).map((addon) => ({
        addonId: addon.addon_id, quantity: addon.quantity, cancelsAt: addon.cancels_at ? new Date(addon.cancels_at).toISOString() : null,
      }));
      const ending = addonsEndingOnPlan(live, body.planId, catalog).map((addon) => addon.addonId);
      await this.#repository.applyPlan(tx, tenantId, body.planId, ending, now);
      await this.#audit.record(tx, { tenantId, action: 'plan_changed', actor: actor.name, before: from, after: to, reason });
      outcome = ending.length ? `applied, ${ending.length} add-on(s) ended` : 'applied';
    }, { logger: log });
    log.success({ tenantId, planId: body.planId, outcome }, 'Plan change saved');
    return this.#tenantService.detail(tenantId, now);
  }

  async cancelScheduledChange({ actor, log, now }, tenantId, body = {}) {
    const reason = requireReason(body.reason);
    await this.#database.withTx(async (tx) => {
      const { current, catalog } = await this.#locked(tx, tenantId);
      if (!current.scheduled_plan_id) throw apiError('nothing_scheduled', 'There is no scheduled plan change.');
      await this.#repository.cancelScheduled(tx, tenantId);
      await this.#audit.record(tx, {
        tenantId, action: 'plan_change_cancelled', actor: actor.name,
        before: `Change to ${catalog.plans[current.scheduled_plan_id].name}`, after: `Stays on ${catalog.plans[current.plan_id].name}`, reason,
      });
    }, { logger: log });
    log.success({ tenantId }, 'Scheduled plan change cancelled');
    return this.#tenantService.detail(tenantId, now);
  }

  async setStatus({ actor, log, now }, tenantId, body = {}) {
    const reason = requireReason(body.reason);
    if (!SUBSCRIPTION_STATUSES.includes(body.status)) throw apiError('invalid_status', 'Choose a valid status.');
    let stopped = null;
    await this.#database.withTx(async (tx) => {
      const { current } = await this.#locked(tx, tenantId);
      if (body.status === current.status) throw apiError('same_status', 'The restaurant already has this status.');
      if (requiresTypedConfirmation(body.status) && (typeof body.confirmation === 'string' ? body.confirmation.trim() : '') !== current.business_name) {
        throw apiError('confirmation_mismatch', 'Type the business name exactly to confirm.', { confirmation: 'Type the business name exactly.' });
      }
      await this.#repository.setStatus(tx, tenantId, body.status, now);
      // Suspending by hand is immediate, like day 45: nothing may be left open.
      if (body.status === 'suspended' || body.status === 'cancelled') {
        stopped = await this.#repository.stopService(tx, tenantId, { reason: `Account ${body.status} by the platform team`, now });
      }
      await this.#audit.record(tx, {
        tenantId, action: 'status_changed', actor: actor.name,
        before: STATUS_INFO[current.status].label, after: STATUS_INFO[body.status].label, reason,
      });
    }, { logger: log });
    log.success({ tenantId, status: body.status, ...(stopped ? { cancelledOrders: stopped.orders, closedTables: stopped.tables } : {}) }, 'Status changed');
    return this.#tenantService.detail(tenantId, now);
  }

  /**
   * Marks a fee received (guide 9.5). Checks run in core's order. A monthly payment ends
   * the past-due ladder; it never lifts a suspension (the founders' rule, 2026-11-10).
   */
  async recordPayment({ actor, log, now }, tenantId, body = {}) {
    const kind = body.kind === 'setup' ? 'setup' : 'monthly';
    const amount = Number(body.amount);
    const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
    let reactivated = false;
    try {
      await this.#database.withTx(async (tx) => {
        const { current } = await this.#locked(tx, tenantId);
        const month = monthKey(now, current.timezone);
        if (body.month !== month) throw apiError('closed_month', 'Payments can be recorded for the current month only.');
        if (kind === 'setup' && await this.#repository.paymentExists(tx, tenantId, 'setup')) throw ALREADY_PAID_SETUP();
        if (!PAYMENT_METHODS.includes(body.method)) throw apiError('invalid_method', 'Choose how they paid.', { method: 'Choose how they paid.' });
        if (!Number.isInteger(amount) || amount <= 0 || amount > PaymentModel.MAX_AMOUNT) {
          throw apiError('invalid_amount', 'Enter the amount received.', { amount: 'Enter a whole number above zero.' });
        }
        if (reference.length > PAYMENT_REFERENCE_MAX) {
          throw apiError('invalid_reference', 'That reference is too long.', { reference: `Up to ${PAYMENT_REFERENCE_MAX} characters.` });
        }
        // Cash handed over in person may have no receipt number; anything else needs one.
        if (body.method !== 'cash' && reference.length < 3) {
          throw apiError('invalid_reference', 'Add the cheque or transaction number.', { reference: 'Add the cheque or transaction number.' });
        }
        if (kind === 'monthly' && await this.#repository.paymentExists(tx, tenantId, 'monthly', month)) throw ALREADY_PAID_MONTH();

        await this.#repository.insertPayment(tx, { tenantId, kind, month, amount, method: body.method, reference, recordedBy: actor.name, now });
        await this.#audit.record(tx, {
          tenantId, action: 'payment_recorded', actor: actor.name,
          after: `${formatMoney(amount, current.currency)} via ${PAYMENT_METHOD_LABELS[body.method]}${reference ? ` (${reference})` : ''}`,
          reason: kind === 'setup' ? 'Setup fee' : `Payment for ${month}`,
        });
        if (kind === 'monthly' && current.status === 'past_due') {
          await this.#repository.setStatus(tx, tenantId, 'active', now);
          await this.#audit.record(tx, { tenantId, action: 'status_changed', actor: actor.name, before: 'Past due', after: 'Active', reason: 'Payment received' });
          reactivated = true;
        }
      }, { logger: log });
    } catch (error) {
      if (isUniqueViolation(error, 'payments_setup_unique')) throw ALREADY_PAID_SETUP();
      if (isUniqueViolation(error, 'payments_monthly_unique')) throw ALREADY_PAID_MONTH();
      throw error;
    }
    log.success({ tenantId, kind, method: body.method, backToActive: reactivated }, 'Payment recorded');
    return this.#tenantService.detail(tenantId, now);
  }
}

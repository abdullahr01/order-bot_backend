import { isUniqueViolation } from '../db/database.js';
import { EntitlementModel } from '../model/entitlement.model.js';
import { PaymentModel } from '../model/payment.model.js';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, PAYMENT_REFERENCE_MAX, SUBSCRIPTION_STATUSES } from '../shared/rules/constants.js';
import { formatMoney } from '../shared/rules/format.js';
import { PLAN_IDS } from '../shared/rules/plans.js';
import { addonsEndingOnPlan, planChangeKind, requiresTypedConfirmation, STATUS_INFO } from '../shared/rules/subscriptions.js';
import { apiError } from '../shared/error-codes.js';
import { monthKey } from '../shared/time.js';
import { requireReason } from '../shared/validation.js';

const ALREADY_PAID_SETUP = () => apiError('already_paid', 'The setup fee is already recorded.');
const ALREADY_PAID_MONTH = () => apiError('already_paid', 'A payment is already recorded for this month.');

/** Plan, status and fees (guide 9.3 and 9.5). Each write returns the restaurant's TenantDetail. */
export class SubscriptionService {
  #database;
  #tenants;
  #repository;
  #audit;
  #tenantService;

  constructor({ database, tenants, repository, audit, tenantService }) {
    this.#database = database;
    this.#tenants = tenants;
    this.#repository = repository;
    this.#audit = audit;
    this.#tenantService = tenantService;
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

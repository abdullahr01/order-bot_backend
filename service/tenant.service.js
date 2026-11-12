import { randomUUID } from 'node:crypto';
import { isUniqueViolation } from '../db/database.js';
import { BranchModel } from '../model/branch.model.js';
import { EntitlementModel } from '../model/entitlement.model.js';
import { EventModel } from '../model/event.model.js';
import { PaymentModel } from '../model/payment.model.js';
import { TeamModel } from '../model/team.model.js';
import { TenantModel } from '../model/tenant.model.js';
import { isPartner, scopeOf, viewCountry } from '../shared/rules/admin-scope.js';
import { SUBSCRIPTION_STATUSES } from '../shared/rules/constants.js';
import { explainEntitlements, isLive, monthlyValue } from '../shared/rules/entitlements.js';
import { onboardingSteps } from '../shared/rules/onboarding.js';
import { formatPhone, isMobile, REGIONS } from '../shared/rules/region.js';
import { defaultHours } from '../shared/rules/service.js';
import { addonState, amountDueFor } from '../shared/rules/subscriptions.js';
import { apiError } from '../shared/error-codes.js';
import { pageWindow, paginated } from '../shared/pagination.js';
import { monthKey } from '../shared/time.js';
import { isUuid, parseOrThrow } from '../shared/validation.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = 30;
const INVALID_INPUT = { code: 'invalid_input', message: 'Some details need fixing.' };
const DUPLICATE_NAME = () => apiError('duplicate_name', 'A restaurant with this name already exists.', { businessName: 'A restaurant with this name already exists.' });
const EMAIL_TAKEN = () => apiError('invalid_input', 'Some details need fixing.', { ownerEmail: 'This email already has an account.' });

/** Supabase refused an invite or email change: the address, or a sending limit. */
function emailRefused(error) {
  if (error?.code === 'email_exists' || error?.status === 422) return EMAIL_TAKEN();
  return apiError('invalid_input', 'Some details need fixing.', {
    ownerEmail: 'The invite email could not be sent. Check the address, or try again in a few minutes.',
  });
}

/** Restaurants for the platform console (guide 9.2). */
export class TenantService {
  #database;
  #repository;
  #audit;
  #authAdmin;
  #portalUrl;

  constructor({ database, repository, audit, authAdmin, portalUrl }) {
    this.#database = database;
    this.#repository = repository;
    this.#audit = audit;
    this.#authAdmin = authAdmin;
    this.#portalUrl = portalUrl;
  }

  // ---------------------------------------------------------------- Reads

  /**
   * Every restaurant this person sees in the country on screen, worked out once: the
   * list's row (`summary`) and what the dashboard and monthly audit need besides.
   */
  async inView(actor, now) {
    const country = viewCountry(actor);
    const scope = scopeOf(actor);
    const [rows, catalogRows] = await Promise.all([
      this.#repository.listInView({ country, partnerId: scope.role === 'partner' ? scope.partnerId : null }),
      this.#repository.catalogRows(country),
    ]);
    const catalog = EntitlementModel.catalog(catalogRows.catalog_plans, catalogRows.catalog_addons);
    const restaurants = rows.map((row) => {
      const { subscription, addons, overrides } = EntitlementModel.fromRow({ ...row, ...catalogRows });
      const live = addons.filter((addon) => isLive(addon.cancelsAt, now));
      const access = explainEntitlements({ subscription, addons: live, overrides, now, catalog });
      const value = monthlyValue(subscription, live, now, catalog);
      return {
        row, subscription, addons: live, overrides, access, monthlyValue: value,
        usage: { tables: row.active_tables, staff_accounts: row.usage_staff, stations: row.usage_stations, branches: row.usage_branches },
        summary: {
          id: row.id, businessName: row.business_name, country: row.country, partnerId: row.partner_id,
          ownerName: row.owner_name, city: row.city, planId: subscription.planId, scheduledPlanId: subscription.scheduledPlanId,
          status: subscription.status, monthlyValue: value, addonCount: live.length,
          tables: { used: row.active_tables, limit: access.limits.find((limit) => limit.key === 'tables')?.value ?? null },
          lastOrderAt: row.last_order_at ? new Date(row.last_order_at).toISOString() : null,
          ordersToday: row.orders_today, createdAt: new Date(row.created_at).toISOString(),
        },
      };
    });
    return { country, catalog, restaurants };
  }

  async list({ actor, log, now }, query) {
    const params = TenantModel.listQuery(query);
    const { country, restaurants } = await this.inView(actor, now);
    const summaries = restaurants.map((entry) => entry.summary);

    // Search, plan and city narrow the set; status is applied after counting (core).
    const matching = summaries.filter((row) => (
      (!params.search || [row.businessName, row.ownerName, row.city].some((field) => field.toLowerCase().includes(params.search))) &&
      (!params.planId || row.planId === params.planId) &&
      (!params.city || row.city === params.city)
    ));
    const statusCounts = Object.fromEntries([['all', matching.length], ...SUBSCRIPTION_STATUSES.map((status) => [status, matching.filter((row) => row.status === status).length])]);
    const filtered = params.status ? matching.filter((row) => row.status === params.status) : matching;
    const sorted = [...filtered].sort((a, b) => {
      switch (params.sort) {
        case 'name': return a.businessName.localeCompare(b.businessName);
        case 'value': return b.monthlyValue - a.monthlyValue;
        case 'newest': return b.createdAt.localeCompare(a.createdAt);
        default: return (b.lastOrderAt ?? '').localeCompare(a.lastOrderAt ?? '');
      }
    });
    const window = pageWindow(sorted.length, params, { defaultSize: 10 });
    log.success({ country, total: sorted.length, page: window.page }, 'Restaurants listed');
    return {
      ...paginated(sorted.slice(window.offset, window.offset + window.pageSize), sorted.length, window),
      statusCounts,
      // Cities of the restaurants this person can see, never anyone else's.
      cities: [...new Set(summaries.map((row) => row.city))].sort(),
    };
  }

  /** TenantDetail. Every console write returns this after committing. */
  async detail(tenantId, now, sql) {
    const row = await this.#repository.findDetail(tenantId, sql);
    if (!row) throw apiError('tenant_not_found', 'This restaurant does not exist.');
    const { subscription, addons, overrides, catalog } = EntitlementModel.fromRow(row);
    const live = addons.filter((addon) => isLive(addon.cancelsAt, now));
    const value = monthlyValue(subscription, live, now, catalog);
    return {
      tenant: TenantModel.toTenant(row),
      subscription,
      monthlyValue: value,
      addons: live,
      overrides: overrides.filter((override) => isLive(override.expiresAt, now)),
      access: explainEntitlements({ subscription, addons: live, overrides, now, catalog }),
      usage: {
        menuItems: row.usage_menu_items,
        tables: row.usage_tables,
        staffAccounts: row.usage_staff,
        // The main kitchen counts as one.
        stations: 1 + row.usage_stations,
        branches: row.usage_branches,
      },
      branches: row.branches.map(BranchModel.toBranch),
      team: row.team.map(TeamModel.toMember),
      payments: row.payments.map(PaymentModel.toPayment),
      amountDueThisMonth: value === 0 ? 0 : amountDueFor(monthKey(now, row.timezone), value, subscription.billingStartsAt, row.timezone),
      events: row.events.map(EventModel.toEvent),
    };
  }

  // ---------------------------------------------------------------- Sign-up

  async create({ actor, log, now }, body) {
    const input = parseOrThrow(TenantModel.create, body, INVALID_INPUT);
    const scope = scopeOf(actor);
    if (!scope.countries.includes(input.country)) {
      throw apiError('invalid_input', 'Some details need fixing.', { country: 'You can’t add restaurants in this country.' });
    }
    // A partner's sign-ups are theirs; the founder or team may name the partner for a UK one.
    const partnerId = isPartner(actor) ? scope.partnerId : input.partnerId ?? null;
    if (partnerId !== null && !(isUuid(partnerId) && await this.#repository.partnerCovers(partnerId, input.country))) {
      throw apiError('invalid_input', 'Some details need fixing.', { partnerId: 'Choose a partner who works in this country.' });
    }
    if (await this.#repository.nameTaken(input.businessName)) throw DUPLICATE_NAME();
    if (await this.#repository.emailTaken(input.ownerEmail)) throw EMAIL_TAKEN();

    const { catalog_plans: planRows, catalog_addons: addonRows } = await this.#repository.catalogRows(input.country);
    const catalog = EntitlementModel.catalog(planRows, addonRows);
    // Each add-on must be offered on the plan and not covered by another one chosen.
    const ids = input.addons.map((addon) => addon.addonId);
    if (new Set(ids).size !== ids.length) throw apiError('duplicate_addon', 'Each add-on can be chosen once.');
    for (const { addonId } of input.addons) {
      const others = input.addons.filter((addon) => addon.addonId !== addonId)
        .map((addon) => ({ addonId: addon.addonId, quantity: addon.quantity, activatedAt: now.toISOString(), cancelsAt: null }));
      const state = addonState(addonId, input.planId, others, now, catalog);
      if (state.state === 'unavailable') {
        const message = `${catalog.addons[addonId].name}: ${state.reason}.`;
        throw apiError('addon_unavailable', message, { addons: message });
      }
    }

    const tenantId = randomUUID();
    const region = REGIONS[input.country];
    const trial = input.startAs === 'trial';
    const plan = catalog.plans[input.planId];
    log.info({ tenantId, country: input.country, planId: input.planId, trial, addons: ids.length }, 'Creating the owner’s account');

    // Supabase Auth is outside the transaction: create the account first, and remove it
    // again if the restaurant can't be saved, so no half-made owner is left behind.
    let ownerId;
    try {
      ownerId = await this.#authAdmin.inviteOwner({
        email: input.ownerEmail, name: input.ownerName, tenantId, redirectTo: this.#portalUrl,
      });
    } catch (error) {
      log.error({ tenantId, operation: error?.operation, authCode: error?.code, authStatus: error?.status, err: error }, 'Owner invite failed');
      throw emailRefused(error);
    }

    try {
      await this.#database.withTx(async (tx) => {
        await this.#repository.insertRestaurant(tx, {
          tenant: {
            id: tenantId, businessName: input.businessName, slug: await this.#repository.freeSlug(tx, TenantModel.slugify(input.businessName) || tenantId),
            city: input.city, ownerName: input.ownerName, ownerPhone: formatPhone(input.ownerPhone, input.country),
            ownerEmail: input.ownerEmail, country: input.country, currency: region.currency, timezone: region.timezone,
            taxProfile: region.taxProfile, partnerId, createdAt: now,
          },
          subscription: {
            planId: input.planId, status: trial ? 'trial' : 'active',
            trialEndsAt: trial ? new Date(now.getTime() + input.trialDays * DAY_MS) : null,
            currentPeriodEnd: new Date(now.getTime() + (trial ? input.trialDays : PERIOD_DAYS) * DAY_MS),
            // Paid from today, or from the end of the trial.
            billingStartsAt: trial ? null : now,
            setupFee: plan.setupFee,
          },
          addons: input.addons,
          branch: { name: 'Main branch', area: input.city },
          hours: defaultHours(),
          // Team names are up to 60 characters; owner names on the form up to 80.
          owner: { id: ownerId, name: input.ownerName.slice(0, 60).trim(), email: input.ownerEmail },
        });
        await this.#audit.record(tx, {
          tenantId, action: 'tenant_created', actor: actor.name,
          after: `${plan.name} ${trial ? `trial (${input.trialDays} days)` : '(paid)'}`, reason: input.reason,
        });
        for (const { addonId, quantity } of input.addons) {
          await this.#audit.record(tx, {
            tenantId, action: 'addon_added', actor: actor.name, after: `${catalog.addons[addonId].name} × ${quantity}`, reason: input.reason,
          });
        }
      }, { logger: log });
    } catch (error) {
      await this.#authAdmin.deleteUser(ownerId).catch((deleteError) => {
        log.error({ tenantId, err: deleteError }, 'Could not remove the owner’s account after a failed sign-up; remove it in Supabase');
      });
      if (isUniqueViolation(error, 'tenants_business_name_unique')) throw DUPLICATE_NAME();
      if (isUniqueViolation(error, 'tenants_owner_email_unique') || isUniqueViolation(error, 'team_members_email_unique')) throw EMAIL_TAKEN();
      throw error;
    }
    log.success({ tenantId, country: input.country }, 'Restaurant created and owner invited');
    return this.detail(tenantId, now);
  }

  // ---------------------------------------------------------------- Upkeep

  async update({ actor, log, now }, tenantId, body) {
    const input = parseOrThrow(TenantModel.update, body, INVALID_INPUT);
    let emailChanged = null;
    try {
      await this.#database.withTx(async (tx) => {
        const current = await this.#repository.lockForWrite(tx, tenantId);
        if (!current) throw apiError('tenant_not_found', 'This restaurant does not exist.');
        if (await this.#repository.nameTaken(input.businessName, tenantId, tx)) throw DUPLICATE_NAME();
        // The owner's mobile, in the restaurant's own country.
        if (!isMobile(input.ownerPhone, current.country)) {
          throw apiError('invalid_input', 'Some details need fixing.', { ownerPhone: `Enter a mobile number, e.g. ${REGIONS[current.country].phone.example}` });
        }
        const next = {
          businessName: input.businessName, city: input.city, ownerName: input.ownerName,
          ownerPhone: formatPhone(input.ownerPhone, current.country), ownerEmail: input.ownerEmail,
        };
        const was = {
          businessName: current.business_name, city: current.city, ownerName: current.owner_name,
          ownerPhone: current.owner_phone, ownerEmail: current.owner_email,
        };
        const labels = { businessName: 'Name', city: 'City', ownerName: 'Owner', ownerPhone: 'Phone', ownerEmail: 'Email' };
        const changed = Object.keys(next).filter((key) => was[key] !== next[key]);
        if (changed.length === 0) throw apiError('no_changes', 'Nothing has changed.');

        if (changed.includes('ownerEmail')) {
          if (await this.#repository.emailTaken(next.ownerEmail, current.owner_id, tx)) throw EMAIL_TAKEN();
        }
        await this.#repository.updateDetails(tx, tenantId, next);
        // Earlier audit entries keep the old name; this one and later ones use the new one.
        await this.#audit.record(tx, {
          tenantId, action: 'tenant_updated', actor: actor.name,
          before: changed.map((key) => `${labels[key]}: ${was[key]}`).join('; '),
          after: changed.map((key) => `${labels[key]}: ${next[key]}`).join('; '),
          reason: input.reason,
        });
        // Last, so a refusal from Supabase rolls the whole change back.
        if (changed.includes('ownerEmail') && current.owner_id) {
          try {
            await this.#authAdmin.changeEmail(current.owner_id, next.ownerEmail);
          } catch (error) {
            log.error({ tenantId, authCode: error?.code, authStatus: error?.status, err: error }, 'Owner email change refused');
            throw error?.name === 'AuthAdminError' ? emailRefused(error) : error;
          }
          emailChanged = { userId: current.owner_id, previous: current.owner_email };
        }
        log.info({ tenantId, fields: changed }, 'Restaurant details changing');
      }, { logger: log });
    } catch (error) {
      // The sign-in email already changed but the save didn't: put it back.
      if (emailChanged) await this.#authAdmin.changeEmail(emailChanged.userId, emailChanged.previous).catch(() => {});
      if (isUniqueViolation(error, 'tenants_business_name_unique')) throw DUPLICATE_NAME();
      if (isUniqueViolation(error)) throw EMAIL_TAKEN();
      throw error;
    }
    log.success({ tenantId }, 'Restaurant details updated');
    return this.detail(tenantId, now);
  }

  /** Ticks or unticks a checklist step. No audit event, as in core. */
  async setOnboardingStep({ log, now }, tenantId, body, entitlements) {
    const input = parseOrThrow(TenantModel.onboardingStep, body ?? {});
    const access = await entitlements.forTenant(tenantId, now);
    if (!access) throw apiError('tenant_not_found', 'This restaurant does not exist.');
    const steps = onboardingSteps(access.features, access.limits.tables ?? null);

    await this.#database.withTx(async (tx) => {
      const current = await this.#repository.lockForWrite(tx, tenantId);
      if (!current?.onboarding) throw apiError('no_onboarding', 'This restaurant has no onboarding checklist.');
      if (!steps.some((step) => step.id === input.stepId)) throw apiError('invalid_step', 'Unknown checklist step.');
      const done = new Set(current.onboarding.completed_steps ?? []);
      if (input.done) done.add(input.stepId);
      else done.delete(input.stepId);
      const complete = steps.every((step) => done.has(step.id));
      await this.#repository.setOnboarding(tx, tenantId, {
        completedSteps: [...done],
        completedAt: complete ? (current.onboarding.completed_at ?? now.toISOString()) : null,
      });
    }, { logger: log });
    log.success({ tenantId, stepId: input.stepId, done: input.done }, 'Checklist step saved');
    return this.detail(tenantId, now);
  }

}

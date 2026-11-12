import { EntitlementModel } from '../model/entitlement.model.js';
import { EventModel } from '../model/event.model.js';
import { PaymentModel } from '../model/payment.model.js';
import { isPartner, scopeOf, viewCountry } from '../shared/rules/admin-scope.js';
import { AUDIT_CHECKS, EVENT_GROUPS } from '../shared/rules/constants.js';
import { daysPastDue, isLive, nextPastDueStep, pastDueStep } from '../shared/rules/entitlements.js';
import { FEATURES, isFeatureKey } from '../shared/rules/features.js';
import { formatMoney } from '../shared/rules/format.js';
import { addonUnitPrice, LIMIT_KEYS, LIMIT_LABELS, PLAN_IDS } from '../shared/rules/plans.js';
import { REGIONS } from '../shared/rules/region.js';
import { amountDueFor, cheapestUnlock, isFirstBilledMonth, nextPlanForLimit } from '../shared/rules/subscriptions.js';
import { apiError } from '../shared/error-codes.js';
import { pageWindow, paginated } from '../shared/pagination.js';
import { monthKey, zonedToUtc } from '../shared/time.js';
import { isUuid } from '../shared/validation.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY = { high: 0, medium: 1, low: 2 };
/** No orders for this long, or diners entering under this share of lines, gets a look. */
const QUIET_DAYS = 3;
const LOW_DINER_SHARE = 0.5;
const TREND_MONTHS = 6;
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());
const daysUntil = (value, now) => Math.ceil((new Date(value).getTime() - now.getTime()) / DAY_MS);

/** Limits a restaurant has reached, with the cheapest way to give it more room. */
function limitsReached(entry, catalog, currency) {
  const plan = catalog.plans[entry.subscription.planId];
  return LIMIT_KEYS.flatMap((key) => {
    const value = entry.access.limits.find((limit) => limit.key === key)?.value ?? null;
    const used = entry.usage[key];
    if (value === null || used < value) return [];
    const unit = Object.values(catalog.addons).find((addon) => addon.unit.limit === key && addon.availableTo.includes(plan.id));
    const next = nextPlanForLimit(key, plan.id, catalog);
    const offer = [
      unit && `${unit.name.toLowerCase()} at ${formatMoney(addonUnitPrice(unit, plan), currency)} each`,
      next && `${catalog.plans[next].name} at ${formatMoney(catalog.plans[next].monthlyPrice, currency)}`,
    ].filter(Boolean).join(' or ');
    return [{ key, used, value, offer }];
  });
}

const dinerShare = (row) => (row.lines_today === 0 ? null : row.diner_lines_today / row.lines_today);

const toRun = (row, month) => ({
  month: row ? String(row.month instanceof Date ? row.month.toISOString() : row.month).slice(0, 7) : month,
  reviewed: row?.reviewed ?? [], notes: row?.notes ?? '', completedAt: iso(row?.completed_at), completedBy: row?.completed_by ?? null,
});

/**
 * The platform console's overview screens (guide 9.1, 9.7-9.9, core's dashboard, events,
 * requests and monthly-audit): the dashboard, the history log, owners' upgrade requests
 * and the monthly audit. All for the country on screen and the person's scope.
 */
export class ConsoleService {
  #database;
  #repository;
  #tenants;
  #catalogs;
  #entitlements;

  constructor({ database, repository, tenants, catalogs, entitlements }) {
    this.#database = database;
    this.#repository = repository;
    this.#tenants = tenants;
    this.#catalogs = catalogs;
    this.#entitlements = entitlements;
  }

  static #scope(actor) {
    const scope = scopeOf(actor);
    return { country: viewCountry(actor), partnerId: scope.role === 'partner' ? scope.partnerId : null };
  }

  // ---------------------------------------------------------------- Upgrade requests

  /** "Extra kitchen station add-on · PKR 1,500/mo": the cheapest way to say yes, priced now. */
  static #suggestion(row, catalog, currency) {
    const planId = row.plan_id;
    const perMonth = (price) => `${formatMoney(price, currency)}/mo`;
    if (row.feature_key) {
      const unlock = cheapestUnlock(row.feature_key, planId, catalog);
      if (!unlock) return null;
      return unlock.kind === 'addon'
        ? `${catalog.addons[unlock.addonId].name} add-on · ${perMonth(unlock.price)}`
        : `${catalog.plans[unlock.planId].name} plan · ${perMonth(unlock.price)}`;
    }
    const unit = Object.values(catalog.addons).find((addon) => addon.unit.limit === row.limit_key && addon.availableTo.includes(planId));
    if (unit) return `${unit.name} · ${formatMoney(addonUnitPrice(unit, catalog.plans[planId]), currency)}/mo each`;
    const next = nextPlanForLimit(row.limit_key, planId, catalog);
    return next ? `${catalog.plans[next].name} plan · ${perMonth(catalog.plans[next].monthlyPrice)}` : 'A limit override for this restaurant';
  }

  async #catalog(country) {
    const row = await this.#catalogs.load(country);
    return EntitlementModel.catalog(row.plans, row.addons);
  }

  async requests({ actor }, query = {}) {
    const scope = ConsoleService.#scope(actor);
    const status = query.status === 'handled' ? 'handled' : 'open';
    const tenantId = isUuid(query.tenantId) ? query.tenantId : null;
    const [rows, open, catalog] = await Promise.all([
      this.#repository.upgradeRequests(scope, { status, tenantId }),
      this.#repository.upgradeRequests(scope, { status: 'open' }),
      this.#catalog(scope.country),
    ]);
    const currency = REGIONS[scope.country].currency;
    return { items: rows.map((row) => ConsoleService.#request(row, catalog, currency)), openCount: open.length };
  }

  static #request(row, catalog, currency) {
    return {
      id: row.id, tenantId: row.tenant_id, tenantName: row.tenant_name, planId: row.plan_id,
      featureKey: row.feature_key, limitKey: row.limit_key,
      label: row.feature_key ? FEATURES[row.feature_key].label : `More ${LIMIT_LABELS[row.limit_key]}`,
      suggestion: ConsoleService.#suggestion(row, catalog, currency),
      requestedBy: row.requested_by, count: row.count, firstAt: iso(row.first_at), lastAt: iso(row.last_at),
      status: row.status, handledBy: row.handled_by, handledAt: iso(row.handled_at), note: row.note,
    };
  }

  /** Marked handled, with what was agreed, for the next person who looks. */
  async handleRequest(context, id, body = {}) {
    const { actor, log, now } = context;
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    await this.#database.withTx(async (tx) => {
      const row = isUuid(id) ? await this.#repository.findRequest(tx, ConsoleService.#scope(actor), id) : null;
      if (!row) throw apiError('not_found', 'That request could not be found.');
      if (row.status === 'handled') throw apiError('already_handled', `Already handled by ${row.handled_by}.`);
      if (note.length < 5) throw apiError('validation_failed', 'Say what was agreed.', { note: 'Say what was agreed, e.g. “Called, adding the station add-on from Monday”.' });
      await this.#repository.handleRequest(tx, id, { by: actor.name, note: note.slice(0, 500), now });
    }, { logger: log });
    log.success({ requestId: id }, 'Upgrade request handled');
    return this.requests(context, { status: 'open' });
  }

  /**
   * An owner's "Ask us to turn it on" or "Ask about more tables" (portal). A feature
   * request also counts as a locked-feature click for the monthly audit.
   */
  async ask({ actor, log, now }, access, body = {}) {
    let subject;
    if (body?.limitKey !== undefined) {
      if (!LIMIT_KEYS.includes(body.limitKey)) throw apiError('invalid_limit', 'Unknown limit.');
      subject = { limitKey: body.limitKey };
    } else {
      if (!isFeatureKey(body?.featureKey)) throw apiError('invalid_feature', 'Unknown feature.');
      if (access.features.has(body.featureKey)) throw apiError('already_enabled', `${FEATURES[body.featureKey].label} is already on.`);
      subject = { featureKey: body.featureKey };
    }
    await this.#database.withTx((tx) => this.#repository.askFor(tx, actor.tenantId, { ...subject, by: actor.name, now }), { logger: log });
    log.success({ tenantId: actor.tenantId, ...subject }, 'Upgrade request recorded');
    return { ok: true };
  }

  // ---------------------------------------------------------------- History log

  async events({ actor }, query = {}) {
    const scope = ConsoleService.#scope(actor);
    const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value.split('-').map(Number) : null);
    // Inclusive days in the country's own time zone.
    const timeZone = REGIONS[scope.country].timezone;
    const from = day(text(query.from));
    const to = day(text(query.to));
    const filter = {
      tenantId: isUuid(query.tenantId) ? query.tenantId : undefined,
      actor: text(query.actor),
      actions: EVENT_GROUPS[text(query.group)] ? [...EVENT_GROUPS[text(query.group)]] : undefined,
      from: from ? zonedToUtc({ year: from[0], month: from[1], day: from[2] }, 0, timeZone) : undefined,
      to: to ? zonedToUtc({ year: to[0], month: to[1], day: to[2] + 1 }, 0, timeZone) : undefined,
      search: text(query.search)?.slice(0, 100),
    };
    const size = Math.min(Math.max(1, Number(query.pageSize) || 25), 1000);
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    let result = await this.#repository.events(scope, { ...filter, limit: size, offset: (page - 1) * size });
    const window = pageWindow(result.total, { page, pageSize: size }, { defaultSize: 25, maxSize: 1000 });
    // A page past the end shows the last page.
    if (window.page !== page && result.total > 0) result = await this.#repository.events(scope, { ...filter, limit: size, offset: window.offset });
    return {
      ...paginated(result.rows.map(EventModel.toEvent), result.total, window),
      actors: result.actors,
      tenants: result.tenants.map((tenant) => ({ id: tenant.id, name: tenant.name })),
    };
  }

  // ---------------------------------------------------------------- Dashboard

  async dashboard({ actor, now }) {
    const scope = ConsoleService.#scope(actor);
    const { catalog, restaurants } = await this.#tenants.inView(actor, now);
    const timeZone = REGIONS[scope.country].timezone;
    const currency = REGIONS[scope.country].currency;
    const trendFrom = monthKey(now, timeZone, -(TREND_MONTHS - 1));
    const [payments, requests, recent] = await Promise.all([
      this.#repository.monthlyPayments(scope, trendFrom),
      this.requests({ actor }, { status: 'open' }),
      this.#repository.recentEvents(scope),
    ]);
    const mrr = restaurants.reduce((sum, entry) => sum + entry.monthlyValue, 0);
    // Past months: the fees actually received. This month: what restaurants should pay now.
    const mrrTrend = Array.from({ length: TREND_MONTHS }, (_, index) => {
      const month = monthKey(now, timeZone, index - (TREND_MONTHS - 1));
      return { month, mrr: index === TREND_MONTHS - 1 ? mrr : payments.find((row) => row.month === month)?.amount ?? 0 };
    });
    const previous = mrrTrend.at(-2).mrr;
    const ordersToday = restaurants.reduce((sum, entry) => sum + entry.row.orders_today, 0);
    const ordersYesterday = restaurants.reduce((sum, entry) => sum + entry.row.orders_yesterday, 0);
    const lines = restaurants.reduce((sum, entry) => sum + entry.row.lines_today, 0);
    const dinerLines = restaurants.reduce((sum, entry) => sum + entry.row.diner_lines_today, 0);
    const pastDue = restaurants.filter((entry) => entry.subscription.status === 'past_due');
    const summaries = restaurants.map((entry) => entry.summary);

    return {
      generatedAt: now.toISOString(),
      mrr,
      mrrChangePct: previous ? ((mrr - previous) / previous) * 100 : 0,
      activeTenants: summaries.filter((row) => row.status === 'active' || row.status === 'past_due').length,
      trialTenants: summaries.filter((row) => row.status === 'trial').length,
      pastDueTenants: pastDue.length,
      pastDueAmount: pastDue.reduce((sum, entry) => sum + entry.monthlyValue, 0),
      ordersToday,
      ordersChangePct: ordersYesterday ? ((ordersToday - ordersYesterday) / ordersYesterday) * 100 : 0,
      dinerOrderShare: lines ? dinerLines / lines : 0,
      mrrTrend,
      planMix: PLAN_IDS.map((planId) => {
        const onPlan = summaries.filter((row) => row.planId === planId && row.status !== 'cancelled');
        return { planId, tenants: onPlan.length, mrr: onPlan.reduce((sum, row) => sum + row.monthlyValue, 0) };
      }),
      attention: this.#attention(restaurants, catalog, currency, requests.items, now),
      recentTenants: [...summaries].sort((a, b) => (b.lastOrderAt ?? '').localeCompare(a.lastOrderAt ?? '')).slice(0, 6),
      recentEvents: recent.map(EventModel.toEvent),
    };
  }

  /** What needs someone today, most urgent first. */
  #attention(restaurants, catalog, currency, openRequests, now) {
    const items = [];
    for (const entry of restaurants) {
      const { row, subscription: sub } = entry;
      const base = { tenantId: row.id, tenantName: row.business_name };
      if (sub.status === 'past_due' && sub.pastDueSince) {
        const days = daysPastDue(sub, now);
        const step = pastDueStep(sub, now);
        const next = nextPastDueStep(sub, now);
        items.push({
          ...base, id: `att_pd_${row.id}`, kind: 'past_due', severity: days >= 30 ? 'high' : 'medium', at: sub.pastDueSince,
          message: `${days} days past due${step ? `: ${step.label.toLowerCase()}` : ''}.${next ? ` ${next.step.label} in ${next.inDays} day${next.inDays === 1 ? '' : 's'}.` : ''} Suspended at day 45, with open orders cancelled.`,
        });
      }
      if (sub.status === 'trial' && sub.trialEndsAt && daysUntil(sub.trialEndsAt, now) <= 7) {
        items.push({
          ...base, id: `att_tr_${row.id}`, kind: 'trial_ending', severity: 'medium', at: sub.trialEndsAt,
          message: `Trial ends in ${Math.max(0, daysUntil(sub.trialEndsAt, now))} days on ${catalog.plans[sub.planId].name}. Time for the conversion visit, with their own numbers.`,
        });
      }
      // Paying or on trial, but no orders for days: the counter may have stopped being used.
      const quietFor = row.last_order_at ? Math.floor((now.getTime() - new Date(row.last_order_at).getTime()) / DAY_MS) : null;
      if (['active', 'past_due', 'trial'].includes(sub.status) && quietFor !== null && quietFor >= QUIET_DAYS) {
        items.push({
          ...base, id: `att_q_${row.id}`, kind: 'quiet', severity: 'high', at: iso(row.last_order_at),
          message: `No orders for ${quietFor} days. Check the counter and printer are working, and that staff are using them.`,
        });
      }
      if (sub.status !== 'cancelled' && sub.status !== 'suspended') {
        for (const reached of limitsReached(entry, catalog, currency)) {
          items.push({
            ...base, id: `att_lim_${row.id}_${reached.key}`, kind: 'limit_reached', severity: 'low', at: now.toISOString(),
            message: `Using all ${reached.value} ${LIMIT_LABELS[reached.key]}.${reached.offer ? ` Offer ${reached.offer}.` : ''}`,
          });
        }
      }
      if ((sub.status === 'active' || sub.status === 'past_due') && sub.setupFee > 0 && !row.setup_paid) {
        items.push({
          ...base, id: `att_setup_${row.id}`, kind: 'setup_unpaid', severity: 'medium', at: iso(row.created_at),
          message: `Setup fee of ${formatMoney(sub.setupFee, currency)} not recorded. Collect it, or mark it received if it was.`,
        });
      }
      for (const override of entry.overrides) {
        if (override.expiresAt && isLive(override.expiresAt, now) && daysUntil(override.expiresAt, now) <= 30) {
          items.push({
            ...base, id: `att_ov_${override.id}`, kind: 'override_expiring', severity: 'low', at: override.expiresAt,
            message: `Free grant ends in ${daysUntil(override.expiresAt, now)} days: “${override.reason}”. Convert to a paid add-on or let it lapse.`,
          });
        }
      }
    }
    // A restaurant asking to pay more should hear back the same day.
    for (const request of openRequests) {
      items.push({
        id: `att_req_${request.id}`, tenantId: request.tenantId, tenantName: request.tenantName, kind: 'upgrade_request', severity: 'medium', at: request.lastAt,
        message: `${request.requestedBy} asked for ${request.label.toLowerCase()}${request.count > 1 ? ` (${request.count} times)` : ''}.${request.suggestion ? ` Offer: ${request.suggestion}.` : ''}`,
      });
    }
    return items.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.at.localeCompare(b.at));
  }

  // ---------------------------------------------------------------- Monthly audit

  async audit({ actor, now }) {
    const scope = ConsoleService.#scope(actor);
    const timeZone = REGIONS[scope.country].timezone;
    const month = monthKey(now, timeZone);
    const { catalog, restaurants } = await this.#tenants.inView(actor, now);
    const currency = REGIONS[scope.country].currency;
    const [payments, clicks, run, previousRun] = await Promise.all([
      this.#repository.paymentsForMonth(scope, month),
      this.#repository.lockedClicks(scope),
      this.#repository.auditRun(scope.country, month),
      this.#repository.previousRun(scope.country, month),
    ]);
    const live = restaurants.filter((entry) => !['cancelled', 'suspended'].includes(entry.subscription.status));

    // 1. Billing: everyone who should pay this cycle, unpaid first.
    const billing = restaurants
      .filter((entry) => ['active', 'past_due'].includes(entry.subscription.status))
      .map(({ row, subscription: sub, monthlyValue }) => {
        const payment = payments.find((entry) => entry.tenant_id === row.id);
        return {
          tenantId: row.id, tenantName: row.business_name, planId: sub.planId, status: sub.status,
          amountDue: amountDueFor(month, monthlyValue, sub.billingStartsAt, row.timezone),
          proRated: isFirstBilledMonth(month, sub.billingStartsAt, row.timezone),
          payment: payment ? PaymentModel.toPayment(payment) : null,
          setupOutstanding: row.setup_paid || sub.setupFee === 0 ? null : sub.setupFee,
        };
      })
      .sort((a, b) => Number(Boolean(a.payment)) - Number(Boolean(b.payment)) || a.tenantName.localeCompare(b.tenantName));

    // 2. Limits reached: the conversation about extra units or the next plan.
    const limits = live
      .flatMap((entry) => limitsReached(entry, catalog, currency).map((reached) => ({
        tenantId: entry.row.id, tenantName: entry.row.business_name, planId: entry.subscription.planId,
        limit: reached.key, used: reached.used, value: reached.value,
      })))
      .sort((a, b) => a.tenantName.localeCompare(b.tenantName));

    // 4. Grants ending within 30 days.
    const overrides = restaurants
      .flatMap((entry) => entry.overrides
        .filter((override) => override.expiresAt && isLive(override.expiresAt, now) && daysUntil(override.expiresAt, now) <= 30)
        .map((override) => ({ override, tenantName: entry.row.business_name, daysLeft: daysUntil(override.expiresAt, now) })))
      .sort((a, b) => a.daysLeft - b.daysLeft);

    // 5. Activity: quiet restaurants, and ones where diners don't scan.
    const activity = live
      .flatMap(({ row }) => {
        const quietFor = row.last_order_at ? Math.floor((now.getTime() - new Date(row.last_order_at).getTime()) / DAY_MS) : null;
        const share = dinerShare(row);
        const issue = quietFor === null ? 'No orders yet. Check the counter is installed and the cards are on the tables.'
          : quietFor >= QUIET_DAYS ? `No orders for ${quietFor} days. Check the counter and printer are in use.`
            : share !== null && share < LOW_DINER_SHARE ? `Diners entered ${Math.round(share * 100)}% of lines today. Staff may be taking orders by hand: check the table cards are out.`
              : null;
        return issue ? [{ tenantId: row.id, tenantName: row.business_name, lastOrderAt: iso(row.last_order_at), ordersLast7Days: row.orders_week, dinerShare: share, issue }] : [];
      })
      .sort((a, b) => (a.lastOrderAt ?? '').localeCompare(b.lastOrderAt ?? ''));

    // 6. Data problems: paid access without an active subscription.
    const orphans = restaurants
      .filter((entry) => ['suspended', 'cancelled'].includes(entry.subscription.status))
      .flatMap(({ row, subscription: sub, addons, overrides: grants }) => {
        const issues = [];
        const active = addons.filter((addon) => addon.cancelsAt === null).length;
        const granted = grants.filter((override) => override.featureKey && override.granted && isLive(override.expiresAt, now)).length;
        if (active) issues.push(`${active} active add-on${active > 1 ? 's' : ''} while ${sub.status}`);
        if (granted) issues.push(`${granted} live feature grant${granted > 1 ? 's' : ''} while ${sub.status}`);
        return issues.map((issue) => ({ tenantId: row.id, tenantName: row.business_name, issue }));
      });

    return {
      month,
      generatedAt: now.toISOString(),
      billing,
      limits,
      // 3. Clicks on locked features: what owners want but don't have.
      locked: clicks.map((row) => ({ tenantId: row.tenant_id, tenantName: row.tenant_name, planId: row.plan_id, featureKey: row.feature_key, clicks: row.clicks })),
      overrides,
      activity,
      orphans,
      run: toRun(run, month),
      previousRun: previousRun ? toRun(previousRun) : null,
    };
  }

  /** One change at a time, so quick clicks can arrive in any order. Partners can look, not sign. */
  async updateAudit(context, month, body = {}) {
    const { actor, log, now } = context;
    if (isPartner(actor)) throw apiError('forbidden', 'Only our own team ticks and signs off the monthly audit.');
    const { country } = ConsoleService.#scope(actor);
    if (month !== monthKey(now, REGIONS[country].timezone)) throw apiError('closed_month', 'Only this month’s audit can be changed.');
    await this.#database.withTx(async (tx) => {
      const run = await this.#repository.lockRun(tx, country, month);
      if (run.completed_at) throw apiError('audit_completed', 'This audit is already signed off.');
      const reviewed = new Set(run.reviewed);
      if (body?.action === 'review') {
        if (!AUDIT_CHECKS.includes(body.check)) throw apiError('invalid_check', 'Unknown check.');
        if (body.reviewed === false) reviewed.delete(body.check);
        else reviewed.add(body.check);
        await this.#repository.saveRun(tx, country, month, { reviewed: AUDIT_CHECKS.filter((check) => reviewed.has(check)), notes: run.notes, completedAt: null, completedBy: null });
      } else if (body?.action === 'sign_off') {
        if (reviewed.size !== AUDIT_CHECKS.length) throw apiError('incomplete', `Review all ${AUDIT_CHECKS.length} checks before signing off.`);
        const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : '';
        await this.#repository.saveRun(tx, country, month, { reviewed: [...AUDIT_CHECKS], notes, completedAt: now, completedBy: actor.name });
      } else {
        throw apiError('invalid_action', 'Unknown change.');
      }
    }, { logger: log });
    log.success({ country, month, action: body?.action }, 'Monthly audit saved');
    return this.audit(context);
  }
}

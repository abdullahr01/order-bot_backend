import { EntitlementModel } from '../model/entitlement.model.js';
import { canEditPrices, isPartner, viewCountry } from '../shared/rules/admin-scope.js';
import { FEATURE_KEYS, FEATURES, isFeatureKey } from '../shared/rules/features.js';
import { formatMoney } from '../shared/rules/format.js';
import { ADDON_IDS, addonPriceRule, addonUnitPrice, LIMIT_KEYS, LIMIT_LABELS, PLAN_IDS, validatePlan } from '../shared/rules/plans.js';
import { REGIONS } from '../shared/rules/region.js';
import { apiError } from '../shared/error-codes.js';
import { requireReason } from '../shared/validation.js';

const capitalised = (key) => LIMIT_LABELS[key].charAt(0).toUpperCase() + LIMIT_LABELS[key].slice(1);
const limitText = (value) => (value === null ? 'unlimited' : value.toLocaleString('en-US'));

function emptyUsage() {
  return {
    plans: Object.fromEntries(PLAN_IDS.map((id) => [id, { tenants: 0, paying: 0, mrr: 0 }])),
    addons: Object.fromEntries(ADDON_IDS.map((id) => [id, { tenants: 0, mrr: 0 }])),
  };
}

/**
 * The price lists (guide 9.6, core's catalog). Pakistan's prices: the founder and the team.
 * The UK's: the founder only. Partners can look but never change, and don't see the totals.
 */
export class CatalogService {
  #database;
  #repository;
  #audit;

  constructor({ database, repository, audit }) {
    this.#database = database;
    this.#repository = repository;
    this.#audit = audit;
  }

  async get({ actor, now }) {
    const country = viewCountry(actor);
    const row = await this.#repository.load(country);
    const catalog = EntitlementModel.catalog(row.plans, row.addons);
    return {
      country,
      currency: REGIONS[country].currency,
      catalog,
      usage: isPartner(actor) ? emptyUsage() : await this.#usage(country, catalog, now),
      pricesConfirmed: row.prices_confirmed,
      canEdit: canEditPrices(actor, country),
    };
  }

  async #usage(country, catalog, now) {
    const usage = emptyUsage();
    for (const row of await this.#repository.usageRows(country, now)) {
      const plan = catalog.plans[row.plan_id];
      const paying = row.status === 'active' || row.status === 'past_due';
      usage.plans[row.plan_id].tenants += 1;
      if (paying) {
        usage.plans[row.plan_id].paying += 1;
        usage.plans[row.plan_id].mrr += plan.monthlyPrice;
      }
      for (const addon of row.addons) {
        usage.addons[addon.addon_id].tenants += 1;
        if (paying) usage.addons[addon.addon_id].mrr += addonUnitPrice(catalog.addons[addon.addon_id], plan) * addon.quantity;
      }
    }
    return usage;
  }

  #editable(actor) {
    const country = viewCountry(actor);
    if (!canEditPrices(actor, country)) {
      throw apiError('forbidden', country === 'GB' ? 'Only the founder can change the UK prices.' : 'You can’t change the price list.');
    }
    return country;
  }

  /** Price, setup fee, description, features and limits. Setup fees already agreed don't change. */
  async updatePlan(context, planId, body = {}) {
    const { actor, log } = context;
    const reason = requireReason(body.reason);
    const country = this.#editable(actor);
    if (!PLAN_IDS.includes(planId)) throw apiError('plan_not_found', 'This plan does not exist.');
    const tagline = typeof body.tagline === 'string' ? body.tagline.trim() : '';
    if (tagline.length < 3 || tagline.length > 120) {
      throw apiError('invalid_tagline', 'The description should be 3 to 120 characters.', { tagline: 'Keep it between 3 and 120 characters.' });
    }
    const features = FEATURE_KEYS.filter((key) => Array.isArray(body.features) && body.features.some((entry) => isFeatureKey(entry) && entry === key));
    const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [key, body.limits?.[key] === null ? null : Number(body.limits?.[key])]));

    await this.#database.withTx(async (tx) => {
      const row = await this.#repository.lock(tx, country);
      const catalog = EntitlementModel.catalog(row.plans, row.addons);
      const current = catalog.plans[planId];
      const next = { ...current, monthlyPrice: Number(body.monthlyPrice), setupFee: Number(body.setupFee), tagline, features, limits };
      const problems = validatePlan(next, catalog);
      if (problems.length) throw apiError('invalid_plan', problems.join(' '));

      // Exactly what changed, for the history log.
      const money = (value) => formatMoney(value, REGIONS[country].currency);
      const before = [];
      const after = [];
      if (next.monthlyPrice !== current.monthlyPrice) { before.push(`${money(current.monthlyPrice)}/mo`); after.push(`${money(next.monthlyPrice)}/mo`); }
      if (next.setupFee !== current.setupFee) { before.push(`setup ${money(current.setupFee)}`); after.push(`setup ${money(next.setupFee)}`); }
      if (next.tagline !== current.tagline) { before.push('old description'); after.push('new description'); }
      const added = next.features.filter((key) => !current.features.includes(key));
      const removed = current.features.filter((key) => !next.features.includes(key));
      if (added.length) after.push(`adds ${added.map((key) => FEATURES[key].label).join(', ')}`);
      if (removed.length) after.push(`removes ${removed.map((key) => FEATURES[key].label).join(', ')}`);
      for (const key of LIMIT_KEYS) {
        if (next.limits[key] !== current.limits[key]) {
          before.push(`${capitalised(key)} ${limitText(current.limits[key])}`);
          after.push(`${capitalised(key)} ${limitText(next.limits[key])}`);
        }
      }
      if (after.length === 0) throw apiError('no_changes', 'Nothing has changed.');

      await this.#repository.updatePlan(tx, country, planId, next);
      if (next.monthlyPrice !== current.monthlyPrice || next.setupFee !== current.setupFee) await this.#repository.confirmPrices(tx, country);
      await this.#audit.record(tx, {
        tenantName: `${current.name} plan`, action: 'catalog_plan_updated', actor: actor.name,
        before: before.join('; ') || null, after: after.join('; '), reason, country,
      });
    }, { logger: log });
    log.success({ country, planId }, 'Plan updated');
    return this.get(context);
  }

  /** An add-on keeps its kind of price: a fixed amount, or a share of the plan. */
  async updateAddon(context, addonId, body = {}) {
    const { actor, log } = context;
    const reason = requireReason(body.reason);
    const country = this.#editable(actor);
    if (!ADDON_IDS.includes(addonId)) throw apiError('addon_not_found', 'This add-on does not exist.');

    await this.#database.withTx(async (tx) => {
      const row = await this.#repository.lock(tx, country);
      const catalog = EntitlementModel.catalog(row.plans, row.addons);
      const current = catalog.addons[addonId];
      const byShare = current.planShare !== null;
      const value = Number(byShare ? body.planShare : body.monthlyPrice);
      if (byShare && (!Number.isInteger(value) || value < 1 || value > 100)) throw apiError('invalid_price', 'Enter a percentage from 1 to 100.', { planShare: 'Enter a percentage from 1 to 100.' });
      if (!byShare && (!Number.isInteger(value) || value <= 0 || value > 10_000_000)) throw apiError('invalid_price', 'Enter a whole number above zero.', { monthlyPrice: 'Enter a whole number above zero.' });
      const availableTo = PLAN_IDS.filter((id) => Array.isArray(body.availableTo) && body.availableTo.includes(id));
      if (availableTo.length === 0) throw apiError('no_plans', 'Offer the add-on on at least one plan.', { availableTo: 'Choose at least one plan.' });

      const next = { ...current, monthlyPrice: byShare ? null : value, planShare: byShare ? value : null, availableTo };
      const currency = REGIONS[country].currency;
      const names = (ids) => ids.map((id) => catalog.plans[id].name).join(', ');
      const before = [];
      const after = [];
      if (addonPriceRule(next, currency) !== addonPriceRule(current, currency)) { before.push(addonPriceRule(current, currency)); after.push(addonPriceRule(next, currency)); }
      if (names(next.availableTo) !== names(current.availableTo)) { before.push(`for ${names(current.availableTo)}`); after.push(`for ${names(next.availableTo)}`); }
      if (after.length === 0) throw apiError('no_changes', 'Nothing has changed.');

      await this.#repository.updateAddon(tx, country, addonId, next);
      await this.#audit.record(tx, {
        tenantName: `${current.name} add-on`, action: 'catalog_addon_updated', actor: actor.name,
        before: before.join('; '), after: after.join('; '), reason, country,
      });
    }, { logger: log });
    log.success({ country, addonId }, 'Add-on price updated');
    return this.get(context);
  }
}

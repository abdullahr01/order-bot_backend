import { isUniqueViolation } from '../db/database.js';
import { isFounder, isPartner, scopeOf } from '../shared/rules/admin-scope.js';
import { REGIONS } from '../shared/rules/region.js';
import { apiError } from '../shared/error-codes.js';
import { monthKey } from '../shared/time.js';
import { isUuid, requireReason } from '../shared/validation.js';

const NOT_FOUND = () => apiError('not_found', 'That partner could not be found.');
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());
const shareText = (partner) => `Share ${partner.sharePercent ?? 'not agreed'}${partner.sharePercent === null ? '' : '%'}, due day ${partner.paymentDay ?? 'not agreed'}`;

const toPartner = (row) => ({
  id: row.id, name: row.name, countries: row.countries, contactName: row.contact_name, contactEmail: row.contact_email,
  sharePercent: row.share_percent === null ? null : Number(row.share_percent), paymentDay: row.payment_day, createdAt: iso(row.created_at),
});

/** "2026-11" → the due date in the month after, on the agreed day. */
function dueOn(month, day) {
  if (day === null) return null;
  const [year, number] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, number, 1));
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/**
 * Partners (core's partners handlers): companies that sign up and look after restaurants
 * in a country, collect their fees there and pay us our share each month. A partner sees
 * only themselves; only the founder changes the share or records their payments.
 */
export class PartnerService {
  #database;
  #repository;
  #audit;

  constructor({ database, repository, audit }) {
    this.#database = database;
    this.#repository = repository;
    this.#audit = audit;
  }

  async #partner(actor, id, sql) {
    if (!isUuid(id) || (isPartner(actor) && scopeOf(actor).partnerId !== id)) throw NOT_FOUND();
    const row = await this.#repository.find(id, sql);
    if (!row) throw NOT_FOUND();
    return toPartner(row);
  }

  async list({ actor }) {
    const rows = await this.#repository.list(isPartner(actor) ? scopeOf(actor).partnerId : null);
    return rows.map(toPartner);
  }

  /** Every month from their first restaurant to now, newest first. */
  async #statements(partner, now, sql) {
    const data = await this.#repository.statementData(partner.id, sql);
    if (data.tenants.length === 0) return [];
    const country = partner.countries[0] ?? 'GB';
    const { currency, timezone } = REGIONS[country];
    const first = monthKey(new Date(data.tenants[0].created_at), timezone);
    const months = [];
    for (let offset = 0; offset > -240; offset -= 1) {
      const month = monthKey(now, timezone, offset);
      months.push(month);
      if (month <= first) break;
    }
    return months.map((month) => {
      const lines = data.tenants
        .map((tenant) => ({ tenantId: tenant.id, tenantName: tenant.business_name, amount: data.fees.filter((fee) => fee.tenant_id === tenant.id && fee.month === month).reduce((sum, fee) => sum + fee.amount, 0) }))
        .filter((line) => line.amount > 0);
      const feesCollected = lines.reduce((sum, line) => sum + line.amount, 0);
      const settled = data.settlements.find((entry) => entry.month === month);
      return {
        partnerId: partner.id, month, currency, restaurants: lines.length, feesCollected,
        shareDue: partner.sharePercent === null ? null : Math.round((feesCollected * partner.sharePercent) / 100),
        dueOn: dueOn(month, partner.paymentDay),
        received: settled ? { amount: settled.amount, at: iso(settled.received_at), by: settled.recorded_by, reference: settled.reference } : null,
        lines,
      };
    });
  }

  async detail({ actor, now }, id, sql) {
    const partner = await this.#partner(actor, id, sql);
    const statements = await this.#statements(partner, now, sql);
    // Only finished months are owed; this month is still being collected.
    const thisMonth = monthKey(now, REGIONS[partner.countries[0] ?? 'GB'].timezone);
    const outstanding = statements
      .filter((statement) => statement.month < thisMonth && statement.shareDue !== null && !statement.received)
      .reduce((sum, statement) => sum + statement.shareDue, 0);
    return { partner, statements, outstanding, canEdit: isFounder(actor) };
  }

  static #founderOnly(actor) {
    if (!isFounder(actor)) throw apiError('forbidden', 'Only the founder can change a partner’s share or record their payments.');
  }

  /** The share and payment day, once agreed. */
  async update(context, id, body = {}) {
    const { actor, log } = context;
    PartnerService.#founderOnly(actor);
    const current = await this.#partner(actor, id);
    const reason = requireReason(body?.reason);
    const share = body.sharePercent === null ? null : Number(body.sharePercent);
    const day = body.paymentDay === null ? null : Number(body.paymentDay);
    const fields = {};
    if (share !== null && (!Number.isFinite(share) || share <= 0 || share > 100)) fields.sharePercent = 'A percentage above 0, up to 100.';
    if (day !== null && (!Number.isInteger(day) || day < 1 || day > 28)) fields.paymentDay = 'A day from 1 to 28.';
    if (Object.keys(fields).length) throw apiError('validation_failed', 'Check the highlighted fields.', fields);
    const next = { ...current, sharePercent: share === null ? null : Math.round(share * 100) / 100, paymentDay: day };
    await this.#database.withTx(async (tx) => {
      await this.#repository.lock(tx, id);
      await this.#repository.update(tx, id, next);
      await this.#audit.record(tx, {
        tenantName: current.name, action: 'partner_updated', actor: actor.name, before: shareText(current), after: shareText(next),
        reason, country: current.countries[0],
      });
    }, { logger: log });
    log.success({ partnerId: id }, 'Partner terms saved');
    return this.detail(context, id);
  }

  /** The partner paid our share for a finished month. */
  async recordPayment(context, id, month, body = {}) {
    const { actor, log, now } = context;
    PartnerService.#founderOnly(actor);
    const partner = await this.#partner(actor, id);
    const statement = /^\d{4}-\d{2}$/.test(month ?? '') ? (await this.#statements(partner, now)).find((entry) => entry.month === month) : null;
    if (!statement) throw apiError('not_found', 'No statement for that month.');
    if (month >= monthKey(now, REGIONS[partner.countries[0] ?? 'GB'].timezone)) {
      throw apiError('month_open', 'This month is still being collected. Record it once the month is over.');
    }
    if (statement.received) throw apiError('already_paid', 'This month is already marked received.');
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
      throw apiError('validation_failed', 'Check the highlighted fields.', { amount: 'Enter the amount received.' });
    }
    const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 60) : '';
    try {
      await this.#database.withTx(async (tx) => {
        await this.#repository.recordSettlement(tx, { partnerId: id, month, amount: Math.round(amount * 100) / 100, reference, recordedBy: actor.name, now });
        await this.#audit.record(tx, {
          tenantName: partner.name, action: 'partner_payment_recorded', actor: actor.name, after: `${month}: ${amount}`,
          reason: reference || null, country: partner.countries[0],
        });
      }, { logger: log });
    } catch (error) {
      if (isUniqueViolation(error, 'partner_settlements_pkey')) throw apiError('already_paid', 'This month is already marked received.');
      throw error;
    }
    log.success({ partnerId: id, month }, 'Partner payment recorded');
    return this.detail(context, id);
  }
}

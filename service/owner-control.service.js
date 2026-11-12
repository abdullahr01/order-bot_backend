import { BranchModel } from '../model/branch.model.js';
import { OrderModel } from '../model/order.model.js';
import { ORDER_RANGES, TABLE_PAYMENTS } from '../shared/rules/constants.js';
import { TABLE_CLOSED_PREFIX } from '../shared/rules/dine-in.js';
import { isLive, listPrice } from '../shared/rules/entitlements.js';
import { formatMoney } from '../shared/rules/format.js';
import { onboardingSteps } from '../shared/rules/onboarding.js';
import { lineName } from '../shared/rules/orders.js';
import { addonUnitPrice } from '../shared/rules/plans.js';
import { change } from '../shared/rules/reports.js';
import { apiError } from '../shared/error-codes.js';
import { dayKey, daysInMonth, localDay, localParts, monthKey, startOfLocalDay } from '../shared/time.js';
import { isUuid } from '../shared/validation.js';

const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30 };
/** Steps the owner does themselves; the platform team does the rest (core). */
const OWNER_SETUP_STEPS = ['menu', 'tables', 'time_menus', 'go_live'];
const SUMMARY_DAYS = 7;
const REPORT_MONTHS = 6;
const BILLING_MONTHS = 6;
const CLOSES_SHOWN = 14;
const ONLINE_MS = 5 * 60_000;
const MAX_COUNTED = 100_000_000;
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());
const pad = (value) => String(value).padStart(2, '0');
const dateKey = ({ year, month, day }) => `${year}-${pad(month)}-${pad(day)}`;
const average = (revenue, orders) => (orders ? Math.round(revenue / orders) : 0);
const itemsText = (items) => items.map((item) => `${item.quantity}× ${lineName(item)}`).join(', ');
const toClose = (row) => ({
  id: row.id, branchId: row.branch_id, day: String(row.day instanceof Date ? row.day.toISOString() : row.day).slice(0, 10),
  expectedCash: row.expected_cash, countedCash: row.counted_cash, difference: row.difference, note: row.note,
  closedBy: row.closed_by, closedAt: iso(row.closed_at),
});

/** "2026-11" → its first and last day, and every day in between. */
function monthDays(month) {
  const days = daysInMonth(month);
  return Array.from({ length: days }, (_, index) => `${month}-${pad(index + 1)}`);
}

/**
 * The owner's figures (guide 8.1 and 8.9, core's portal, owner-control, portal-account and
 * portal-reports): today's dashboard, billing, the void log, the cash close, the daily
 * summary, branches side by side and the monthly report. Every day is the restaurant's own.
 */
export class OwnerControlService {
  #database;
  #repository;

  constructor({ database, repository }) {
    this.#database = database;
    this.#repository = repository;
  }

  /** A branch the owner asked for, if it is one of theirs; null means every branch. */
  async #branch(tenantId, requested) {
    const branches = await this.#repository.branches(tenantId);
    return { branches, branchId: isUuid(requested) && branches.some((branch) => branch.id === requested) ? requested : null };
  }

  // ---------------------------------------------------------------- Dashboard

  async dashboard({ actor, now }, access, query = {}) {
    const timeZone = access.tenant.timezone;
    const today = dayKey(now, timeZone);
    const yesterday = dateKey(localDay(now, timeZone, -1));
    const [{ branchId }, tenant] = await Promise.all([this.#branch(actor.tenantId, query.branch), this.#repository.tenant(actor.tenantId)]);
    const data = await this.#repository.today(actor.tenantId, branchId, { today, yesterday, timeZone });
    const { figures } = data;
    const has = (key) => access.features.has(key);
    // Paid for, even if paused by an overdue payment: never pitched as an upgrade.
    const owns = (key) => has(key) || access.paused.includes(key);

    // Orders per hour, from the first order (or 11 am) to now.
    const firstHour = Math.min(11, ...data.hours.map((row) => row.hour));
    const hourNow = localParts(now, timeZone).hour;
    const ordersByHour = Array.from({ length: Math.max(1, hourNow - firstHour + 1) }, (_, index) => ({
      hour: firstHour + index, orders: data.hours.find((row) => row.hour === firstHour + index)?.orders ?? 0,
    }));

    const upgradeSignals = [];
    if (!owns('station_routing') && figures.lines >= 40) {
      upgradeSignals.push({
        featureKey: 'station_routing', headline: `${figures.lines} dishes went to one kitchen printer today`,
        detail: 'Station routing prints BBQ, drinks and kitchen slips at their own stations, so nobody sorts paper at the pass.',
      });
    }
    if (!owns('time_menus')) {
      upgradeSignals.push({
        featureKey: 'time_menus', headline: 'Breakfast, hi-tea and iftar menus can switch on by themselves',
        detail: 'Time-based menus show diners the right dishes at the right hour. Set up sehri and iftar before Ramadan.',
      });
    }
    const onboarding = tenant.onboarding;
    const setup = onboarding && !onboarding.completed_at
      ? {
        steps: onboardingSteps(access.features, access.limits.tables ?? null)
          .filter((step) => OWNER_SETUP_STEPS.includes(step.id))
          .map((step) => ({ id: step.id, done: (onboarding.completed_steps ?? []).includes(step.id) })),
      }
      : null;

    return {
      generatedAt: now.toISOString(),
      today: {
        orders: figures.orders, ordersYesterday: figures.orders_yesterday, revenue: figures.revenue, revenueYesterday: figures.revenue_yesterday,
        averageOrderValue: average(figures.revenue, figures.orders), waiting: figures.waiting, inProgress: figures.in_progress,
      },
      activeOrders: data.active.map(OrderModel.toOrder),
      ordersByHour,
      topItems: data.top,
      usage: [
        { key: 'tables', used: data.usage.tables, limit: access.limits.tables ?? null, period: 'total' },
        { key: 'staff_accounts', used: data.usage.staff_accounts, limit: access.limits.staff_accounts ?? null, period: 'total' },
      ],
      upgradeSignals,
      dineIn: has('qr_ordering') ? { tables: data.dineIn.tables, seated: data.dineIn.seated, billRequested: data.dineIn.bill_requested } : null,
      setup,
    };
  }

  // ---------------------------------------------------------------- Billing

  /** What the restaurant pays and what has been received (Settings). */
  async billing({ actor, now }, access) {
    const { subscription, catalog, tenant } = access;
    const plan = catalog.plans[subscription.planId];
    const live = access.addons.filter((addon) => isLive(addon.cancelsAt, now));
    const payments = await this.#repository.monthlyPayments(actor.tenantId);
    // Nothing is billed during a trial; after that, every month since billing started.
    const months = [];
    if (subscription.billingStartsAt && subscription.status !== 'trial' && subscription.status !== 'cancelled') {
      const first = monthKey(new Date(subscription.billingStartsAt), tenant.timezone);
      for (let offset = 0; offset > -BILLING_MONTHS; offset -= 1) {
        const month = monthKey(now, tenant.timezone, offset);
        if (month < first) break;
        const paid = payments.find((row) => row.month === month);
        months.push({ month, payment: paid ? { amount: paid.amount, method: paid.method, recordedAt: iso(paid.recorded_at) } : null });
      }
    }
    return {
      plan: { id: plan.id, name: plan.name, monthlyPrice: plan.monthlyPrice },
      addons: live.map((addon) => {
        const def = catalog.addons[addon.addonId];
        return { id: addon.addonId, name: def.name, quantity: addon.quantity, monthlyPrice: addonUnitPrice(def, plan) * addon.quantity, cancelsAt: addon.cancelsAt };
      }),
      monthlyTotal: listPrice(subscription, live, now, catalog),
      subscription: {
        status: subscription.status, trialEndsAt: subscription.trialEndsAt, currentPeriodEnd: subscription.currentPeriodEnd,
        pastDueSince: subscription.pastDueSince,
        scheduledPlanName: subscription.scheduledPlanId ? catalog.plans[subscription.scheduledPlanId].name : null,
      },
      months,
    };
  }

  // ---------------------------------------------------------------- Void log

  /** Every cancelled order and every table closed without payment, with who did it. Read-only. */
  async voidLog({ actor, now }, access, query = {}) {
    const range = ORDER_RANGES.includes(query.range) ? query.range : 'today';
    const { branchId } = await this.#branch(actor.tenantId, query.branch);
    const since = startOfLocalDay(now, access.tenant.timezone, -(RANGE_DAYS[range] - 1));
    const { orders, tables } = await this.#repository.voids(actor.tenantId, branchId, since, TABLE_CLOSED_PREFIX);
    // Orders cancelled by closing their table count once, under the table.
    const entries = [
      ...orders.map((order) => ({
        id: order.id, kind: 'order_cancelled', at: iso(order.finished_at), branchId: order.branch_id, table: order.table_number,
        orderNumber: order.number, amount: order.total, items: itemsText(order.items), reason: order.cancel_reason ?? '',
        by: order.cancelled_by, source: order.source,
      })),
      ...tables.map((session) => ({
        id: session.id, kind: 'table_force_closed', at: iso(session.closed_at), branchId: session.branch_id, table: session.table_number,
        orderNumber: null, amount: session.amount, items: session.items.map(itemsText).join(', '), reason: session.close_reason ?? '',
        by: session.closed_by, source: null,
      })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    const people = new Map();
    for (const entry of entries) {
      const name = entry.by ?? 'Not recorded';
      const person = people.get(name) ?? { count: 0, amount: 0 };
      people.set(name, { count: person.count + 1, amount: person.amount + entry.amount });
    }
    return {
      entries,
      totals: { count: entries.length, amount: entries.reduce((sum, entry) => sum + entry.amount, 0) },
      byPerson: [...people.entries()].map(([name, figures]) => ({ name, ...figures })).sort((a, b) => b.count - a.count || b.amount - a.amount),
      range,
      generatedAt: now.toISOString(),
    };
  }

  // ---------------------------------------------------------------- Cash close

  async #closeBranch(tenantId, requested) {
    const branches = await this.#repository.branches(tenantId);
    const branch = branches.find((entry) => entry.id === requested) ?? branches.find((entry) => entry.is_main);
    if (!branch) throw apiError('not_found', 'Branch not found.');
    return branch;
  }

  static #byMethod(rows) {
    return Object.fromEntries(TABLE_PAYMENTS.map((method) => {
      const row = rows.find((entry) => entry.paid_by === method);
      return [method, { count: row?.count ?? 0, amount: row?.amount ?? 0 }];
    }));
  }

  /** Today's takings at one branch, the cash that should be in the drawer, and the closing count. */
  async cashClose({ actor, now }, access, query = {}, sql) {
    const timeZone = access.tenant.timezone;
    const branch = await this.#closeBranch(actor.tenantId, query.branch);
    const day = dayKey(now, timeZone);
    const [paymentRows, openTables, closes] = await Promise.all([
      this.#repository.payments(actor.tenantId, branch.id, day, timeZone, sql),
      this.#repository.openTables(actor.tenantId, branch.id),
      this.#repository.closes(actor.tenantId, branch.id, sql),
    ]);
    const payments = OwnerControlService.#byMethod(paymentRows);
    const records = closes.map(toClose);
    return {
      day, branch: BranchModel.toBranch(branch), payments, expectedCash: payments.cash.amount, openTables,
      record: records.find((record) => record.day === day) ?? null,
      history: records.filter((record) => record.day !== day).slice(0, CLOSES_SHOWN),
      generatedAt: now.toISOString(),
    };
  }

  /** The cash counted at closing. A different amount needs a note; a recount replaces the count. */
  async saveCashClose(context, access, body = {}) {
    const { actor, log, now } = context;
    const branches = await this.#repository.branches(actor.tenantId);
    if (!branches.some((branch) => branch.id === body?.branchId)) {
      throw apiError('validation_failed', 'Check the highlighted fields.', { branchId: 'Choose one of your branches.' });
    }
    const counted = Number(body.countedCash);
    if (!Number.isInteger(counted) || counted < 0 || counted > MAX_COUNTED) {
      throw apiError('validation_failed', 'Check the highlighted fields.', { countedCash: 'Enter the cash counted, as a whole number.' });
    }
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, OrderModel.NOTE_MAX) : null;
    const timeZone = access.tenant.timezone;
    const day = dayKey(now, timeZone);
    await this.#database.withTx(async (tx) => {
      const expected = OwnerControlService.#byMethod(await this.#repository.payments(actor.tenantId, body.branchId, day, timeZone, tx)).cash.amount;
      if (counted !== expected && !note) {
        throw apiError('validation_failed', 'Check the highlighted fields.', { note: 'The count doesn’t match. Say why, for the record.' });
      }
      await this.#repository.saveClose(tx, actor.tenantId, { branchId: body.branchId, day, expectedCash: expected, countedCash: counted, note, closedBy: actor.name, now });
    }, { logger: log });
    log.success({ tenantId: actor.tenantId, branchId: body.branchId, day }, 'Cash close saved');
    return this.cashClose(context, access, { branch: body.branchId });
  }

  // ---------------------------------------------------------------- Daily summary

  /** The day in one message: today or up to 6 days back. */
  async dailySummary({ actor, now }, access, query = {}) {
    const timeZone = access.tenant.timezone;
    const currency = access.tenant.currency;
    const money = (amount) => formatMoney(amount, currency);
    const today = dayKey(now, timeZone);
    const allowed = Array.from({ length: SUMMARY_DAYS }, (_, index) => dateKey(localDay(now, timeZone, -index)));
    const day = allowed.includes(query.day) ? query.day : today;
    const [{ branches, branchId }, tenant] = await Promise.all([this.#branch(actor.tenantId, query.branch), this.#repository.tenant(actor.tenantId)]);
    const branch = branchId ? branches.find((entry) => entry.id === branchId) : null;
    const [year, month, date] = day.split('-').map(Number);
    const weekBefore = dateKey(localDay(new Date(Date.UTC(year, month - 1, date, 12)), 'UTC', -7));
    // Today is still going: compare with last week up to the same time, not its whole day.
    const local = localParts(now, timeZone);
    const data = await this.#repository.day(actor.tenantId, branchId, {
      day, weekBefore, upToMinute: day === today ? local.hour * 60 + local.minute : null, timeZone,
    });
    const { figures } = data;
    const payments = OwnerControlService.#byMethod(data.payments);
    const voids = { count: figures.cancelled + data.forced, amount: figures.cancelled_amount };
    const cashClose = data.closes.map((close) => ({ branchName: close.branch_name, difference: close.difference, closedBy: close.closed_by }));
    const busiest = data.hours.reduce((best, row) => (row.orders > (best?.orders ?? 0) ? { hour: row.hour, orders: row.orders } : best), null);
    const top = data.top.map(({ name, quantity }) => ({ name, quantity }));

    const noon = new Date(Date.UTC(year, month - 1, date, 12));
    const label = noon.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const vsLastWeek = change(figures.revenue, data.lastWeek.revenue);
    const lines = [
      `*${tenant.business_name}${branch ? ` · ${branch.name}` : ''}* · ${label}`,
      `Sales ${money(figures.revenue)} · ${figures.orders} orders · average ${money(average(figures.revenue, figures.orders))}`,
      vsLastWeek === null ? null : `${vsLastWeek >= 0 ? 'Up' : 'Down'} ${Math.abs(Math.round(vsLastWeek * 100))}% on last ${noon.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}`,
      `Cash ${money(payments.cash.amount)} · Card ${money(payments.card.amount)} · Wallet ${money(payments.wallet.amount)}`,
      `Voids: ${voids.count}${voids.amount ? ` (${money(voids.amount)})` : ''}`,
      ...(cashClose.length
        ? cashClose.map((close) => `Cash count${branch ? '' : ` ${close.branchName}`}: ${close.difference === 0 ? 'exact' : `${money(Math.abs(close.difference))} ${close.difference < 0 ? 'short' : 'over'}`} (${close.closedBy})`)
        : ['Cash count: not done yet']),
      top.length ? `Top: ${top.slice(0, 3).map((item) => `${item.name} ×${item.quantity}`).join(', ')}` : null,
    ].filter((line) => line !== null);

    return {
      day,
      branch: branch ? BranchModel.toBranch(branch) : null,
      sales: figures.revenue,
      orders: figures.orders,
      averageOrder: average(figures.revenue, figures.orders),
      lastWeek: { sales: data.lastWeek.revenue, orders: data.lastWeek.orders },
      payments,
      voids,
      cashClose,
      topItems: top,
      busiestHour: busiest,
      shareText: lines.join('\n'),
      generatedAt: now.toISOString(),
    };
  }

  // ---------------------------------------------------------------- Branches today

  async branchesOverview({ actor, now }, access) {
    const rows = await this.#repository.branchesToday(actor.tenantId, {
      today: dayKey(now, access.tenant.timezone), timeZone: access.tenant.timezone, onlineSince: new Date(now.getTime() - ONLINE_MS), now,
    });
    return {
      branches: rows.map((row) => ({
        branch: BranchModel.toBranch(row.branch), sales: row.sales, orders: row.orders, waiting: row.waiting, seatedTables: row.seated,
        tables: row.tables, voids: row.voids, expectedCash: row.expected_cash, cashDifference: row.cash_difference, staff: row.staff,
        counters: { total: row.counters, online: row.online }, pausedUntil: iso(row.paused_until),
      })),
      generatedAt: now.toISOString(),
    };
  }

  // ---------------------------------------------------------------- Reports

  /** One month's figures, compared with the month before. Locked from day 30 of non-payment. */
  async report({ actor, now }, access, query = {}) {
    if (!access.features.has('reports_basic')) throw apiError('feature_locked', 'Reports aren’t available on this account right now.');
    const timeZone = access.tenant.timezone;
    const [{ branches, branchId }, tenant] = await Promise.all([this.#branch(actor.tenantId, query.branch), this.#repository.tenant(actor.tenantId)]);
    const joinedDay = dayKey(new Date(tenant.created_at), timeZone);
    const joinedMonth = joinedDay.slice(0, 7);
    const months = Array.from({ length: REPORT_MONTHS }, (_, index) => monthKey(now, timeZone, -index)).filter((month) => month >= joinedMonth);
    const month = months.includes(query.month) ? query.month : months[0];
    const today = dayKey(now, timeZone);
    const partial = month === today.slice(0, 7);

    // Days of the month the restaurant was with us, up to today.
    const days = monthDays(month).filter((date) => date >= joinedDay && date <= today);
    const from = days[0];
    const to = days.at(-1);
    // This month so far is compared with the same days of last month.
    const previousMonth = monthKey(new Date(`${month}-15T12:00:00Z`), 'UTC', -1);
    const cut = partial ? Number(today.slice(8, 10)) : 31;
    const previousDays = monthDays(previousMonth).filter((date) => date >= joinedDay && Number(date.slice(8, 10)) <= cut);
    const trendMonths = months.filter((entry) => entry <= month).slice(0, REPORT_MONTHS).reverse();

    const [data, previous, trend] = await Promise.all([
      this.#repository.report(actor.tenantId, branchId, { from, to, timeZone }),
      previousDays.length ? this.#repository.totals(actor.tenantId, branchId, { from: previousDays[0], to: previousDays.at(-1) }) : { orders: 0, revenue: 0, cancelled: 0 },
      this.#repository.monthly(actor.tenantId, branchId, { from: `${trendMonths[0]}-01`, to }),
    ]);
    const summary = (row) => ({ orders: row.orders, revenue: row.revenue, averageOrder: average(row.revenue, row.orders), cancelled: row.cancelled });
    const hours = data.hours.map((row) => row.hour);
    return {
      month,
      months,
      partial,
      branch: branchId,
      since: iso(tenant.created_at),
      summary: summary(data.totals),
      previous: summary(previous),
      daily: days.map((date) => ({ date, orders: data.daily.find((row) => row.date === date)?.orders ?? 0, revenue: data.daily.find((row) => row.date === date)?.revenue ?? 0 })),
      trend: trendMonths.map((entry) => ({ month: entry, orders: trend.find((row) => row.month === entry)?.orders ?? 0, revenue: trend.find((row) => row.month === entry)?.revenue ?? 0 })),
      weekdays: Array.from({ length: 7 }, (_, day) => ({ day, orders: data.weekdays.find((row) => row.day === day)?.orders ?? 0 })),
      hours: hours.length
        ? Array.from({ length: Math.max(...hours) - Math.min(...hours) + 1 }, (_, index) => {
          const hour = Math.min(...hours) + index;
          return { hour, orders: data.hours.find((row) => row.hour === hour)?.orders ?? 0 };
        })
        : [],
      topItems: data.top,
      sources: ['qr', 'staff'].map((source) => data.sources.find((row) => row.source === source)).filter(Boolean).map((row) => ({ source: row.source, orders: row.orders, revenue: row.revenue })),
      branches: branches.length > 1 && branchId === null
        ? branches.map((branch) => {
          const row = data.branches.find((entry) => entry.branch_id === branch.id);
          return { id: branch.id, name: branch.name, orders: row?.orders ?? 0, revenue: row?.revenue ?? 0 };
        })
        : [],
    };
  }
}

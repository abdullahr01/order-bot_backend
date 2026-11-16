import { EntitlementModel } from '../model/entitlement.model.js';
import { daysPastDue, monthlyValue } from '../shared/rules/entitlements.js';
import { addonsEndingOnPlan, amountDueFor } from '../shared/rules/subscriptions.js';
import { dayKey, zonedToUtc } from '../shared/time.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = 30;
const PHOTO_GRACE_MS = DAY_MS;
const SYSTEM = 'System';

/** Automatic runs act at 9 am in each restaurant's own time zone. */
export const RUN_HOUR = 9;

/** The unpaid ladder (user's rules, 2026-11-09 and 2026-11-14): emails on 7, 30 and 43; day 45 suspends. */
export const LADDER_STEPS = [7, 30, 43, 45];
export const SUSPEND_DAY = 45;

const monthLabel = (month) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** The owner's email for each ladder step. Plain text, no amounts (the console has those). */
export function unpaidEmail(step, { businessName, ownerName }) {
  const hello = `Hello ${ownerName},`;
  const sign = 'QR Dine-in';
  const paid = 'If you have already paid, please ignore this email.';
  const texts = {
    7: {
      subject: `Payment reminder: ${businessName}`,
      body: [`Your QR Dine-in payment for ${businessName} is 7 days overdue.`,
        'Please pay soon to keep everything running.', paid],
    },
    30: {
      subject: `Payment overdue: ${businessName} setup is locked`,
      body: [`Your QR Dine-in payment for ${businessName} is 30 days overdue.`,
        'Until it is paid, you can\'t change your menu, tables or team. Your counter and diners can still order.', paid],
    },
    43: {
      subject: `Service stops in 2 days: ${businessName}`,
      body: [`Your QR Dine-in payment for ${businessName} is 43 days overdue.`,
        'If it isn\'t paid within 2 days, your service will be suspended: diners won\'t be able to order, and open orders will be cancelled.', paid],
    },
    45: {
      subject: `Service suspended: ${businessName}`,
      body: [`Your QR Dine-in payment for ${businessName} is 45 days overdue, so your service has been suspended.`,
        'Diners can\'t order, and open orders were cancelled. Please contact us to pay and restore your service.'],
    },
  }[step];
  return { subject: texts.subject, text: [hello, '', ...texts.body, '', sign].join('\n') };
}

/**
 * The daily jobs (guide 12.1, as agreed 2026-11-14). Each job is safe to run twice: the
 * notebook (`job_runs`) and conditional writes make a repeat do nothing. One failing job
 * never stops the others. `dryRun` reports what would happen and changes nothing.
 */
export class JobService {
  #database;
  #repository;
  #tenants;
  #subscriptions;
  #entitlements;
  #audit;
  #mailer;
  #photoStorage;
  #live;

  constructor({ database, repository, tenants, subscriptions, entitlements, audit, mailer = null, photoStorage = null, live = null }) {
    this.#database = database;
    this.#repository = repository;
    this.#tenants = tenants;
    this.#subscriptions = subscriptions;
    this.#entitlements = entitlements;
    this.#audit = audit;
    this.#mailer = mailer;
    this.#photoStorage = photoStorage;
    this.#live = live;
  }

  async runDaily({ now = new Date(), dryRun = false, fromHour = RUN_HOUR, log }) {
    const jobLog = log.child({ module: 'Jobs' });
    jobLog.info({ operation: 'runDaily', dryRun, fromHour }, 'Daily jobs starting');
    const report = {};
    for (const [name, job] of [
      ['billingMonth', () => this.#billingMonth({ now, dryRun, fromHour, log: jobLog.child({ operation: 'billingMonth' }) })],
      ['unpaid', () => this.#unpaid({ now, dryRun, fromHour, log: jobLog.child({ operation: 'unpaid' }) })],
      ['billingPeriods', () => this.#billingPeriods({ now, dryRun, log: jobLog.child({ operation: 'billingPeriods' }) })],
      ['cleanUp', () => this.#cleanUp({ now, dryRun, log: jobLog.child({ operation: 'cleanUp' }) })],
    ]) {
      try {
        report[name] = await job();
      } catch (error) {
        jobLog.error({ operation: name, err: error }, 'Daily job failed; the next run tries again');
        report[name] = { failed: true };
      }
    }
    jobLog.success({ operation: 'runDaily', dryRun }, 'Daily jobs finished');
    return report;
  }

  // ---------------------------------------------------------------- 1st of the month

  /** Active restaurants that didn't pay last month become past due from the 1st. */
  async #billingMonth({ now, dryRun, fromHour, log }) {
    const results = [];
    for (const row of await this.#repository.billingMonthCandidates(now, fromHour)) {
      const key = `${row.id}:${row.this_month}`;
      const input = EntitlementModel.fromRow(await this.#entitlements.loadForTenant(row.id));
      const [year, month] = row.this_month.split('-').map(Number);
      const since = zonedToUtc({ year, month, day: 1 }, 0, row.timezone);
      // Last month's price: what was live on its last moment.
      const value = monthlyValue(input.subscription, input.addons, new Date(since.getTime() - 1), input.catalog);
      const due = amountDueFor(row.last_month, value, input.subscription.billingStartsAt, row.timezone);
      if (dryRun) {
        results.push({ tenantId: row.id, month: row.last_month, due, action: due > 0 ? 'past_due' : 'nothing_due' });
        continue;
      }
      let changed = false;
      await this.#database.withTx(async (tx) => {
        if (!await this.#repository.claim(tx, 'billing_month', key, row.id)) return;
        if (due <= 0) return;
        const current = await this.#tenants.lockForWrite(tx, row.id);
        if (!current || current.status !== 'active') return;
        if (await this.#repository.monthlyPaid(tx, row.id, row.last_month)) return;
        await this.#repository.markPastDue(tx, row.id, since);
        await this.#audit.record(tx, {
          tenantId: row.id, action: 'status_changed', actor: SYSTEM, before: 'Active', after: 'Past due',
          reason: `No payment received for ${monthLabel(row.last_month)}`,
        });
        changed = true;
      }, { logger: log });
      if (changed) {
        log.success({ tenantId: row.id, month: row.last_month }, 'Restaurant marked past due');
        this.#live?.tenantChanged(row.id);
      }
      results.push({ tenantId: row.id, month: row.last_month, due, action: changed ? 'past_due' : 'nothing_due' });
    }
    return results;
  }

  // ---------------------------------------------------------------- Unpaid ladder

  async #unpaid({ now, dryRun, fromHour, log }) {
    const results = [];
    for (const row of await this.#repository.pastDue(now, fromHour)) {
      const days = daysPastDue({ status: 'past_due', pastDueSince: new Date(row.past_due_since).toISOString() }, now);
      const step = [...LADDER_STEPS].reverse().find((day) => days >= day);
      if (!step) continue;
      // One unpaid period per past-due date; a later, new period starts its own ladder.
      const key = `${row.id}:${dayKey(new Date(row.past_due_since), row.timezone)}:${step}`;
      if (await this.#repository.isDone('unpaid_ladder', key)) continue;
      if (dryRun) {
        results.push({ tenantId: row.id, days, step, action: step === SUSPEND_DAY ? 'suspend_and_email' : 'email' });
        continue;
      }
      results.push(step === SUSPEND_DAY
        ? await this.#suspend({ row, key, days, now, log })
        : await this.#remind({ row, key, days, step, log }));
    }
    return results;
  }

  /** Day 7, 30, 43: written down first, given back if the email fails, so it is tried again. */
  async #remind({ row, key, days, step, log }) {
    if (!this.#mailer) {
      log.info({ tenantId: row.id, step }, 'Unpaid email skipped: email is not set up');
      return { tenantId: row.id, days, step, action: 'email_skipped' };
    }
    let claimed = false;
    await this.#database.withTx(async (tx) => { claimed = await this.#repository.claim(tx, 'unpaid_ladder', key, row.id); }, { logger: log });
    if (!claimed) return { tenantId: row.id, days, step, action: 'already_done' };
    const sent = await this.#send(row, step, log);
    if (!sent) await this.#repository.release('unpaid_ladder', key);
    return { tenantId: row.id, days, step, action: sent ? 'emailed' : 'email_failed' };
  }

  /** Day 45: the same stop as a manual suspension (open orders cancelled, tables closed by System). */
  async #suspend({ row, key, days, now, log }) {
    let stopped = null;
    await this.#database.withTx(async (tx) => {
      const current = await this.#tenants.lockForWrite(tx, row.id);
      if (!current || current.status !== 'past_due' || !current.past_due_since) return;
      const confirmedDays = daysPastDue({ status: 'past_due', pastDueSince: new Date(current.past_due_since).toISOString() }, now);
      if (confirmedDays < SUSPEND_DAY) return;
      if (!await this.#repository.claim(tx, 'unpaid_ladder', key, row.id)) return;
      await this.#subscriptions.setStatus(tx, row.id, 'suspended', now);
      stopped = await this.#subscriptions.stopService(tx, row.id, { reason: 'Account suspended: payment 45 days overdue', now });
      await this.#audit.record(tx, {
        tenantId: row.id, action: 'status_changed', actor: SYSTEM, before: 'Past due', after: 'Suspended', reason: 'Payment 45 days overdue',
      });
    }, { logger: log });
    if (!stopped) return { tenantId: row.id, days, step: SUSPEND_DAY, action: 'already_done' };
    log.success({ tenantId: row.id, cancelledOrders: stopped.orders, closedTables: stopped.tables }, 'Restaurant suspended after 45 days unpaid');
    this.#live?.tenantChanged(row.id);
    // One try: the suspension stands either way, and the owner sees it on screen.
    const sent = this.#mailer ? await this.#send(row, SUSPEND_DAY, log) : false;
    if (!this.#mailer) log.info({ tenantId: row.id, step: SUSPEND_DAY }, 'Unpaid email skipped: email is not set up');
    return { tenantId: row.id, days, step: SUSPEND_DAY, action: 'suspended', emailed: sent, ...stopped };
  }

  async #send(row, step, log) {
    if (!row.owner_email) {
      log.info({ tenantId: row.id, step }, 'Unpaid email skipped: the restaurant has no owner email');
      return false;
    }
    const { subject, text } = unpaidEmail(step, { businessName: row.business_name, ownerName: row.owner_name });
    try {
      await this.#mailer.send({ to: row.owner_email, subject, text });
      log.success({ tenantId: row.id, step }, 'Unpaid email sent');
      return true;
    } catch (error) {
      log.error({ tenantId: row.id, step, err: error }, 'Unpaid email failed; the next run tries again');
      return false;
    }
  }

  // ---------------------------------------------------------------- Billing period

  /** At the period end: a waiting downgrade starts, then the next 30-day period begins. */
  async #billingPeriods({ now, dryRun, log }) {
    const results = [];
    for (const row of await this.#repository.periodsEnded(now)) {
      if (dryRun) {
        results.push({ tenantId: row.id, periodEnd: new Date(row.current_period_end).toISOString(), action: 'move_period' });
        continue;
      }
      let result = null;
      await this.#database.withTx(async (tx) => {
        const current = await this.#tenants.lockForWrite(tx, row.id);
        if (!current || !['active', 'past_due'].includes(current.status) || !current.current_period_end) return;
        const end = new Date(current.current_period_end);
        if (end > now) return;
        let planChanged = null;
        if (current.scheduled_plan_id) {
          const rows = await this.#tenants.catalogRows(current.country, tx);
          const catalog = EntitlementModel.catalog(rows.catalog_plans, rows.catalog_addons);
          const live = (await this.#subscriptions.liveAddons(tx, row.id, now)).map((addon) => ({
            addonId: addon.addon_id, quantity: addon.quantity, cancelsAt: addon.cancels_at ? new Date(addon.cancels_at).toISOString() : null,
          }));
          const ending = addonsEndingOnPlan(live, current.scheduled_plan_id, catalog).map((addon) => addon.addonId);
          await this.#subscriptions.applyPlan(tx, row.id, current.scheduled_plan_id, ending, now);
          await this.#audit.record(tx, {
            tenantId: row.id, action: 'plan_changed', actor: SYSTEM,
            before: catalog.plans[current.plan_id].name, after: catalog.plans[current.scheduled_plan_id].name,
            reason: 'Scheduled change at the end of the billing period',
          });
          planChanged = current.scheduled_plan_id;
        }
        const periods = Math.floor((now.getTime() - end.getTime()) / (PERIOD_DAYS * DAY_MS)) + 1;
        const next = new Date(end.getTime() + periods * PERIOD_DAYS * DAY_MS);
        if (!await this.#repository.movePeriod(tx, row.id, end, next)) return;
        result = { tenantId: row.id, periodEnd: next.toISOString(), planChanged };
      }, { logger: log });
      if (!result) continue;
      log.success({ tenantId: row.id, planChanged: result.planChanged }, 'Billing period moved on');
      if (result.planChanged) this.#live?.tenantChanged(row.id);
      results.push({ ...result, action: 'moved' });
    }
    return results;
  }

  // ---------------------------------------------------------------- Clean-ups

  async #cleanUp({ now, dryRun, log }) {
    const rows = await this.#repository.cleanUp(now, { dryRun });
    let photos = { checked: 0, unused: 0 };
    try {
      photos = await this.#photos({ now, dryRun });
    } catch (error) {
      log.error({ err: error }, 'Photo clean-up failed; the next run tries again');
      photos = { failed: true };
    }
    log.success({ ...rows, photos, dryRun }, dryRun ? 'Clean-up counted' : 'Clean-up done');
    return { ...rows, photos };
  }

  /** Photos no dish uses, uploaded more than a day ago (a dish may still be being made). */
  async #photos({ now, dryRun }) {
    const storage = this.#photoStorage;
    if (!storage?.folders) return { checked: 0, unused: 0 };
    let checked = 0;
    let unused = 0;
    // Only restaurant folders (named by the restaurant's id); anything else is left alone.
    const folders = (await storage.folders()).filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name));
    for (const folder of folders) {
      const old = (await storage.files(folder)).filter((file) => now.getTime() - file.createdAt.getTime() > PHOTO_GRACE_MS);
      checked += old.length;
      if (!old.length) continue;
      const used = await this.#repository.photoUrls(folder);
      const remove = old.filter((file) => !used.has(file.url));
      unused += remove.length;
      if (!dryRun && remove.length) await storage.remove(remove.map((file) => file.path));
    }
    return { checked, unused };
  }
}

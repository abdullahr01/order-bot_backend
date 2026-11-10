import { BranchModel } from '../model/branch.model.js';
import { ServiceSettingsModel } from '../model/service-settings.model.js';
import { defaultHours } from '../shared/rules/service.js';
import { apiError } from '../shared/error-codes.js';
import { parseOrThrow } from '../shared/validation.js';

/** Longest pause a branch can set itself; anything longer is a closure, the owner's call. */
const MAX_BRANCH_PAUSE_MS = 12 * 60 * 60 * 1000;
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

/**
 * Opening hours and pauses (guide 8.7, core's portal-service and portal-team). A pause
 * stops diner orders only; staff still enter orders at the counter.
 */
export class ServiceSettingsService {
  #database;
  #repository;

  constructor({ database, repository }) {
    this.#database = database;
    this.#repository = repository;
  }

  async settings(tenantId, sql) {
    const row = await this.#repository.settings(tenantId, sql);
    return { hours: row?.hours ?? defaultHours(), pausedUntil: iso(row?.paused_until) };
  }

  /** One part at a time: the hours card sends `hours`, the pause button `pausedUntil`. */
  async update({ actor, log, now }, body = {}) {
    const changes = parseOrThrow(ServiceSettingsModel.settings.partial(), body ?? {});
    if (changes.pausedUntil !== undefined && changes.pausedUntil !== null) {
      const until = Date.parse(changes.pausedUntil);
      if (Number.isNaN(until) || until <= now.getTime()) {
        throw apiError('validation_failed', 'Check the highlighted fields.', { pausedUntil: 'Choose a time later than now, or resume.' });
      }
    }
    await this.#database.withTx(async (tx) => {
      const current = await this.settings(actor.tenantId, tx);
      await this.#repository.save(tx, actor.tenantId, {
        hours: changes.hours ?? current.hours,
        pausedUntil: changes.pausedUntil === undefined ? current.pausedUntil : changes.pausedUntil && new Date(changes.pausedUntil),
      });
    }, { logger: log });
    log.success({ tenantId: actor.tenantId, hours: Boolean(changes.hours), pause: changes.pausedUntil === undefined ? 'unchanged' : changes.pausedUntil ? 'paused' : 'resumed' }, 'Service settings saved');
    return this.settings(actor.tenantId);
  }

  /** The branch today. Staff and counters: their own branch; owners: the main branch. */
  async today({ actor }, sql) {
    const row = await this.#repository.today(actor.tenantId, actor.branchId ?? null, sql);
    if (!row) throw apiError('not_found', 'Branch not found.');
    return {
      branch: BranchModel.toBranch(row.branch),
      hours: row.hours ?? defaultHours(),
      restaurantPausedUntil: iso(row.restaurant_paused_until),
      branchPausedUntil: iso(row.branch_paused_until),
      waiting: row.waiting,
      inProgress: row.in_progress,
      completed: row.completed,
      cancelled: row.cancelled,
    };
  }

  /** Pauses QR orders at this branch during a rush (up to 12 hours), or resumes. */
  async pauseBranch(context, body = {}) {
    const { actor, log, now } = context;
    const value = body?.pausedUntil;
    let pausedUntil = null;
    if (value !== null) {
      const until = typeof value === 'string' ? Date.parse(value) : Number.NaN;
      if (Number.isNaN(until) || until <= now.getTime() || until - now.getTime() > MAX_BRANCH_PAUSE_MS) {
        throw apiError('validation_failed', 'Pause for up to 12 hours.', { pausedUntil: 'Pause for up to 12 hours.' });
      }
      pausedUntil = new Date(until);
    }
    const { branch } = await this.today(context);
    await this.#database.withTx((tx) => this.#repository.pauseBranch(tx, actor.tenantId, branch.id, pausedUntil), { logger: log });
    log.success({ tenantId: actor.tenantId, branchId: branch.id, paused: pausedUntil !== null }, 'Branch pause saved');
    return this.today(context);
  }
}

import { BranchModel } from '../model/branch.model.js';
import { COUNTER_PIN_LENGTH, PAIRING_CODE_MINUTES } from '../shared/rules/constants.js';
import { hashToken, newPairingCode, randomToken, verifyPin } from '../shared/crypto.js';
import { apiError } from '../shared/error-codes.js';
import { isUuid } from '../shared/validation.js';
import { NO_LIVE } from './live.service.js';

const MINUTE = 60_000;
/** Wrong PINs in a row before that person is held off (guide 3.2, §13). */
const MAX_PIN_TRIES = 5;
const PIN_HOLD_MINUTES = 5;
const DEVICE_NAME = { min: 2, max: 40 };
const fieldError = (fields) => apiError('validation_failed', 'Check the highlighted fields.', fields);
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

const toDevice = (row) => ({
  id: row.id, tenantId: row.tenant_id, branchId: row.branch_id, name: row.name,
  pairedAt: iso(row.paired_at), pairedBy: row.paired_by, lastSeenAt: iso(row.last_seen_at),
});

/**
 * Counter PCs (guide 7.2 and 8.8, core's counter handlers). The owner pairs a PC once with
 * a code; after that nobody signs in on it, staff unlock it with their PIN, so every
 * payment, void and table close records who did it.
 */
export class CounterService {
  #database;
  #repository;
  #branches;

  #live;

  constructor({ database, repository, branches, live = NO_LIVE }) {
    this.#live = live;
    this.#database = database;
    this.#repository = repository;
    this.#branches = branches;
  }

  // ---------------------------------------------------------------- Portal (owner)

  async list({ actor, now }, sql) {
    const row = await this.#repository.list(actor.tenantId, now, sql);
    return {
      devices: row.devices.map(toDevice),
      pairingCodes: row.codes.map((code) => ({ code: code.code, branchId: code.branch_id, expiresAt: iso(code.expires_at) })),
    };
  }

  /** 6 random digits, valid for 15 minutes, used once. */
  async createPairingCode(context, body = {}) {
    const { actor, log, now } = context;
    const branchId = body?.branchId;
    const branches = await this.#branches.visibleBranches(actor.tenantId, null);
    if (!branches.some((branch) => branch.id === branchId)) throw fieldError({ branchId: 'Choose one of your branches.' });
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_MINUTES * MINUTE);
    await this.#database.withTx(async (tx) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const made = await this.#repository.insertCode(tx, { code: newPairingCode(), tenantId: actor.tenantId, branchId, expiresAt, createdBy: actor.name, now });
        if (made) return;
      }
      throw new Error('No free pairing code after 20 tries');
    }, { logger: log });
    log.success({ tenantId: actor.tenantId, branchId }, 'Pairing code made');
    return this.list(context);
  }

  /** Unpairs a lost or replaced PC. Its next request gets 401 device_revoked. */
  async revoke(context, id) {
    const { actor, log } = context;
    const removed = isUuid(id) && await this.#database.withTx((tx) => this.#repository.remove(tx, actor.tenantId, id), { logger: log });
    if (!removed) throw apiError('not_found', 'That counter could not be found.');
    log.success({ tenantId: actor.tenantId, deviceId: id }, 'Counter unpaired');
    this.#live.deviceRemoved({ tenantId: actor.tenantId, deviceId: id });
    return this.list(context);
  }

  // ---------------------------------------------------------------- On the counter

  async session(actor) {
    const row = await this.#repository.session(actor.tenantId, actor.deviceId);
    if (!row) throw apiError('device_revoked', 'This counter is no longer paired. Ask the owner for a new pairing code.');
    return {
      device: toDevice(row),
      restaurant: { id: row.tenant_id, businessName: row.business_name },
      branch: BranchModel.toBranch(row.branch),
      // Staff first, then the owner; by name.
      people: row.people,
    };
  }

  /** Typed in once on the new PC. The token is shown once; only its hash is kept. */
  async pair({ log, now }, body = {}) {
    const code = String(body?.code ?? '').replace(/\D/g, '');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < DEVICE_NAME.min || name.length > DEVICE_NAME.max) {
      throw fieldError({ name: 'Give this counter a short name, such as “Front counter”.' });
    }
    const wrongCode = () => fieldError({ code: 'That code is wrong or has expired. Ask the owner for a new one.' });
    if (code.length !== 6) throw wrongCode();

    const deviceToken = randomToken();
    const paired = await this.#database.withTx(async (tx) => {
      const found = await this.#repository.findCode(tx, code, now);
      if (!found || found.branch_retired) throw wrongCode();
      if (found.status === 'suspended' || found.status === 'cancelled') {
        throw apiError('account_paused', 'This restaurant’s account is paused. Call us to switch it back on.');
      }
      const deviceId = await this.#repository.pair(tx, {
        code, tenantId: found.tenant_id, branchId: found.branch_id, name, tokenHash: hashToken(deviceToken), pairedBy: found.created_by, now,
      });
      return { tenantId: found.tenant_id, branchId: found.branch_id, deviceId };
    }, { logger: log });
    log.success({ tenantId: paired.tenantId, branchId: paired.branchId, deviceId: paired.deviceId }, 'Counter paired');
    return { deviceToken, session: await this.session(paired) };
  }

  /** Someone enters their PIN. 5 wrong in a row holds them off for 5 minutes. */
  async unlock({ actor, log, now }, body = {}) {
    const userId = body?.userId;
    const pin = typeof body?.pin === 'string' ? body.pin : '';
    const notHere = () => apiError('not_found', 'That person can’t unlock this counter.');
    if (!isUuid(userId)) throw notHere();
    if (!new RegExp(`^\\d{${COUNTER_PIN_LENGTH}}$`).test(pin)) throw fieldError({ pin: `Enter your ${COUNTER_PIN_LENGTH}-digit PIN.` });

    const staffToken = randomToken();
    const outcome = await this.#database.withTx(async (tx) => {
      const person = await this.#repository.unlockable(tx, { tenantId: actor.tenantId, branchId: actor.branchId, userId });
      if (!person) throw notHere();
      if (person.held_until && new Date(person.held_until) > now) {
        throw apiError('pin_held', `Too many wrong PINs. Try again in ${PIN_HOLD_MINUTES} minutes, or ask the owner to reset it.`);
      }
      if (!(await verifyPin(person.pin_hash, pin))) {
        // A hold that has run out starts the count again.
        const failures = (person.held_until ? 0 : person.failures) + 1;
        const held = failures >= MAX_PIN_TRIES;
        await this.#repository.setFailures(tx, actor.tenantId, userId, {
          failures, heldUntil: held ? new Date(now.getTime() + PIN_HOLD_MINUTES * MINUTE) : null,
        });
        // Returned, not thrown, so the count is saved.
        return { wrong: MAX_PIN_TRIES - failures };
      }
      await this.#repository.setFailures(tx, actor.tenantId, userId, { failures: 0, heldUntil: null });
      await this.#repository.replaceUnlock(tx, {
        tokenHash: hashToken(staffToken), tenantId: actor.tenantId, branchId: actor.branchId, deviceId: actor.deviceId, userId,
      });
      return { person: { id: person.id, name: person.name, role: person.role } };
    }, { logger: log });

    if (outcome.wrong !== undefined) {
      log.info({ tenantId: actor.tenantId, deviceId: actor.deviceId, triesLeft: Math.max(0, outcome.wrong) }, 'Wrong PIN');
      throw apiError('wrong_pin', outcome.wrong > 0
        ? `Wrong PIN. ${outcome.wrong} ${outcome.wrong === 1 ? 'try' : 'tries'} left.`
        : `Wrong PIN. Try again in ${PIN_HOLD_MINUTES} minutes.`, { pin: 'Wrong PIN.' });
    }
    log.success({ tenantId: actor.tenantId, deviceId: actor.deviceId, userId }, 'Counter unlocked');
    return { staffToken, person: outcome.person };
  }

  /** The Lock button. Harmless if nobody was unlocked. */
  async lock({ actor, log }) {
    await this.#repository.lock(actor.tenantId, actor.deviceId);
    log.success({ tenantId: actor.tenantId, deviceId: actor.deviceId }, 'Counter locked');
    return { ok: true };
  }
}

import { isUniqueViolation } from '../db/database.js';
import { BranchModel } from '../model/branch.model.js';
import { TeamModel } from '../model/team.model.js';
import { COUNTER_PIN_LENGTH } from '../shared/rules/constants.js';
import { hashPin } from '../shared/crypto.js';
import { apiError } from '../shared/error-codes.js';
import { isUuid, parseOrThrow } from '../shared/validation.js';
import { NO_LIVE } from './live.service.js';

const fieldError = (fields) => apiError('validation_failed', 'Check the highlighted fields.', fields);
const EMAIL_TAKEN = () => fieldError({ email: 'This email already has an account.' });
const NOT_FOUND = () => apiError('not_found', 'That person could not be found.');
const OWNER_MANAGED = () => apiError('forbidden', 'The owner’s account is managed by the platform team.');
const PIN_FORMAT = new RegExp(`^\\d{${COUNTER_PIN_LENGTH}}$`);

/**
 * The owner's Team screen and counter PINs (guide 8.8, core's portal-team and setPin).
 * Staff are invited by email and set their own password, so the owner never knows it.
 */
export class TeamService {
  #database;
  #repository;
  #tenants;
  #branches;
  #authAdmin;
  #portalUrl;

  #live;

  constructor({ database, repository, tenants, branches, authAdmin, portalUrl, live = NO_LIVE }) {
    this.#live = live;
    this.#database = database;
    this.#repository = repository;
    this.#tenants = tenants;
    this.#branches = branches;
    this.#authAdmin = authAdmin;
    this.#portalUrl = portalUrl;
  }

  async team({ actor }, access, sql) {
    const [members, branches] = await Promise.all([
      this.#repository.members(actor.tenantId, sql),
      this.#branches.visibleBranches(actor.tenantId, null, sql),
    ]);
    return {
      members: members.map(TeamModel.toMember),
      // Accounts allowed by the plan, the owner's included; null = unlimited.
      limit: access.limits.staff_accounts ?? null,
      branches: branches.map(BranchModel.toBranch),
    };
  }

  async #branchIds(tenantId, sql) {
    return (await this.#branches.visibleBranches(tenantId, null, sql)).map((branch) => branch.id);
  }

  async add(context, access, body) {
    const { actor, log, now } = context;
    const input = parseOrThrow(TeamModel.member, body ?? {});
    if (!(await this.#branchIds(actor.tenantId)).includes(input.branchId)) throw fieldError({ branchId: 'Choose one of your branches.' });
    // One account per email across the platform, as in Supabase Auth.
    if (await this.#tenants.emailTaken(input.email)) throw EMAIL_TAKEN();
    const limit = access.limits.staff_accounts ?? null;
    const limitReached = () => apiError('limit_reached', `Your plan allows ${limit} accounts, the owner’s included. Remove someone, or ask us about more.`);
    // Checked before the invite email goes out, and again under a lock below.
    if (limit !== null && (await this.#repository.members(actor.tenantId)).length >= limit) throw limitReached();

    log.info({ tenantId: actor.tenantId, branchId: input.branchId }, 'Inviting a staff member');
    let userId;
    try {
      userId = await this.#authAdmin.inviteStaff({
        email: input.email, name: input.name, tenantId: actor.tenantId, branchId: input.branchId, redirectTo: this.#portalUrl,
      });
    } catch (error) {
      log.error({ tenantId: actor.tenantId, authCode: error?.code, authStatus: error?.status, err: error }, 'Staff invite failed');
      if (error?.code === 'email_exists') throw EMAIL_TAKEN();
      throw fieldError({ email: 'The invite email could not be sent. Check the address, or try again in a few minutes.' });
    }

    try {
      await this.#database.withTx(async (tx) => {
        if (limit !== null && await this.#repository.lockAndCount(tx, actor.tenantId) >= limit) throw limitReached();
        await this.#repository.insertStaff(tx, actor.tenantId, { id: userId, name: input.name, email: input.email, branchId: input.branchId, now });
      }, { logger: log });
    } catch (error) {
      await this.#authAdmin.deleteUser(userId).catch((deleteError) => {
        log.error({ tenantId: actor.tenantId, err: deleteError }, 'Could not remove the invited account after a failed save; remove it in Supabase');
      });
      if (isUniqueViolation(error, 'team_members_email_unique')) throw EMAIL_TAKEN();
      throw error;
    }
    log.success({ tenantId: actor.tenantId, memberId: userId }, 'Staff member invited');
    return this.team(context, access);
  }

  /** Name or branch. The email is their sign-in, so it is fixed. */
  async update(context, access, id, body = {}) {
    const { actor, log } = context;
    let movedInAuth = null;
    try {
      await this.#database.withTx(async (tx) => {
        const member = isUuid(id) ? await this.#repository.findMember(tx, actor.tenantId, id) : null;
        if (!member) throw NOT_FOUND();
        if (member.role === 'tenant_owner') throw OWNER_MANAGED();
        const input = parseOrThrow(TeamModel.member.pick({ name: true, branchId: true }), {
          name: body?.name ?? member.name, branchId: body?.branchId ?? member.branch_id,
        });
        if (!(await this.#branchIds(actor.tenantId, tx)).includes(input.branchId)) throw fieldError({ branchId: 'Choose one of your branches.' });
        await this.#repository.updateStaff(tx, actor.tenantId, id, input);
        // Their sign-in carries the branch: change it last, so a refusal rolls the move back.
        if (input.branchId !== member.branch_id) {
          await this.#authAdmin.setStaffBranch(id, { tenantId: actor.tenantId, branchId: input.branchId });
          movedInAuth = member.branch_id;
        }
      }, { logger: log });
    } catch (error) {
      if (movedInAuth) await this.#authAdmin.setStaffBranch(id, { tenantId: actor.tenantId, branchId: movedInAuth }).catch(() => {});
      throw error;
    }
    log.success({ tenantId: actor.tenantId, memberId: id, movedBranch: Boolean(movedInAuth) }, 'Staff member updated');
    // Their sign-in no longer matches their branch: live lines close, the app reconnects after refreshing.
    if (movedInAuth) this.#live.userRemoved({ tenantId: actor.tenantId, userId: id });
    return this.team(context, access);
  }

  /** Access ends at once: their next request gets 401 account_removed. */
  async remove(context, access, id) {
    const { actor, log } = context;
    await this.#database.withTx(async (tx) => {
      const member = isUuid(id) ? await this.#repository.findMember(tx, actor.tenantId, id) : null;
      if (!member) throw NOT_FOUND();
      if (member.role === 'tenant_owner') throw OWNER_MANAGED();
      await this.#repository.deleteStaff(tx, actor.tenantId, id);
    }, { logger: log });
    // After the team row is gone (it refers to the account). The email can be invited again.
    await this.#authAdmin.deleteUser(id).catch((error) => {
      log.error({ tenantId: actor.tenantId, memberId: id, err: error }, 'Staff removed, but their login could not be deleted; remove it in Supabase');
    });
    log.success({ tenantId: actor.tenantId, memberId: id }, 'Staff member removed');
    this.#live.userRemoved({ tenantId: actor.tenantId, userId: id });
    return this.team(context, access);
  }

  /** Sets, changes or removes a PIN, the owner's included. Ends their counter sessions. */
  async setPin(context, access, id, body = {}) {
    const { actor, log } = context;
    const pin = body?.pin;
    if (pin !== null && !(typeof pin === 'string' && PIN_FORMAT.test(pin))) {
      throw fieldError({ pin: `The PIN is ${COUNTER_PIN_LENGTH} digits.` });
    }
    // The slow hash runs before the transaction, so no lock is held while it works.
    const pinHash = pin === null ? null : await hashPin(pin);
    await this.#database.withTx(async (tx) => {
      const member = isUuid(id) ? await this.#repository.findMember(tx, actor.tenantId, id) : null;
      if (!member) throw NOT_FOUND();
      if (pinHash === null) await this.#repository.removePin(tx, actor.tenantId, id);
      else await this.#repository.setPin(tx, actor.tenantId, id, pinHash);
    }, { logger: log });
    log.success({ tenantId: actor.tenantId, memberId: id, hasPin: pinHash !== null }, 'Counter PIN saved');
    return this.team(context, access);
  }
}

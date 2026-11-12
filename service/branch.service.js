import { isUniqueViolation } from '../db/database.js';
import { BranchModel } from '../model/branch.model.js';
import { apiError } from '../shared/error-codes.js';
import { isUuid, parseOrThrow, requireReason } from '../shared/validation.js';

const INVALID_INPUT = { code: 'invalid_input', message: 'Some details need fixing.' };
const DUPLICATE = () => apiError('duplicate_branch', 'A branch with this name already exists.', { name: 'A branch with this name already exists.' });
const NOT_FOUND = () => apiError('branch_not_found', 'This branch does not exist.');
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Branches in the platform console (guide 9.4, core's tenant-admin). Each returns TenantDetail. */
export class BranchService {
  #database;
  #repository;
  #tenants;
  #tenantService;
  #audit;
  #entitlements;

  constructor({ database, repository, tenants, tenantService, audit, entitlements }) {
    this.#database = database;
    this.#repository = repository;
    this.#tenants = tenants;
    this.#tenantService = tenantService;
    this.#audit = audit;
    this.#entitlements = entitlements;
  }

  async #write(context, tenantId, operation, work) {
    try {
      await this.#database.withTx(async (tx) => {
        if (!(await this.#tenants.lockForWrite(tx, tenantId))) throw apiError('tenant_not_found', 'This restaurant does not exist.');
        await work(tx, await this.#repository.live(tx, tenantId));
      }, { logger: context.log });
    } catch (error) {
      if (isUniqueViolation(error, 'branches_name_unique')) throw DUPLICATE();
      throw error;
    }
    context.log.success({ tenantId, operation }, 'Branch saved');
    return this.#tenantService.detail(tenantId, context.now);
  }

  /** Beyond the branches limit, the Additional branch add-on comes first. */
  async add(context, tenantId, body) {
    const input = parseOrThrow(BranchModel.input, body ?? {}, INVALID_INPUT);
    const access = await this.#entitlements.forTenant(tenantId, context.now);
    return this.#write(context, tenantId, 'add', async (tx, branches) => {
      const limit = access?.limits.branches ?? 1;
      if (limit !== null && branches.length >= limit) {
        throw apiError('branch_limit', `This restaurant has ${limit} branch${limit === 1 ? '' : 'es'} paid for. Add the Additional branch add-on first.`);
      }
      if (branches.some((branch) => same(branch.name, input.name))) throw DUPLICATE();
      await this.#repository.insert(tx, tenantId, { name: input.name, area: input.area, now: context.now });
      await this.#audit.record(tx, { tenantId, action: 'branch_added', actor: context.actor.name, after: `${input.name} (${input.area})`, reason: input.reason });
    });
  }

  async update(context, tenantId, branchId, body) {
    const input = parseOrThrow(BranchModel.input, body ?? {}, INVALID_INPUT);
    return this.#write(context, tenantId, 'update', async (tx, branches) => {
      const branch = isUuid(branchId) ? branches.find((entry) => entry.id === branchId) : null;
      if (!branch) throw NOT_FOUND();
      if (branches.some((entry) => entry.id !== branchId && same(entry.name, input.name))) throw DUPLICATE();
      const before = [];
      const after = [];
      if (branch.name !== input.name) { before.push(`Name: ${branch.name}`); after.push(`Name: ${input.name}`); }
      if (branch.area !== input.area) { before.push(`Area: ${branch.area}`); after.push(`Area: ${input.area}`); }
      if (after.length === 0) throw apiError('no_changes', 'Nothing has changed.');
      await this.#repository.update(tx, tenantId, branchId, input);
      await this.#audit.record(tx, { tenantId, action: 'branch_updated', actor: context.actor.name, before: before.join('; '), after: after.join('; '), reason: input.reason });
    });
  }

  /** Never the main branch, and only once the owner has retired its tables and staff. */
  async remove(context, tenantId, branchId, body = {}) {
    const reason = requireReason(body?.reason);
    return this.#write(context, tenantId, 'remove', async (tx, branches) => {
      const branch = isUuid(branchId) ? branches.find((entry) => entry.id === branchId) : null;
      if (!branch) throw NOT_FOUND();
      if (branch.is_main) throw apiError('main_branch', 'The main branch cannot be removed.');
      if ((typeof body.confirmation === 'string' ? body.confirmation.trim() : '') !== branch.name) {
        throw apiError('confirmation_mismatch', 'Type the branch name exactly to confirm.', { confirmation: 'Type the branch name exactly.' });
      }
      const { tables, staff } = await this.#repository.inUse(tx, tenantId, branchId);
      if (tables || staff) {
        const what = [tables && `${tables} active table${tables === 1 ? '' : 's'}`, staff && `${staff} staff login${staff === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
        throw apiError('branch_in_use', `${branch.name} still has ${what}. The owner retires them in the portal first.`);
      }
      await this.#repository.retire(tx, tenantId, branchId, context.now);
      await this.#audit.record(tx, { tenantId, action: 'branch_removed', actor: context.actor.name, before: `${branch.name} (${branch.area})`, reason });
    });
  }
}

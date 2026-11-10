import { isUniqueViolation } from '../db/database.js';
import { BranchModel } from '../model/branch.model.js';
import { DineInModel } from '../model/dine-in.model.js';
import { newTableToken } from '../shared/crypto.js';
import { apiError } from '../shared/error-codes.js';
import { isUuid } from '../shared/validation.js';

const fieldError = (fields) => apiError('validation_failed', 'Check the highlighted fields.', fields);
const TABLE_NOT_FOUND = () => apiError('not_found', 'That table could not be found.');
const numberTaken = (number) => fieldError({ number: `Table ${number} already exists at this branch.` });
const tableLimit = (limit) => apiError('limit_reached', `Your plan covers ${limit} tables. Ask us about more tables, or retire one you no longer use.`);

/**
 * Tables and waiters (guide 8.5, core's portal-dinein). Owners see every branch; staff
 * and counters only their own, so another branch's table is "not found" for them.
 */
export class DineInSetupService {
  #database;
  #repository;
  #branches;

  constructor({ database, repository, branches }) {
    this.#database = database;
    this.#repository = repository;
    this.#branches = branches;
  }

  async #visibleBranches(actor, sql) {
    return this.#branches.visibleBranches(actor.tenantId, actor.branchId, sql);
  }

  async setup({ actor }, access, sql) {
    const branches = await this.#visibleBranches(actor, sql);
    const row = await this.#repository.setup(actor.tenantId, branches.map((branch) => branch.id), sql);
    return {
      tables: row.tables.map(DineInModel.toTable),
      waiters: row.waiters.map(DineInModel.toWaiter),
      branches: branches.map(BranchModel.toBranch),
      tableLimit: access.limits.tables ?? null,
    };
  }

  async #write(context, access, operation, work) {
    try {
      await this.#database.withTx((tx) => work(tx, context.actor.tenantId), { logger: context.log });
    } catch (error) {
      if (isUniqueViolation(error, 'dining_tables_active_number')) throw fieldError({ number: 'That table number is already in use at this branch.' });
      if (isUniqueViolation(error, 'waiters_name_unique')) throw fieldError({ name: 'Already on the list.' });
      throw error;
    }
    context.log.success({ tenantId: context.actor.tenantId, operation }, 'Dine-in setup saved');
    return this.setup(context, access);
  }

  async #table(tx, actor, id) {
    const table = isUuid(id) ? await this.#repository.findTable(tx, actor.tenantId, id) : null;
    const visible = table && (await this.#visibleBranches(actor, tx)).some((branch) => branch.id === table.branch_id);
    if (!visible) throw TABLE_NOT_FOUND();
    return table;
  }

  // ---------------------------------------------------------------- Tables (owner)

  addTable(context, access, body = {}) {
    return this.#write(context, access, 'addTable', async (tx, tenantId) => {
      const branchIds = (await this.#visibleBranches(context.actor, tx)).map((branch) => branch.id);
      const { fields, value } = DineInModel.tableInput(body ?? {}, branchIds);
      if (!fields.number && !fields.branchId && await this.#repository.numberTaken(tx, tenantId, value.branchId, value.number)) {
        fields.number = numberTaken(value.number).fields.number;
      }
      if (Object.keys(fields).length) throw fieldError(fields);
      // Active tables across every branch count against the plan's limit.
      const active = await this.#repository.lockTables(tx, tenantId);
      const limit = access.limits.tables ?? null;
      if (limit !== null && active >= limit) throw tableLimit(limit);
      await this.#repository.insertTable(tx, tenantId, value, newTableToken());
    });
  }

  /** Renames, renumbers, changes seats, or retires (active: false) and brings back a table. */
  updateTable(context, access, id, body = {}) {
    return this.#write(context, access, 'updateTable', async (tx, tenantId) => {
      const table = await this.#table(tx, context.actor, id);
      const branchIds = (await this.#visibleBranches(context.actor, tx)).map((branch) => branch.id);
      const merged = {
        number: table.number, seats: table.seats, branchId: table.branch_id, label: table.label,
        ...body, active: body.active,
      };
      const { fields, value } = DineInModel.tableInput(merged, branchIds);
      const active = body.active === undefined ? table.active : body.active;
      if (!fields.number && !fields.branchId && active && await this.#repository.numberTaken(tx, tenantId, value.branchId, value.number, table.id)) {
        fields.number = numberTaken(value.number).fields.number;
      }
      if (Object.keys(fields).length) throw fieldError(fields);
      if (value.branchId !== table.branch_id && table.has_history) {
        throw apiError('table_in_use', `Table ${table.number} has orders at its branch, so it can’t move. Retire it and add a table at the other branch.`);
      }
      if (body.active === false && table.has_party) {
        throw apiError('table_in_use', `Table ${table.number} has a party at it. Close the table first.`);
      }
      // Bringing a table back counts against the limit again.
      if (active && !table.active) {
        const inUse = await this.#repository.lockTables(tx, tenantId);
        const limit = access.limits.tables ?? null;
        if (limit !== null && inUse >= limit) throw tableLimit(limit);
      }
      await this.#repository.updateTable(tx, tenantId, table.id, { ...value, active });
    });
  }

  /** A new QR code when the old one is thought to be circulating. The printed card must be replaced. */
  replaceTableToken(context, access, id) {
    return this.#write(context, access, 'replaceTableToken', async (tx, tenantId) => {
      const table = await this.#table(tx, context.actor, id);
      await this.#repository.replaceToken(tx, tenantId, table.id, newTableToken());
    });
  }

  // ---------------------------------------------------------------- Waiters (owner, staff and counters)

  addWaiter(context, access, body = {}) {
    return this.#write(context, access, 'addWaiter', async (tx, tenantId) => {
      const branchIds = (await this.#visibleBranches(context.actor, tx)).map((branch) => branch.id);
      const { fields, value } = DineInModel.waiterInput(body ?? {}, branchIds);
      if (!fields.name && !fields.branchId && await this.#repository.waiterNameTaken(tx, tenantId, value.branchId, value.name)) {
        fields.name = 'Already on the list.';
      }
      if (Object.keys(fields).length) throw fieldError(fields);
      await this.#repository.insertWaiter(tx, tenantId, value);
    });
  }

  removeWaiter(context, access, id) {
    return this.#write(context, access, 'removeWaiter', async (tx, tenantId) => {
      const waiter = isUuid(id) ? await this.#repository.findWaiter(tx, tenantId, id) : null;
      const visible = waiter && (await this.#visibleBranches(context.actor, tx)).some((branch) => branch.id === waiter.branch_id);
      if (!visible) throw apiError('not_found', 'That waiter could not be found.');
      if (waiter.busy) throw apiError('waiter_busy', `${waiter.name} is serving a table. Close it, or reassign it first.`);
      await this.#repository.retireWaiter(tx, tenantId, waiter.id, context.now);
    });
  }
}

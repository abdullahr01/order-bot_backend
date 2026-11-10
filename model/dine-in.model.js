// Tables and waiters for the Setup screen (core's DiningTable, Waiter, TableInput, WaiterInput).
export class DineInModel {
  static TABLE_LABEL_MAX = 30;

  static toTable(row) {
    return {
      id: row.id, tenantId: row.tenant_id, branchId: row.branch_id, number: row.number,
      label: row.label, seats: row.seats, token: row.token, active: row.active,
    };
  }

  static toWaiter(row) {
    return { id: row.id, tenantId: row.tenant_id, branchId: row.branch_id, name: row.name };
  }

  /**
   * Checks a whole table (the stored one merged with the change). Field messages match
   * the mock; the branch must be one this person can see.
   */
  static tableInput(body, visibleBranchIds) {
    const number = Number(body.number);
    const seats = Number(body.seats);
    const branchId = typeof body.branchId === 'string' ? body.branchId : '';
    const fields = {};
    if (!Number.isInteger(number) || number < 1 || number > 999) fields.number = 'Use a number from 1 to 999.';
    if (!Number.isInteger(seats) || seats < 1 || seats > 30) fields.seats = 'Seats from 1 to 30.';
    if (!visibleBranchIds.includes(branchId)) fields.branchId = 'Choose a branch.';
    if (body.active !== undefined && typeof body.active !== 'boolean') fields.active = 'Choose whether the table is in use.';
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, DineInModel.TABLE_LABEL_MAX) : null;
    return { fields, value: { number, seats, branchId, label } };
  }

  static waiterInput(body, visibleBranchIds) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const branchId = typeof body.branchId === 'string' ? body.branchId : '';
    const fields = {};
    if (name.length < 2 || name.length > 40) fields.name = 'Enter their name.';
    if (!visibleBranchIds.includes(branchId)) fields.branchId = 'Choose a branch.';
    return { fields, value: { name, branchId } };
  }
}

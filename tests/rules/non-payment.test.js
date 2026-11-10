// The founders' non-payment rules and the partner's role permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { can, HISTORY_DAYS, PERMISSIONS } from '../../shared/rules/access.js';
import { canEditPrices, canSee, isPartner, viewCountry } from '../../shared/rules/admin-scope.js';
import { isReadOnly, isSetupLocked, nextPastDueStep, pastDueStep } from '../../shared/rules/entitlements.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const overdue = (days) => ({ status: 'past_due', pastDueSince: new Date(NOW.getTime() - days * 86_400_000).toISOString() });

test('owners can edit until day 30, then setup locks', () => {
  assert.equal(isSetupLocked(overdue(29), NOW), false);
  assert.equal(isSetupLocked(overdue(30), NOW), true);
  assert.equal(isSetupLocked({ status: 'active', pastDueSince: null }, NOW), false);
});

test('a 2-day warning comes at day 43, then suspension at day 45', () => {
  assert.equal(pastDueStep(overdue(43), NOW).label, 'Suspension warning');
  assert.deepEqual([nextPastDueStep(overdue(43), NOW).step.label, nextPastDueStep(overdue(43), NOW).inDays], ['Suspended', 2]);
  assert.equal(pastDueStep(overdue(45), NOW).label, 'Suspended');
});

test('suspended and cancelled restaurants are read-only; past due ones are not', () => {
  assert.ok(isReadOnly({ status: 'suspended' }) && isReadOnly({ status: 'cancelled' }));
  assert.ok(!isReadOnly(overdue(44)));
});

test('owners can do everything; staff only orders and service', () => {
  for (const permission of PERMISSIONS) assert.ok(can('tenant_owner', permission), permission);
  assert.deepEqual(PERMISSIONS.filter((permission) => can('tenant_staff', permission)), ['orders.manage', 'menu.availability', 'service.pause']);
  assert.ok(!can('super_admin', 'orders.manage'), 'the platform team uses the admin console');
  assert.deepEqual([HISTORY_DAYS.owner, HISTORY_DAYS.staff], [30, 7]);
});

test('platform team scope: countries, partners and who sets prices', () => {
  const founder = { adminScope: null, viewCountry: 'GB' };
  const team = { adminScope: { role: 'team', countries: ['PK', 'GB'], partnerId: null }, viewCountry: null };
  const partner = { adminScope: { role: 'partner', countries: ['GB'], partnerId: 'p1' }, viewCountry: 'PK' };
  assert.equal(viewCountry(founder), 'GB');
  assert.equal(viewCountry(team), 'PK');
  assert.equal(viewCountry(partner), 'GB', 'asking for Pakistan gets the UK anyway');
  assert.ok(canSee(founder, { country: 'PK', partnerId: null }));
  assert.ok(canSee(partner, { country: 'GB', partnerId: 'p1' }));
  assert.ok(!canSee(partner, { country: 'GB', partnerId: 'p2' }));
  assert.ok(!canSee(partner, { country: 'PK', partnerId: 'p1' }));
  assert.ok(isPartner(partner) && !isPartner(founder));
  assert.ok(canEditPrices(founder, 'GB') && canEditPrices(team, 'PK'));
  assert.ok(!canEditPrices(team, 'GB') && !canEditPrices(partner, 'GB'));
});

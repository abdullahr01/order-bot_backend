// The partner's form validation and onboarding rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BranchModel } from '../../model/branch.model.js';
import { MenuModel } from '../../model/menu.model.js';
import { ServiceSettingsModel } from '../../model/service-settings.model.js';
import { TenantModel } from '../../model/tenant.model.js';
import { onboardingSteps } from '../../shared/rules/onboarding.js';
import { PLANS } from '../../shared/rules/plans.js';
import { formatPhone, normalizePhone } from '../../shared/rules/region.js';
import { defaultHours } from '../../shared/rules/service.js';

const valid = {
  businessName: 'Tikka Town', city: 'Lahore', ownerName: 'Sara Khan', ownerPhone: '0312-1234567', ownerEmail: 'Sara@Example.com',
  country: 'PK', planId: 'growth', startAs: 'trial', trialDays: 60, addons: [{ addonId: 'extra_tables', quantity: 4 }], reason: 'Signed after the demo',
};

test('phone numbers normalise for each country', () => {
  for (const input of ['0312 1234567', '0312-1234567', '+92 312 1234567', '923121234567', '00923121234567']) {
    assert.equal(normalizePhone(input, 'PK'), '+923121234567', input);
  }
  assert.equal(formatPhone('03121234567', 'PK'), '+92 312 1234567');
  assert.equal(formatPhone('07700 900555', 'GB'), '+44 7700 900555');
});

test('creating a restaurant', () => {
  const parsed = TenantModel.create.safeParse(valid);
  assert.ok(parsed.success);
  assert.equal(parsed.data.ownerEmail, 'sara@example.com');

  const bad = TenantModel.create.safeParse({ ...valid, ownerPhone: '051 5551234', reason: '' });
  assert.ok(!bad.success);
  const fields = bad.error.issues.map((issue) => issue.path.join('.'));
  assert.ok(fields.includes('ownerPhone') && fields.includes('reason'));

  assert.ok(!TenantModel.create.safeParse({ ...valid, trialDays: 45 }).success);
  assert.ok(TenantModel.create.safeParse({ ...valid, trialDays: 14 }).success);
  assert.equal(TenantModel.slugify('Bun Kebab Co.'), 'bun-kebab-co');
});

test('UK restaurants need a UK mobile number', () => {
  assert.ok(TenantModel.create.safeParse({ ...valid, country: 'GB', city: 'London', ownerPhone: '07700 900123' }).success);
  const wrong = TenantModel.create.safeParse({ ...valid, country: 'GB', city: 'London' });
  assert.ok(!wrong.success);
  assert.match(wrong.error.issues[0].message, /UK mobile/);
});

test('editing a restaurant and its branches', () => {
  const edit = { businessName: 'Tikka Town', city: 'Lahore', ownerName: 'Sara Khan', ownerPhone: '0312 1234567', ownerEmail: 'sara@example.com', reason: 'Owner changed her number' };
  assert.ok(TenantModel.update.safeParse(edit).success);
  const bad = TenantModel.update.safeParse({ ...edit, businessName: 'T', ownerPhone: '051 5551234', reason: '' });
  assert.deepEqual(bad.error.issues.map((issue) => issue.path[0]).sort(), ['businessName', 'reason']);
  assert.ok(BranchModel.input.safeParse({ name: 'Saddar', area: 'Bank Road, Rawalpindi', reason: 'Second location opened' }).success);
  assert.ok(!BranchModel.input.safeParse({ name: 'B', area: '', reason: 'Opening' }).success);
});

test('onboarding follows the features the restaurant has', () => {
  const steps = (id) => onboardingSteps(new Set(PLANS[id].features), PLANS[id].limits.tables);
  const ids = steps('starter').map((step) => step.id);
  assert.equal(ids[0], 'agreement');
  assert.equal(ids.at(-1), 'go_live');
  assert.ok(['menu', 'tables', 'counter', 'verify_access', 'training'].every((id) => ids.includes(id)));
  assert.ok(!steps('starter').some((step) => step.id === 'time_menus'));
  assert.ok(steps('growth').some((step) => step.id === 'time_menus'));
  assert.match(steps('growth').find((step) => step.id === 'counter').detail, /at every station/);
  assert.match(steps('starter').find((step) => step.id === 'tables').detail, /Up to 10 tables/);
});

test('opening hours need every day once, with real times', () => {
  assert.ok(ServiceSettingsModel.settings.safeParse({ hours: defaultHours(), pausedUntil: null }).success);
  assert.ok(!ServiceSettingsModel.settings.safeParse({ hours: defaultHours().slice(1), pausedUntil: null }).success);
  const badTime = defaultHours().map((day) => (day.day === 1 ? { ...day, opensAt: '25:00' } : day));
  assert.ok(!ServiceSettingsModel.settings.safeParse({ hours: badTime, pausedUntil: null }).success);
});

test('menu item validation', () => {
  const item = { categoryId: 'c_1', name: ' Chicken Biryani ', description: 'Medium spicy', price: '450', photoUrl: null, available: true, soldOutUntil: null };
  const parsed = MenuModel.item.parse(item);
  assert.equal(parsed.name, 'Chicken Biryani');
  assert.equal(parsed.price, 450);
  assert.ok(!MenuModel.item.safeParse({ ...item, price: '0' }).success, 'price must be positive');
  assert.ok(!MenuModel.item.safeParse({ ...item, price: '12.5' }).success, 'whole numbers only');
  assert.ok(!MenuModel.item.safeParse({ ...item, name: 'A' }).success);
  assert.ok(!MenuModel.item.safeParse({ ...item, categoryId: '' }).success);
  assert.ok(!MenuModel.category.safeParse({ name: '  ' }).success);
});

test('dish options: limits and unique ids', () => {
  const group = (id, kind, choices) => ({ id, name: 'Spice', kind, choices });
  const choice = (id) => ({ id, name: id, price: 0 });
  assert.ok(!MenuModel.optionGroup.safeParse(group('g', 'one', [choice('a')])).success, 'pick one needs two choices');
  assert.ok(MenuModel.optionGroup.safeParse(group('g', 'extra', [choice('a')])).success);
  const item = { categoryId: 'c', name: 'Karahi', description: '', price: 100, photoUrl: null, available: true, soldOutUntil: null };
  assert.ok(!MenuModel.item.safeParse({ ...item, options: [group('g', 'extra', [choice('g')])] }).success, 'ids must be unique within a dish');
});

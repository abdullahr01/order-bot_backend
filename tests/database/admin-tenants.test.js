// /admin/tenants: sign-up, the list, the restaurant page, edits and the checklist.
// Every test runs in a transaction that is rolled back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FOUNDER, openHarness } from './api-harness.js';

const harness = openHarness();
after(() => harness.close());

const team = (countries) => ({ role: 'team', countries, partnerId: null });
const UK = { country: 'GB', city: 'London', ownerPhone: '07700 900123' };

async function addPartner(api, countries = ['GB']) {
  const [row] = await api.sql`insert into dinein.partners (name, countries, contact_name, contact_email)
    values ('Test Partner Ltd', ${countries}, 'Test Contact', 'partner@example.invalid') returning id`;
  return row.id;
}

test('signing up a restaurant creates everything it needs on day one', () => harness.run(async (api) => {
  const { detail, id, ownerId } = await api.restaurant({ planId: 'starter', startAs: 'trial', trialDays: 14, addons: [{ addonId: 'extra_tables', quantity: 5 }] });

  assert.equal(detail.tenant.country, 'PK');
  assert.equal(detail.tenant.currency, 'PKR');
  assert.equal(detail.tenant.timezone, 'Asia/Karachi');
  assert.equal(detail.tenant.taxProfile, 'pk_pra');
  assert.equal(detail.tenant.ownerPhone, '+92 312 1234567');
  assert.match(detail.tenant.slug, /^stage3-test-/);
  assert.deepEqual(detail.tenant.onboarding, { completedSteps: [], completedAt: null });
  assert.equal(detail.subscription.status, 'trial');
  assert.equal(detail.subscription.billingStartsAt, null);
  assert.equal(detail.subscription.setupFee, 30000);
  assert.ok(detail.subscription.trialEndsAt);
  assert.equal(detail.monthlyValue, 0, 'a trial is not billed');
  assert.equal(detail.amountDueThisMonth, 0);
  assert.deepEqual(detail.branches.map((branch) => [branch.name, branch.isMain, branch.area]), [['Main branch', true, 'Rawalpindi']]);
  assert.deepEqual(detail.team.map((member) => [member.id, member.role, member.hasPin]), [[ownerId, 'tenant_owner', false]]);
  assert.deepEqual(detail.addons.map((addon) => [addon.addonId, addon.quantity]), [['extra_tables', 5]]);
  assert.equal(detail.access.limits.find((limit) => limit.key === 'tables').value, 15, 'starter 10 plus 5 bought');
  assert.deepEqual(detail.usage, { menuItems: 0, tables: 0, staffAccounts: 1, stations: 1, branches: 1 });
  assert.deepEqual(detail.events.map((event) => event.action).sort(), ['addon_added', 'tenant_created']);
  assert.ok(detail.events.every((event) => event.actor === 'Test founder' && event.reason === 'Signed up in a test'));

  // The owner's account is invited, with the restaurant in app_metadata, and lands on the portal.
  assert.equal(api.auth.invited.length, 1);
  assert.equal(api.auth.invited[0].tenantId, id);
  assert.equal(api.auth.invited[0].redirectTo, 'http://localhost:3002');
  const [hours] = await api.sql`select hours from dinein.service_settings where tenant_id = ${id}`;
  assert.equal(hours.hours.length, 7);
  const [version] = await api.sql`select version from dinein.menu_versions where tenant_id = ${id}`;
  assert.equal(version.version, 1);

  // The owner can use the portal straight away.
  const me = await api.call('GET', '/portal/me', { token: api.owner(id, ownerId) });
  assert.equal(me.status, 200);
  assert.equal(me.body.tenant.id, id);
}));

test('a paid UK sign-up uses the UK price list, pounds, London time and a UK phone', () => harness.run(async (api) => {
  const { detail } = await api.restaurant({ ...UK, planId: 'growth', startAs: 'active' });
  assert.deepEqual([detail.tenant.currency, detail.tenant.timezone, detail.tenant.taxProfile], ['GBP', 'Europe/London', 'gb_vat']);
  assert.equal(detail.tenant.ownerPhone, '+44 7700 900123');
  assert.equal(detail.subscription.status, 'active');
  assert.ok(detail.subscription.billingStartsAt, 'billing starts today');
  assert.equal(detail.subscription.setupFee, 299, 'UK placeholder setup fee');
  assert.equal(detail.monthlyValue, 169);
  assert.ok(detail.amountDueThisMonth > 0 && detail.amountDueThisMonth <= 169, 'the first month is charged from today');
}));

test('sign-up refusals: form errors, duplicates, add-ons, scope and a failed invite leave nothing behind', () => harness.run(async (api) => {
  const founder = api.admin();
  const valid = {
    businessName: `Refusal Test ${randomUUID().slice(0, 8)}`, city: 'Lahore', ownerName: 'Owner', ownerPhone: '0300 1112223',
    ownerEmail: `refusal-${randomUUID()}@example.invalid`, country: 'PK', planId: 'growth', startAs: 'trial', trialDays: 30, addons: [], reason: 'Testing refusals',
  };
  const send = (body, token = founder) => api.call('POST', '/admin/tenants', { token, body });

  const bad = await send({ ...valid, ownerEmail: 'not-an-email', trialDays: 7 });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, 'invalid_input');
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ['ownerEmail', 'trialDays']);
  // As in core, the phone is checked against the country once the rest of the form is valid.
  const phone = await send({ ...valid, ownerPhone: '12345' });
  assert.deepEqual([phone.status, Object.keys(phone.body.fields)], [422, ['ownerPhone']]);

  const existing = await api.restaurant();
  const duplicateName = await send({ ...valid, businessName: existing.detail.tenant.businessName.toUpperCase() });
  assert.deepEqual([duplicateName.status, duplicateName.body.code], [409, 'duplicate_name']);
  const takenEmail = await send({ ...valid, ownerEmail: existing.detail.tenant.ownerEmail });
  assert.deepEqual([takenEmail.status, takenEmail.body.code, Object.keys(takenEmail.body.fields)], [422, 'invalid_input', ['ownerEmail']]);

  const twice = await send({ ...valid, addons: [{ addonId: 'extra_staff', quantity: 1 }, { addonId: 'extra_staff', quantity: 2 }] });
  assert.deepEqual([twice.status, twice.body.code], [422, 'duplicate_addon']);
  const notOffered = await send({ ...valid, addons: [{ addonId: 'extra_station', quantity: 1 }] });
  assert.deepEqual([notOffered.status, notOffered.body.code], [422, 'addon_unavailable']);

  // A UK-only team member can't add a Pakistani restaurant; a partner must name a real one.
  const ukOnly = await send(valid, api.admin(team(['GB'])));
  assert.deepEqual([ukOnly.status, ukOnly.body.code, Object.keys(ukOnly.body.fields)], [422, 'invalid_input', ['country']]);
  const unknownPartner = await send({ ...valid, ...UK, partnerId: randomUUID() });
  assert.deepEqual([unknownPartner.status, Object.keys(unknownPartner.body.fields)], [422, ['partnerId']]);

  // Supabase refusing the invite stops the sign-up before anything is saved.
  api.auth.failInvite = 'over_email_send_rate_limit';
  const refused = await send(valid);
  assert.deepEqual([refused.status, refused.body.code, Object.keys(refused.body.fields)], [422, 'invalid_input', ['ownerEmail']]);
  api.auth.failInvite = null;
  const [left] = await api.sql`select count(*)::int as count from dinein.tenants where business_name = ${valid.businessName}`;
  assert.equal(left.count, 0);

  // Only the platform team.
  const owner = await send(valid, existing.ownerToken);
  assert.equal(owner.status, 403);
  const noMfa = await send(valid, api.admin(FOUNDER, { aal: 'aal1' }));
  assert.equal(noMfa.status, 403);
}));

test('the list shows one country at a time, and a partner only their own restaurants', () => harness.run(async (api) => {
  const partnerId = await addPartner(api);
  const pk = await api.restaurant({ city: 'Multan' });
  const gb = await api.restaurant({ ...UK, partnerId });
  const otherGb = await api.restaurant({ ...UK, city: 'Leeds' });
  const search = 'stage3 test';
  const list = (token, country) => api.call('GET', `/admin/tenants?search=${encodeURIComponent(search)}&pageSize=100`, {
    token, headers: country ? { 'x-admin-country': country } : {},
  });
  const ids = (response) => response.body.items.map((item) => item.id);

  const founderPk = await list(api.admin(), 'PK');
  assert.equal(founderPk.status, 200);
  assert.ok(ids(founderPk).includes(pk.id));
  assert.ok(!ids(founderPk).includes(gb.id), 'the UK is on its own screen');
  const row = founderPk.body.items.find((item) => item.id === pk.id);
  assert.deepEqual([row.planId, row.status, row.monthlyValue, row.tables, row.ordersToday], ['growth', 'active', 25000, { used: 0, limit: 20 }, 0]);
  assert.ok(founderPk.body.statusCounts.all >= 1);
  assert.ok(founderPk.body.cities.includes('Multan'));

  const founderGb = await list(api.admin(), 'GB');
  assert.ok(ids(founderGb).includes(gb.id) && ids(founderGb).includes(otherGb.id));

  const partner = await list(api.admin({ role: 'partner', countries: ['GB'], partnerId }));
  assert.deepEqual(ids(partner), [gb.id], 'a partner sees only the restaurants they brought in');
  assert.ok(!partner.body.cities.includes('Leeds'));

  // A team member asking for a country outside their scope gets their own.
  const pkTeam = await list(api.admin(team(['PK'])), 'GB');
  assert.ok(ids(pkTeam).includes(pk.id) && !ids(pkTeam).includes(gb.id));

  const filtered = await api.call('GET', `/admin/tenants?search=${encodeURIComponent(pk.detail.tenant.businessName)}&status=trial`, { token: api.admin() });
  assert.deepEqual([filtered.body.total, filtered.body.statusCounts.all, filtered.body.statusCounts.active], [0, 1, 1]);
}));

test('a restaurant outside the person’s scope does not exist for them', () => harness.run(async (api) => {
  const partnerId = await addPartner(api);
  const pk = await api.restaurant();
  const gb = await api.restaurant({ ...UK, partnerId });
  const partner = api.admin({ role: 'partner', countries: ['GB'], partnerId });
  const otherPartner = api.admin({ role: 'partner', countries: ['GB'], partnerId: randomUUID() });

  assert.equal((await api.call('GET', `/admin/tenants/${gb.id}`, { token: partner })).status, 200);
  for (const [token, id] of [[partner, pk.id], [otherPartner, gb.id], [api.admin(team(['PK'])), gb.id], [api.admin(), randomUUID()], [api.admin(), 'not-a-uuid']]) {
    const response = await api.call('GET', `/admin/tenants/${id}`, { token });
    assert.deepEqual([response.status, response.body.code], [404, 'tenant_not_found']);
  }
  // Writes are refused the same way, before anything is checked.
  const write = await api.call('PATCH', `/admin/tenants/${pk.id}`, { token: partner, body: {} });
  assert.deepEqual([write.status, write.body.code], [404, 'tenant_not_found']);
  // A partner's own sign-ups are tagged as theirs.
  const signed = await api.restaurant({ ...UK }, { role: 'partner', countries: ['GB'], partnerId });
  assert.equal(signed.detail.tenant.partnerId, partnerId);
}));

test('editing details records what changed and moves the owner’s sign-in email', () => harness.run(async (api) => {
  const { id, ownerId, detail } = await api.restaurant();
  const other = await api.restaurant();
  const founder = api.admin();
  const base = {
    businessName: detail.tenant.businessName, city: detail.tenant.city, ownerName: detail.tenant.ownerName,
    ownerPhone: '0312 1234567', ownerEmail: detail.tenant.ownerEmail, reason: 'Owner asked for a change',
  };
  const edit = (body) => api.call('PATCH', `/admin/tenants/${id}`, { token: founder, body });

  assert.deepEqual([(await edit(base)).body.code], ['no_changes']);
  assert.equal((await edit({ ...base, businessName: other.detail.tenant.businessName })).body.code, 'duplicate_name');
  const phone = await edit({ ...base, ownerPhone: '07700 900123' });
  assert.deepEqual([phone.status, Object.keys(phone.body.fields)], [422, ['ownerPhone']], 'a Pakistani restaurant needs a Pakistani mobile');
  const taken = await edit({ ...base, ownerEmail: other.detail.tenant.ownerEmail });
  assert.deepEqual([taken.status, Object.keys(taken.body.fields)], [422, ['ownerEmail']]);
  assert.equal((await edit({ ...base, reason: 'no' })).status, 422);

  const email = `moved-${randomUUID()}@example.invalid`;
  const saved = await edit({ ...base, businessName: `${base.businessName} Grill`, ownerEmail: email.toUpperCase() });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.tenant.businessName, `${base.businessName} Grill`);
  assert.equal(saved.body.tenant.ownerEmail, email);
  const event = saved.body.events.find((entry) => entry.action === 'tenant_updated');
  assert.equal(event.before, `Name: ${base.businessName}; Email: ${base.ownerEmail}`);
  assert.equal(event.after, `Name: ${base.businessName} Grill; Email: ${email}`);
  assert.equal(event.tenantName, `${base.businessName} Grill`);
  const [user] = await api.sql`select email from auth.users where id = ${ownerId}`;
  assert.equal(user.email, email);
  assert.equal(saved.body.team[0].email, email);
}));

test('the setup checklist ticks steps, and only the steps the plan has', () => harness.run(async (api) => {
  const starter = await api.restaurant({ planId: 'starter' });
  const growth = await api.restaurant({ planId: 'growth' });
  const founder = api.admin();
  const tick = (id, stepId, done = true) => api.call('PATCH', `/admin/tenants/${id}/onboarding`, { token: founder, body: { stepId, done } });

  assert.deepEqual((await tick(starter.id, 'time_menus')).body.code, 'invalid_step', 'Starter has no time-based menus');
  assert.deepEqual((await tick(starter.id, 'nonsense')).body.code, 'invalid_step');
  assert.equal((await tick(starter.id, 'menu', 'yes')).status, 422);

  const steps = ['agreement', 'collect_menu', 'menu', 'tables', 'counter', 'verify_access', 'training'];
  for (const step of steps) assert.equal((await tick(starter.id, step)).status, 200);
  const done = await tick(starter.id, 'go_live');
  assert.deepEqual(done.body.tenant.onboarding.completedSteps.length, 8);
  assert.ok(done.body.tenant.onboarding.completedAt, 'every step done completes the checklist');
  const undone = await tick(starter.id, 'training', false);
  assert.equal(undone.body.tenant.onboarding.completedAt, null);

  assert.equal((await tick(growth.id, 'time_menus')).status, 200);
  await api.sql`update dinein.tenants set onboarding = null where id = ${growth.id}`;
  assert.equal((await tick(growth.id, 'menu')).body.code, 'no_onboarding');
}));

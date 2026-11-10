// /portal/me, /portal/menu and dish photos. Every test runs in a transaction that is rolled back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { openHarness } from './api-harness.js';
import { settings } from '../../shared/settings.js';

const harness = openHarness();
after(() => harness.close());

const dish = (categoryId, overrides = {}) => ({
  categoryId, name: 'Chicken Karahi', description: 'Tomato and green chilli', price: 1100, photoUrl: null,
  available: true, soldOutUntil: null, options: [], ...overrides,
});

/** A restaurant with a category and a dish, and a helper for owner calls. */
async function menuSetup(api, overrides) {
  const restaurant = await api.restaurant(overrides);
  const as = (token) => (method, path, body) => api.call(method, `/portal${path}`, { token, body });
  const owner = as(restaurant.ownerToken);
  const category = (await owner('POST', '/menu/categories', { name: 'Karahi' })).body.categories[0];
  const item = (await owner('POST', '/menu/items', dish(category.id))).body.items[0];
  return { ...restaurant, as, owner, category, item };
}

test('portal/me: features, limits, branches and the cheapest unlock for each missing feature', () => harness.run(async (api) => {
  const { id, ownerToken, mainBranchId } = await api.restaurant({ planId: 'growth', addons: [{ addonId: 'extra_tables', quantity: 2 }] });
  const second = await api.addBranch(id);
  const me = await api.call('GET', '/portal/me', { token: ownerToken });
  assert.equal(me.status, 200);
  assert.deepEqual([me.body.plan.id, me.body.plan.name, me.body.subscription.status], ['growth', 'Growth', 'active']);
  assert.ok(me.body.features.includes('station_routing') && me.body.features.includes('time_menus'));
  assert.ok(!me.body.features.includes('pra_invoicing'));
  assert.deepEqual(me.body.paused, []);
  assert.equal(me.body.limits.tables, 22);
  assert.deepEqual(me.body.branches.map((branch) => branch.id), [mainBranchId, second], 'main branch first');
  assert.deepEqual(me.body.unlocks.pra_invoicing, { kind: 'plan', label: 'Pro plan', price: 35000 });
  assert.equal(me.body.unlocks.multi_branch.kind, 'addon');
  assert.equal(me.body.unlocks.station_routing, undefined, 'never offers what they have');

  // Staff see their own branch only.
  const staff = await api.addStaff(id, second);
  const staffMe = await api.call('GET', '/portal/me', { token: staff.token });
  assert.deepEqual(staffMe.body.branches.map((branch) => branch.id), [second]);

  // Past due for 31 days: reports are paused, never offered for sale.
  await api.sql`update dinein.subscriptions set status = 'past_due', past_due_since = now() - interval '31 days' where tenant_id = ${id}`;
  const late = await api.call('GET', '/portal/me', { token: ownerToken });
  assert.ok(late.body.paused.includes('reports_basic'));
  assert.equal(late.body.unlocks.reports_basic, undefined);
}));

test('categories and stations: names, the station limit, schedules, reordering and the version', () => harness.run(async (api) => {
  const { owner, category } = await menuSetup(api, { planId: 'growth' });
  const start = (await owner('GET', '/menu')).body;
  assert.deepEqual(start.features, { stationRouting: true, timeMenus: true });

  assert.deepEqual((await owner('POST', '/menu/categories', { name: ' karahi ' })).body.fields, { name: 'You already have a category with this name.' });
  assert.equal((await owner('POST', '/menu/categories', { name: 'K' })).body.code, 'validation_failed');

  // Growth allows 4 stations, the main kitchen included: three can be added.
  for (const name of ['BBQ', 'Tandoor', 'Drinks']) assert.equal((await owner('POST', '/menu/stations', { name })).status, 200);
  assert.equal((await owner('POST', '/menu/stations', { name: 'Desserts' })).body.code, 'limit_reached');
  const stations = (await owner('GET', '/menu')).body.stations;
  assert.deepEqual(stations.map((station) => [station.name, station.position]), [['BBQ', 0], ['Tandoor', 1], ['Drinks', 2]]);
  assert.equal((await owner('PATCH', `/menu/stations/${stations[0].id}`, { name: 'kitchen' })).body.code, 'validation_failed', '"Kitchen" is the main kitchen');

  const breakfast = { days: [0, 1, 2, 3, 4, 5, 6], from: '07:00', to: '11:30', until: null };
  const routed = await owner('POST', '/menu/categories', { name: 'BBQ grill', stationId: stations[0].id, schedule: breakfast });
  const bbq = routed.body.categories.find((entry) => entry.name === 'BBQ grill');
  assert.deepEqual([bbq.stationId, bbq.schedule, bbq.position], [stations[0].id, breakfast, 1]);
  assert.equal((await owner('POST', '/menu/categories', { name: 'Late', schedule: { ...breakfast, to: '07:00' } })).body.fields['schedule.to'], 'Start and end can’t be the same time');
  assert.equal((await owner('POST', '/menu/categories', { name: 'Foreign', stationId: randomUUID() })).body.fields.stationId, 'Choose one of your stations.');

  // Deleting a station sends its categories back to the main kitchen.
  const afterDelete = await owner('DELETE', `/menu/stations/${stations[0].id}`);
  assert.equal(afterDelete.body.categories.find((entry) => entry.id === bbq.id).stationId, null);
  assert.deepEqual(afterDelete.body.stations.map((station) => [station.name, station.position]), [['Tandoor', 0], ['Drinks', 1]]);

  const order = await owner('PUT', '/menu/categories/order', { ids: [bbq.id, category.id] });
  assert.deepEqual(order.body.categories.map((entry) => entry.id), [bbq.id, category.id]);
  assert.equal((await owner('PUT', '/menu/categories/order', { ids: [bbq.id] })).body.code, 'menu_changed');
  assert.equal((await owner('PUT', '/menu/categories/order', { ids: 'nonsense' })).body.code, 'menu_changed');

  assert.equal((await owner('DELETE', `/menu/categories/${category.id}`)).body.code, 'category_not_empty');
  const emptied = await owner('DELETE', `/menu/categories/${bbq.id}`);
  assert.deepEqual(emptied.body.categories.map((entry) => [entry.id, entry.position]), [[category.id, 0]], 'positions close up');
  assert.ok(emptied.body.version > start.version, 'every change moves the version on');
}));

test('a plan without stations or time menus is refused them, but can still rename', () => harness.run(async (api) => {
  const { id, owner, category } = await menuSetup(api, { planId: 'starter' });
  assert.equal((await owner('POST', '/menu/stations', { name: 'BBQ' })).body.code, 'feature_locked');
  const schedule = { days: [5], from: '16:00', to: '19:00', until: '2027-04-01' };
  assert.equal((await owner('POST', '/menu/categories', { name: 'Iftar', schedule })).body.code, 'feature_locked');

  // Moved down from Growth with a schedule set: renaming is fine, changing the schedule is not.
  await api.sql`update dinein.menu_categories set schedule = ${api.sql.json(schedule)} where id = ${category.id}`;
  assert.equal((await owner('PATCH', `/menu/categories/${category.id}`, { name: 'Iftar specials' })).status, 200);
  assert.equal((await owner('PATCH', `/menu/categories/${category.id}`, { schedule: { ...schedule, to: '20:00' } })).body.code, 'feature_locked');
  assert.equal((await api.call('GET', '/portal/menu', { token: api.owner(id, randomUUID()) })).status, 401, 'not on the team');
}));

test('dishes: options with field paths, moving and reordering, and photo links from this restaurant only', () => harness.run(async (api) => {
  const { owner, category, item } = await menuSetup(api);
  const options = [{ id: 'g1', name: 'Size', kind: 'one', choices: [{ id: 'c1', name: 'Half', price: 0 }, { id: 'c2', name: 'Full', price: -5 }] }];
  const bad = await owner('POST', '/menu/items', dish(category.id, { options }));
  assert.deepEqual([bad.status, bad.body.fields['options.0.choices.1.price']], [422, 'Can’t be below 0']);
  options[0].choices[1].price = 900;
  const withOptions = await owner('POST', '/menu/items', dish(category.id, { name: 'Mutton Karahi', price: '1650', options }));
  const mutton = withOptions.body.items.find((entry) => entry.name === 'Mutton Karahi');
  assert.deepEqual([mutton.price, mutton.position, mutton.options[0].choices[1].price], [1650, 1, 900]);
  assert.equal((await owner('POST', '/menu/items', dish(randomUUID()))).body.code, 'not_found', 'the category must exist');

  const reordered = await owner('PUT', `/menu/categories/${category.id}/order`, { ids: [mutton.id, item.id] });
  assert.deepEqual(reordered.body.items.filter((entry) => entry.categoryId === category.id).sort((a, b) => a.position - b.position).map((entry) => entry.id), [mutton.id, item.id]);

  // Moving a dish puts it at the end of the other category and closes the gap.
  const grill = (await owner('POST', '/menu/categories', { name: 'Grill' })).body.categories.find((entry) => entry.name === 'Grill');
  const moved = await owner('PATCH', `/menu/items/${mutton.id}`, { categoryId: grill.id });
  const byId = Object.fromEntries(moved.body.items.map((entry) => [entry.id, entry]));
  assert.deepEqual([byId[mutton.id].categoryId, byId[mutton.id].position, byId[item.id].position], [grill.id, 0, 0]);

  const prefix = `${settings.supabase.url}/storage/v1/object/public/menus/`;
  const outside = await owner('PATCH', `/menu/items/${item.id}`, { photoUrl: 'https://example.com/dish.jpg' });
  assert.deepEqual(outside.body.fields, { photoUrl: 'Upload the photo again.' });
  const otherRestaurant = await owner('PATCH', `/menu/items/${item.id}`, { photoUrl: `${prefix}${randomUUID()}/${randomUUID()}.jpg` });
  assert.equal(otherRestaurant.status, 422, 'another restaurant’s photo');

  const deleted = await owner('DELETE', `/menu/items/${item.id}`);
  assert.deepEqual(deleted.body.items.map((entry) => entry.id), [mutton.id]);
}));

test('staff can mark dishes sold out and nothing else; day 30 locks the owner’s edits but not service', () => harness.run(async (api) => {
  const { id, as, owner, item, mainBranchId } = await menuSetup(api);
  const staff = as((await api.addStaff(id, mainBranchId)).token);
  const until = new Date(Date.now() + 6 * 3_600_000).toISOString();

  const soldOut = await staff('PATCH', `/menu/items/${item.id}`, { soldOutUntil: until });
  assert.equal(soldOut.status, 200);
  assert.equal(soldOut.body.items[0].soldOutUntil, until);
  const price = await staff('PATCH', `/menu/items/${item.id}`, { price: 1, soldOutUntil: null });
  assert.deepEqual([price.status, price.body.code], [403, 'forbidden']);
  assert.equal((await staff('POST', '/menu/categories', { name: 'Staff menu' })).status, 403);
  assert.equal((await staff('POST', '/menu/photos', { dataUrl: 'data:image/png;base64,AAAA' })).status, 403);
  assert.equal((await staff('PATCH', `/menu/items/${item.id}`, { soldOutUntil: 'tomorrow-ish' })).body.code, 'validation_failed');

  await api.sql`update dinein.subscriptions set status = 'past_due', past_due_since = now() - interval '30 days 1 hour' where tenant_id = ${id}`;
  const locked = await owner('POST', '/menu/categories', { name: 'Desserts' });
  assert.deepEqual([locked.status, locked.body.code], [403, 'account_paused']);
  assert.equal((await owner('PATCH', `/menu/items/${item.id}`, { name: 'New name' })).body.code, 'account_paused');
  assert.equal((await owner('PATCH', `/menu/items/${item.id}`, { available: false })).status, 200, 'the owner can still take a dish off');
  assert.equal((await staff('PATCH', `/menu/items/${item.id}`, { soldOutUntil: null })).status, 200, 'service carries on');

  await api.sql`update dinein.subscriptions set status = 'suspended' where tenant_id = ${id}`;
  assert.equal((await staff('PATCH', `/menu/items/${item.id}`, { soldOutUntil: until })).body.code, 'account_paused', 'suspended is read-only');
}));

test('another restaurant’s menu does not exist for this owner', () => harness.run(async (api) => {
  const mine = await menuSetup(api);
  const theirs = await menuSetup(api);
  const station = (await theirs.owner('POST', '/menu/stations', { name: 'Theirs' })).body.stations[0];
  const before = (await theirs.owner('GET', '/menu')).body;

  for (const [method, path, body] of [
    ['PATCH', `/menu/categories/${theirs.category.id}`, { name: 'Taken over' }],
    ['DELETE', `/menu/categories/${theirs.category.id}`],
    ['PUT', `/menu/categories/${theirs.category.id}/order`, { ids: [theirs.item.id] }],
    ['PATCH', `/menu/stations/${station.id}`, { name: 'Taken' }],
    ['DELETE', `/menu/stations/${station.id}`],
    ['PATCH', `/menu/items/${theirs.item.id}`, { price: 1 }],
    ['DELETE', `/menu/items/${theirs.item.id}`],
    ['POST', '/menu/items', dish(theirs.category.id)],
  ]) {
    const response = await mine.owner(method, path, body);
    assert.deepEqual([path, response.status, response.body.code], [path, 404, 'not_found']);
  }
  assert.equal((await mine.owner('PUT', '/menu/categories/order', { ids: [theirs.category.id] })).body.code, 'menu_changed');
  assert.equal((await mine.owner('POST', '/menu/categories', { name: 'Routed', stationId: station.id })).status, 422);
  const photo = `${settings.supabase.url}/storage/v1/object/public/menus/${theirs.id}/${randomUUID()}.jpg`;
  assert.equal((await mine.owner('PATCH', `/menu/items/${mine.item.id}`, { photoUrl: photo })).status, 422);

  const mineNow = (await mine.owner('GET', '/menu')).body;
  assert.deepEqual(mineNow.items.map((entry) => entry.id), [mine.item.id], 'only their own dishes');
  assert.deepEqual((await theirs.owner('GET', '/menu')).body, before, 'nothing of theirs changed');
}));

test('photos are re-made as small JPEGs in the restaurant’s own folder; anything else is refused', () => harness.run(async (api) => {
  const { id, owner, item } = await menuSetup(api);
  const png = await sharp({ create: { width: 1600, height: 900, channels: 4, background: '#c0392b80' } }).png().toBuffer();
  const uploaded = await owner('POST', '/menu/photos', { dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(uploaded.status, 200);
  assert.match(uploaded.body.url, new RegExp(`/storage/v1/object/public/menus/${id}/[0-9a-f-]{36}\\.jpg$`));
  const stored = api.photos.uploads[0].buffer;
  const meta = await sharp(stored).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 640, 360], 'resized to 640 px, never the upload as given');

  const saved = await owner('PATCH', `/menu/items/${item.id}`, { photoUrl: uploaded.body.url });
  assert.equal(saved.body.items[0].photoUrl, uploaded.body.url);

  const notImage = await owner('POST', '/menu/photos', { dataUrl: `data:image/png;base64,${Buffer.from('not really a picture').toString('base64')}` });
  assert.deepEqual([notImage.status, notImage.body.code], [422, 'invalid_photo']);
  const gif = await owner('POST', '/menu/photos', { dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' });
  assert.equal(gif.body.code, 'invalid_photo');
  // A JPEG label on a PNG is fine (it is re-made anyway); a PNG label on random bytes is not.
  const big = await owner('POST', '/menu/photos', { dataUrl: `data:image/jpeg;base64,${'A'.repeat(11_400_000)}` });
  assert.deepEqual([big.status, big.body.code], [413, 'photo_too_large']);
  const huge = await owner('POST', '/menu/photos', { dataUrl: `data:image/jpeg;base64,${'A'.repeat(13_000_000)}` });
  assert.deepEqual([huge.status, huge.body.code], [413, 'photo_too_large']);
  assert.equal(api.photos.uploads.length, 1);

  // Large bodies are only read after sign-in.
  const anonymous = await api.call('POST', '/portal/menu/photos', { body: { dataUrl: 'data:image/png;base64,AAAA' } });
  assert.equal(anonymous.status, 401);
}));

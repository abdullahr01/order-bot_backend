import { isUniqueViolation } from '../db/database.js';
import { photoUrlPrefix } from '../db/photo-storage.js';
import { MenuModel } from '../model/menu.model.js';
import { can } from '../shared/rules/access.js';
import { apiError } from '../shared/error-codes.js';
import { isUuid, parseOrThrow } from '../shared/validation.js';

const SETUP_LOCKED_MESSAGE = 'Your payment is overdue, so the menu, tables and team can’t be changed. Call us to sort it out.';
const fieldError = (fields) => apiError('validation_failed', 'Check the highlighted fields.', fields);
const CATEGORY_TAKEN = () => fieldError({ name: 'You already have a category with this name.' });
const STATION_TAKEN = () => fieldError({ name: 'You already have a station with this name.' });
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** Field by field: the database keeps JSON keys in its own order. */
const sameSchedule = (a, b) => (a === null || b === null ? a === b
  : a.from === b.from && a.to === b.to && (a.until ?? null) === (b.until ?? null) &&
    [...a.days].sort().join() === [...b.days].sort().join());
const PHOTO_FILE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

/**
 * The menu (guide 8.6, core's portal-menu). Every write bumps the menu version and
 * returns the whole menu, which replaces the app's copy.
 */
export class MenuService {
  #database;
  #repository;
  #supabaseUrl;

  constructor({ database, repository, supabaseUrl }) {
    this.#database = database;
    this.#repository = repository;
    this.#supabaseUrl = supabaseUrl;
  }

  async menu(tenantId, access) {
    const row = await this.#repository.findMenu(tenantId);
    return {
      categories: row.categories.map(MenuModel.toCategory),
      items: row.items.map(MenuModel.toItem),
      stations: row.stations.map(MenuModel.toStation),
      features: { stationRouting: access.features.has('station_routing'), timeMenus: access.features.has('time_menus') },
      version: row.version,
    };
  }

  /** Runs one menu change in a transaction, then returns the new menu. */
  async #write({ actor, log }, access, operation, work) {
    const tenantId = actor.tenantId;
    try {
      await this.#database.withTx(async (tx) => {
        const version = await this.#repository.bumpVersion(tx, tenantId);
        await work(tx, tenantId);
        log.info({ tenantId, version }, 'Menu change ready to save');
      }, { logger: log });
    } catch (error) {
      if (isUniqueViolation(error, 'menu_categories_name_unique')) throw CATEGORY_TAKEN();
      if (isUniqueViolation(error, 'stations_name_unique')) throw STATION_TAKEN();
      throw error;
    }
    log.success({ tenantId, operation }, 'Menu saved');
    return this.menu(tenantId, access);
  }

  /** Routing and schedules need their features; a category without them stays plain. */
  static #checkPlan(access, { stationId, schedule }) {
    if (stationId !== null && !access.features.has('station_routing')) throw apiError('feature_locked', 'Sending slips to stations isn’t on your plan.');
    if (schedule !== null && !access.features.has('time_menus')) throw apiError('feature_locked', 'Time-based menus aren’t on your plan.');
  }

  /** A station must be this restaurant's; null is the main kitchen. */
  static #checkStation(stations, stationId) {
    if (stationId !== null && !stations.some((station) => station.id === stationId)) {
      throw fieldError({ stationId: 'Choose one of your stations.' });
    }
  }

  static #category(categories, id) {
    const category = isUuid(id) ? categories.find((entry) => entry.id === id) : null;
    if (!category) throw apiError('not_found', 'That category could not be found.');
    return category;
  }

  // ---------------------------------------------------------------- Categories

  createCategory(context, access, body) {
    const input = parseOrThrow(MenuModel.category, body ?? {});
    return this.#write(context, access, 'createCategory', async (tx, tenantId) => {
      const categories = await this.#repository.categories(tx, tenantId);
      if (categories.some((category) => sameName(category.name, input.name))) throw CATEGORY_TAKEN();
      MenuService.#checkStation(await this.#repository.stations(tx, tenantId), input.stationId);
      MenuService.#checkPlan(access, input);
      await this.#repository.insertCategory(tx, tenantId, input);
    });
  }

  updateCategory(context, access, id, body = {}) {
    return this.#write(context, access, 'updateCategory', async (tx, tenantId) => {
      const categories = await this.#repository.categories(tx, tenantId);
      const category = MenuService.#category(categories, id);
      // Fields not sent keep their values: renaming keeps the station and the schedule.
      const input = parseOrThrow(MenuModel.category, {
        stationId: category.station_id, schedule: category.schedule ?? null, ...body, name: body.name ?? category.name,
      });
      if (categories.some((entry) => entry.id !== id && sameName(entry.name, input.name))) throw CATEGORY_TAKEN();
      MenuService.#checkStation(await this.#repository.stations(tx, tenantId), input.stationId);
      // Only a change needs the feature, so a restaurant that moved down a plan can still rename.
      MenuService.#checkPlan(access, {
        stationId: input.stationId === category.station_id ? null : input.stationId,
        schedule: sameSchedule(input.schedule, category.schedule ?? null) ? null : input.schedule,
      });
      await this.#repository.updateCategory(tx, tenantId, id, input);
    });
  }

  /** Only an empty category can be deleted, so no dish disappears by accident. */
  deleteCategory(context, access, id) {
    return this.#write(context, access, 'deleteCategory', async (tx, tenantId) => {
      MenuService.#category(await this.#repository.categories(tx, tenantId), id);
      const count = await this.#repository.itemCount(tx, tenantId, id);
      if (count > 0) throw apiError('category_not_empty', `Move or delete its ${count} item${count === 1 ? '' : 's'} first.`);
      await this.#repository.deleteCategory(tx, tenantId, id);
    });
  }

  reorderCategories(context, access, body) {
    const { ids } = MenuService.#reorderInput(body);
    return this.#write(context, access, 'reorderCategories', async (tx, tenantId) => {
      const categories = await this.#repository.categories(tx, tenantId);
      MenuService.#sameSet(categories.map((category) => category.id), ids);
      await this.#repository.setPositions(tx, 'menu_categories', tenantId, ids);
    });
  }

  reorderItems(context, access, categoryId, body) {
    const { ids } = MenuService.#reorderInput(body);
    return this.#write(context, access, 'reorderItems', async (tx, tenantId) => {
      MenuService.#category(await this.#repository.categories(tx, tenantId), categoryId);
      const items = await this.#repository.itemsIn(tx, tenantId, categoryId);
      MenuService.#sameSet(items.map((item) => item.id), ids);
      await this.#repository.setPositions(tx, 'menu_items', tenantId, ids);
    });
  }

  static #reorderInput(body) {
    const parsed = MenuModel.reorder.safeParse(body ?? {});
    // A list that isn't the current set is a stale screen, whatever its shape.
    if (!parsed.success) throw apiError('menu_changed', 'The menu changed on another device. It has been refreshed.');
    return parsed.data;
  }

  /** The full list of ids in the new order; anything else is a stale screen. */
  static #sameSet(current, ids) {
    const same = ids.length === current.length && new Set(ids).size === ids.length && current.every((id) => ids.includes(id));
    if (!same) throw apiError('menu_changed', 'The menu changed on another device. It has been refreshed.');
  }

  // ---------------------------------------------------------------- Stations

  createStation(context, access, body) {
    const { name } = parseOrThrow(MenuModel.station, body ?? {});
    return this.#write(context, access, 'createStation', async (tx, tenantId) => {
      if (!access.features.has('station_routing')) throw apiError('feature_locked', 'Sending slips to stations isn’t on your plan.');
      const stations = await this.#repository.stations(tx, tenantId);
      // The limit counts the main kitchen as one station.
      const limit = access.limits.stations ?? null;
      if (limit !== null && stations.length + 1 >= limit) {
        throw apiError('limit_reached', `Your plan allows ${limit} stations, the main kitchen included. Ask us about more.`);
      }
      if (sameName(name, 'Kitchen') || stations.some((station) => sameName(station.name, name))) throw STATION_TAKEN();
      await this.#repository.insertStation(tx, tenantId, name);
    });
  }

  renameStation(context, access, id, body) {
    const { name } = parseOrThrow(MenuModel.station, body ?? {});
    return this.#write(context, access, 'renameStation', async (tx, tenantId) => {
      const stations = await this.#repository.stations(tx, tenantId);
      if (!isUuid(id) || !stations.some((station) => station.id === id)) throw apiError('not_found', 'That station could not be found.');
      if (sameName(name, 'Kitchen') || stations.some((station) => station.id !== id && sameName(station.name, name))) throw STATION_TAKEN();
      await this.#repository.renameStation(tx, tenantId, id, name);
    });
  }

  /** Its categories go back to the main kitchen, so no slip is ever lost. */
  deleteStation(context, access, id) {
    return this.#write(context, access, 'deleteStation', async (tx, tenantId) => {
      const stations = await this.#repository.stations(tx, tenantId);
      if (!isUuid(id) || !stations.some((station) => station.id === id)) throw apiError('not_found', 'That station could not be found.');
      await this.#repository.deleteStation(tx, tenantId, id);
    });
  }

  // ---------------------------------------------------------------- Dishes

  /** A photo URL must be one this API issued for this restaurant. */
  #checkPhoto(tenantId, photoUrl) {
    if (photoUrl === null) return;
    const prefix = photoUrlPrefix(this.#supabaseUrl, tenantId);
    if (!photoUrl.startsWith(prefix) || !PHOTO_FILE.test(photoUrl.slice(prefix.length))) {
      throw fieldError({ photoUrl: 'Upload the photo again.' });
    }
  }

  static #checkSoldOut(soldOutUntil) {
    if (soldOutUntil !== null && Number.isNaN(Date.parse(soldOutUntil))) throw fieldError({ soldOutUntil: 'Choose when it is back.' });
    return soldOutUntil === null ? null : new Date(soldOutUntil);
  }

  createItem(context, access, body) {
    const input = parseOrThrow(MenuModel.item, body ?? {});
    this.#checkPhoto(context.actor.tenantId, input.photoUrl);
    const soldOutUntil = MenuService.#checkSoldOut(input.soldOutUntil);
    return this.#write(context, access, 'createItem', async (tx, tenantId) => {
      MenuService.#category(await this.#repository.categories(tx, tenantId), input.categoryId);
      await this.#repository.insertItem(tx, tenantId, { ...input, soldOutUntil }, context.now);
    });
  }

  /**
   * Edits a dish. The owner can change anything; staff and counters only whether it can
   * be ordered (sold out, available), even when the owner is locked out of setup changes.
   */
  updateItem(context, access, id, body = {}) {
    const keys = Object.keys(body ?? {});
    const ownerEdit = keys.some((key) => !MenuModel.AVAILABILITY_FIELDS.includes(key));
    if (ownerEdit && !can(context.actor.role, 'menu.edit')) {
      throw apiError('forbidden', 'Only the owner can change dishes and prices. You can mark them sold out.');
    }
    if (ownerEdit && access.setupLocked) throw apiError('account_paused', SETUP_LOCKED_MESSAGE);
    return this.#write(context, access, ownerEdit ? 'updateItem' : 'setAvailability', async (tx, tenantId) => {
      const item = isUuid(id) ? await this.#repository.findItem(tx, tenantId, id) : null;
      if (!item) throw apiError('not_found', 'That item could not be found.');
      const current = MenuModel.toItem(item);
      const input = parseOrThrow(MenuModel.item, {
        categoryId: current.categoryId, name: current.name, description: current.description, price: current.price,
        photoUrl: current.photoUrl, available: current.available, soldOutUntil: current.soldOutUntil, options: current.options,
        ...body,
      });
      if (input.photoUrl !== current.photoUrl) this.#checkPhoto(tenantId, input.photoUrl);
      const soldOutUntil = MenuService.#checkSoldOut(input.soldOutUntil);
      const moved = input.categoryId !== current.categoryId;
      if (moved) MenuService.#category(await this.#repository.categories(tx, tenantId), input.categoryId);
      await this.#repository.updateItem(tx, tenantId, id, { ...input, soldOutUntil }, { movedFrom: moved ? current.categoryId : null, now: context.now });
    });
  }

  deleteItem(context, access, id) {
    return this.#write(context, access, 'deleteItem', async (tx, tenantId) => {
      const item = isUuid(id) ? await this.#repository.findItem(tx, tenantId, id) : null;
      if (!item) throw apiError('not_found', 'That item could not be found.');
      await this.#repository.deleteItem(tx, tenantId, id, item.category_id);
    });
  }
}

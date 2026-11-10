// The restaurant's menu. Every query filters by the tenant from the verified credentials.
export class MenuRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  /** The whole menu in one round trip. */
  async findMenu(tenantId, sql = this.#sql) {
    const [row] = await sql`
      select
        coalesce((select json_agg(c order by c.position) from dinein.menu_categories c where c.tenant_id = ${tenantId}), '[]') as categories,
        coalesce((select json_agg(i order by i.position, i.name) from dinein.menu_items i where i.tenant_id = ${tenantId}), '[]') as items,
        coalesce((select json_agg(s order by s.position) from dinein.stations s where s.tenant_id = ${tenantId}), '[]') as stations,
        coalesce((select version from dinein.menu_versions where tenant_id = ${tenantId}), 1) as version`;
    return row;
  }

  /**
   * Moves the version on, so open diner pages and counters refresh. Run first in every
   * menu write: the row lock also queues two edits to the same menu one after the other.
   */
  async bumpVersion(tx, tenantId) {
    const [row] = await tx`
      insert into dinein.menu_versions (tenant_id, version) values (${tenantId}, 2)
      on conflict (tenant_id) do update set version = dinein.menu_versions.version + 1
      returning version`;
    return row.version;
  }

  // ---------------------------------------------------------------- Categories

  async categories(tx, tenantId) {
    return tx`select * from dinein.menu_categories where tenant_id = ${tenantId} order by position`;
  }

  async insertCategory(tx, tenantId, { name, stationId, schedule }) {
    await tx`insert into dinein.menu_categories (tenant_id, name, station_id, schedule, position)
      values (${tenantId}, ${name}, ${stationId}, ${schedule === null ? null : tx.json(schedule)},
        (select count(*) from dinein.menu_categories where tenant_id = ${tenantId}))`;
  }

  async updateCategory(tx, tenantId, id, { name, stationId, schedule }) {
    await tx`update dinein.menu_categories set name = ${name}, station_id = ${stationId},
      schedule = ${schedule === null ? null : tx.json(schedule)} where tenant_id = ${tenantId} and id = ${id}`;
  }

  async itemCount(tx, tenantId, categoryId) {
    const [row] = await tx`select count(*)::int as count from dinein.menu_items where tenant_id = ${tenantId} and category_id = ${categoryId}`;
    return row.count;
  }

  async deleteCategory(tx, tenantId, id) {
    await tx`delete from dinein.menu_categories where tenant_id = ${tenantId} and id = ${id}`;
    await this.#closeGaps(tx, 'menu_categories', tenantId);
  }

  /** Positions follow the order of `ids`, which the caller has checked is the full set. */
  async setPositions(tx, table, tenantId, ids) {
    await tx`update ${tx(`dinein.${table}`)} target set position = o.ord - 1
      from unnest(${ids}::uuid[]) with ordinality as o(id, ord)
      where target.tenant_id = ${tenantId} and target.id = o.id`;
  }

  /** Positions 0, 1, 2... again after a removal. Dishes are numbered within their category. */
  async #closeGaps(tx, table, tenantId, categoryId = null) {
    const inCategory = categoryId ? tx`and category_id = ${categoryId}` : tx``;
    await tx`update ${tx(`dinein.${table}`)} target set position = ranked.n - 1
      from (select id, row_number() over (order by position, id) as n from ${tx(`dinein.${table}`)}
        where tenant_id = ${tenantId} ${inCategory}) ranked
      where target.id = ranked.id and target.position <> ranked.n - 1`;
  }

  // ---------------------------------------------------------------- Stations

  async stations(tx, tenantId) {
    return tx`select * from dinein.stations where tenant_id = ${tenantId} order by position`;
  }

  async insertStation(tx, tenantId, name) {
    await tx`insert into dinein.stations (tenant_id, name, position)
      values (${tenantId}, ${name}, (select count(*) from dinein.stations where tenant_id = ${tenantId}))`;
  }

  async renameStation(tx, tenantId, id, name) {
    await tx`update dinein.stations set name = ${name} where tenant_id = ${tenantId} and id = ${id}`;
  }

  /** Its categories go back to the main kitchen (the foreign key sets station_id to null). */
  async deleteStation(tx, tenantId, id) {
    await tx`delete from dinein.stations where tenant_id = ${tenantId} and id = ${id}`;
    await this.#closeGaps(tx, 'stations', tenantId);
  }

  // ---------------------------------------------------------------- Items

  async findItem(tx, tenantId, id) {
    const [row] = await tx`select * from dinein.menu_items where tenant_id = ${tenantId} and id = ${id}`;
    return row ?? null;
  }

  async itemsIn(tx, tenantId, categoryId) {
    return tx`select id from dinein.menu_items where tenant_id = ${tenantId} and category_id = ${categoryId} order by position`;
  }

  async insertItem(tx, tenantId, item, now) {
    await tx`insert into dinein.menu_items (tenant_id, category_id, name, description, price, photo_url, available,
        sold_out_until, options, position, updated_at)
      values (${tenantId}, ${item.categoryId}, ${item.name}, ${item.description}, ${item.price}, ${item.photoUrl},
        ${item.available}, ${item.soldOutUntil}, ${tx.json(item.options)},
        (select count(*) from dinein.menu_items where tenant_id = ${tenantId} and category_id = ${item.categoryId}), ${now})`;
  }

  /** Moving to another category puts the dish at the end of it and closes the gap it left. */
  async updateItem(tx, tenantId, id, item, { movedFrom = null, now }) {
    await tx`update dinein.menu_items set category_id = ${item.categoryId}, name = ${item.name},
        description = ${item.description}, price = ${item.price}, photo_url = ${item.photoUrl}, available = ${item.available},
        sold_out_until = ${item.soldOutUntil}, options = ${tx.json(item.options)}, updated_at = ${now},
        position = case when ${movedFrom}::uuid is null then position
          else (select count(*) from dinein.menu_items where tenant_id = ${tenantId} and category_id = ${item.categoryId}) end
      where tenant_id = ${tenantId} and id = ${id}`;
    if (movedFrom) await this.#closeGaps(tx, 'menu_items', tenantId, movedFrom);
  }

  async deleteItem(tx, tenantId, id, categoryId) {
    await tx`delete from dinein.menu_items where tenant_id = ${tenantId} and id = ${id}`;
    await this.#closeGaps(tx, 'menu_items', tenantId, categoryId);
  }
}

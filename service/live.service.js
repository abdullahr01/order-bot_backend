import { randomUUID } from 'node:crypto';

/**
 * Live updates (guide 12.2, agreed 2026-11-14): the groups ("channels") and their
 * numbered news. A message only says what changed; the app then fetches as it does
 * today. Nothing here is trusted data.
 *
 * Channels: `branch:<id>` (counters and the portal's live screens) and `table:<id>`
 * (diner phones; the app sees it as "table"). Every message on a channel gets the next
 * number; pings carry the latest numbers, so an app that missed one knows to fetch.
 *
 * One server keeps the groups in memory. With 2+ servers, only `publish` needs to pass
 * through Postgres LISTEN/NOTIFY; the services calling this class don't change.
 */
export class LiveHub {
  /** A new id on every start: an app seeing a different one fetches everything. */
  epoch = randomUUID();
  #seq = new Map();
  #channels = new Map();
  #tenants = new Map();

  get size() { return [...this.#tenants.values()].reduce((sum, set) => sum + set.size, 0); }

  /** client: { tenantId, branchId?, tableId?, deviceId?, userId?, channels, send(message), close(code, reason) } */
  add(client) {
    for (const channel of client.channels) {
      if (!this.#channels.has(channel)) this.#channels.set(channel, new Set());
      this.#channels.get(channel).add(client);
    }
    if (!this.#tenants.has(client.tenantId)) this.#tenants.set(client.tenantId, new Set());
    this.#tenants.get(client.tenantId).add(client);
  }

  remove(client) {
    for (const channel of client.channels) {
      const set = this.#channels.get(channel);
      set?.delete(client);
      if (set?.size === 0) this.#channels.delete(channel);
    }
    const tenant = this.#tenants.get(client.tenantId);
    tenant?.delete(client);
    if (tenant?.size === 0) this.#tenants.delete(client.tenantId);
  }

  /** The latest number of each of this client's channels, by the name the app sees. */
  numbers(client) {
    return Object.fromEntries(client.channels.map((channel) => [LiveHub.label(channel), this.#seq.get(channel) ?? 0]));
  }

  static label(channel) { return channel.startsWith('table:') ? 'table' : channel; }

  publish(channel, event, data = {}) {
    const seq = (this.#seq.get(channel) ?? 0) + 1;
    this.#seq.set(channel, seq);
    for (const client of this.#channels.get(channel) ?? []) {
      client.send({ type: 'event', channel: LiveHub.label(channel), seq, event, ...data });
    }
  }

  /** Every channel someone of this restaurant is listening on (optionally only diners at one branch). */
  #tenantChannels(tenantId, { branchId = null, diners = true, staff = true } = {}) {
    const channels = new Set();
    for (const client of this.#tenants.get(tenantId) ?? []) {
      for (const channel of client.channels) {
        const table = channel.startsWith('table:');
        if (table && !diners) continue;
        if (!table && !staff) continue;
        if (branchId && (table ? client.branchId !== branchId : channel !== `branch:${branchId}`)) continue;
        channels.add(channel);
      }
    }
    return channels;
  }

  #closeWhere(match, code, reason) {
    for (const set of this.#tenants.values()) {
      for (const client of [...set]) if (match(client)) client.close(code, reason);
    }
  }

  // ---------------------------------------------------------------- What the services announce

  /** A new order: the counter's lists, and the table's bill. */
  orderCreated({ branchId, tableId, orderId }) {
    this.publish(`branch:${branchId}`, 'order.created', { orderId });
    if (tableId) this.publish(`table:${tableId}`, 'bill.updated');
  }

  /** Accepted, served or cancelled. */
  orderUpdated({ branchId, tableId, orderId }) {
    this.publish(`branch:${branchId}`, 'order.updated', { orderId });
    if (tableId) this.publish(`table:${tableId}`, 'bill.updated');
  }

  /** A table opened, settled or closed; tables or waiters changed. */
  sessionUpdated({ branchId, tableId = null }) {
    this.publish(`branch:${branchId}`, 'session.updated');
    if (tableId) this.publish(`table:${tableId}`, 'bill.updated');
  }

  requestCreated({ branchId, tableId, requestId = null }) {
    this.publish(`branch:${branchId}`, 'request.created', requestId ? { requestId } : {});
    if (tableId) this.publish(`table:${tableId}`, 'bill.updated');
  }

  requestHandled({ branchId, tableId, requestId }) {
    this.publish(`branch:${branchId}`, 'request.handled', { requestId });
    if (tableId) this.publish(`table:${tableId}`, 'bill.updated');
  }

  /** Dishes, prices, sold out: everyone of the restaurant, with the menu's new version. */
  menuUpdated({ tenantId, version }) {
    for (const channel of this.#tenantChannels(tenantId)) this.publish(channel, 'menu.updated', { version });
  }

  /** Opening hours or a pause: one branch, or all of them. Diners' pages show it too. */
  serviceUpdated({ tenantId, branchId = null }) {
    for (const channel of this.#tenantChannels(tenantId, { branchId })) this.publish(channel, 'service.updated');
  }

  /** Tables or waiters added or removed: the counters' floor. */
  setupChanged({ tenantId }) {
    for (const channel of this.#tenantChannels(tenantId, { diners: false })) this.publish(channel, 'session.updated');
  }

  /** Plan, status, add-ons, overrides or payment: what the restaurant may do changed. Cancelled: lines close. */
  tenantChanged(tenantId, { cancelled = false } = {}) {
    for (const channel of this.#tenantChannels(tenantId)) this.publish(channel, 'account.updated');
    if (cancelled) this.#closeWhere((client) => client.tenantId === tenantId, 4401, 'account_cancelled');
  }

  /** A table's QR code was replaced or the table retired: phones on the old code are cut off. */
  tableRetired({ tenantId, tableId }) {
    this.#closeWhere((client) => client.tenantId === tenantId && client.tableId === tableId, 4401, 'table_not_found');
  }

  /** A counter PC unpaired. */
  deviceRemoved({ tenantId, deviceId }) {
    this.#closeWhere((client) => client.tenantId === tenantId && client.deviceId === deviceId, 4401, 'device_revoked');
  }

  /** A person removed from the team. */
  userRemoved({ tenantId, userId }) {
    this.#closeWhere((client) => client.tenantId === tenantId && client.userId === userId, 4401, 'account_removed');
  }
}

/** For callers without live updates (scripts): every announcement does nothing. */
export const NO_LIVE = Object.freeze(Object.fromEntries([
  'orderCreated', 'orderUpdated', 'sessionUpdated', 'requestCreated', 'requestHandled', 'menuUpdated',
  'serviceUpdated', 'setupChanged', 'tenantChanged', 'tableRetired', 'deviceRemoved', 'userRemoved',
].map((name) => [name, () => {}])));

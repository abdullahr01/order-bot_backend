import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { WebSocketServer } from 'ws';
import { ApiError } from '../shared/api-error.js';
import { isUuid } from '../shared/validation.js';

export const LIVE_PATH = '/live';
const HELLO_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD = 4 * 1024;
const MAX_BUFFERED = 256 * 1024;
const MAX_WAIT_MS = 2 ** 31 - 1;

/** Close codes the apps act on (documented in FRONTEND_INTEGRATION.md). */
export const CLOSE = Object.freeze({
  restarting: 1012, badHello: 4400, unauthorized: 4401, forbidden: 4403, helloTimeout: 4408, tooMany: 4429, internal: 1011,
});

const helloError = (code, message) => Object.assign(new Error(message), { liveCode: code });
const text = (value, max = 4096) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

/**
 * The live line: `wss://<api>/live`. The app's first message signs it in with what it
 * already has (never in the URL, which ends up in logs):
 *   {"type":"hello","app":"counter","deviceToken":"..."}
 *   {"type":"hello","app":"portal","accessToken":"...","branchId":"...optional"}
 *   {"type":"hello","app":"diner","tableToken":"..."}
 * The server answers {"type":"ready","epoch","seq"}, then sends events and a ping every
 * 15 seconds with the latest numbers. Apps never send anything else.
 */
export class LiveController {
  #hub;
  #auth;
  #tables;
  #branches;
  #logger;
  #origins;
  #trustProxyHops;
  #pingMs;
  #maxPerIp;
  #helloTimeoutMs;
  #wss = null;
  #timer = null;
  #perIp = new Map();
  #sockets = new Set();

  constructor({ hub, auth, tables, branches, logger, origins = [], trustProxyHops = 0, pingMs = 15_000, maxPerIp = 200, helloTimeoutMs = HELLO_TIMEOUT_MS }) {
    this.#hub = hub;
    this.#auth = auth;
    this.#tables = tables;
    this.#branches = branches;
    this.#logger = logger.child({ module: 'Live' });
    this.#origins = new Set(origins);
    this.#trustProxyHops = trustProxyHops;
    this.#pingMs = pingMs;
    this.#maxPerIp = maxPerIp;
    this.#helloTimeoutMs = helloTimeoutMs;
  }

  /** Adds the live line to an HTTP server; any other upgrade path is refused. */
  attach(server) {
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => this.#upgrade(request, socket, head));
    this.#timer = setInterval(() => this.#heartbeat(), this.#pingMs);
    this.#timer.unref?.();
    this.#logger.info({ operation: 'attach', path: LIVE_PATH }, 'Live updates ready');
  }

  #refuse(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  #clientIp(request) {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    if (this.#trustProxyHops > 0 && forwarded.length) return forwarded[Math.max(0, forwarded.length - this.#trustProxyHops)];
    return request.socket.remoteAddress ?? 'unknown';
  }

  #upgrade(request, socket, head) {
    let path;
    try { path = new URL(request.url, 'http://localhost').pathname; } catch { path = ''; }
    if (path !== LIVE_PATH) return this.#refuse(socket, 404, 'Not Found');
    // Browsers send their page's address; only the apps' own may connect. Other clients send none.
    const origin = request.headers.origin;
    if (origin && this.#origins.size && !this.#origins.has(origin)) {
      this.#logger.info({ operation: 'upgrade' }, 'Live line refused: unknown origin');
      return this.#refuse(socket, 403, 'Forbidden');
    }
    const ip = this.#clientIp(request);
    if ((this.#perIp.get(ip) ?? 0) >= this.#maxPerIp) {
      this.#logger.info({ operation: 'upgrade' }, 'Live line refused: too many from one address');
      return this.#refuse(socket, 429, 'Too Many Requests');
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#open(ws, ip));
  }

  #open(ws, ip) {
    this.#perIp.set(ip, (this.#perIp.get(ip) ?? 0) + 1);
    this.#sockets.add(ws);
    const log = this.#logger.child({ connectionId: randomUUID().slice(0, 8) });
    const state = { alive: true, client: null, pending: false, expiry: null };
    ws.liveState = state;
    log.info({ operation: 'open' }, 'Live line opened; waiting for hello');

    const close = (code, reason) => { if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason); };
    const helloTimer = setTimeout(() => close(CLOSE.helloTimeout, 'hello_timeout'), this.#helloTimeoutMs);

    ws.on('pong', () => { state.alive = true; });
    ws.on('error', () => {});
    ws.on('message', async (data, isBinary) => {
      if (state.client || state.pending) return close(CLOSE.badHello, 'unexpected_message');
      state.pending = true;
      clearTimeout(helloTimer);
      try {
        let message;
        try { message = isBinary ? null : JSON.parse(data.toString('utf8')); } catch { message = null; }
        if (!message || message.type !== 'hello') throw helloError(CLOSE.badHello, 'bad_hello');
        const identity = await this.#identify(message, log);
        if (ws.readyState !== ws.OPEN) return;
        const client = {
          ...identity,
          send: (payload) => {
            if (ws.readyState !== ws.OPEN) return;
            // A phone that stopped reading would make the server hold its messages: cut it off instead.
            if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate();
            ws.send(JSON.stringify(payload));
          },
          close,
        };
        state.client = client;
        this.#hub.add(client);
        if (identity.expiresAt) {
          state.expiry = setTimeout(() => close(CLOSE.unauthorized, 'session_expired'), Math.min(Math.max(identity.expiresAt - Date.now(), 0), MAX_WAIT_MS));
          state.expiry.unref?.();
        }
        client.send({ type: 'ready', epoch: this.#hub.epoch, seq: this.#hub.numbers(client), pingSeconds: Math.round(this.#pingMs / 1000) });
        log.success({ operation: 'hello', app: identity.app, tenantId: identity.tenantId, channels: identity.channels.length }, 'Live line signed in');
      } catch (error) {
        const code = error.liveCode ?? (error instanceof ApiError ? (error.code === 'forbidden' ? CLOSE.forbidden : CLOSE.unauthorized) : CLOSE.internal);
        const reason = error.liveCode ? error.message : error instanceof ApiError ? error.code : 'server_error';
        if (code === CLOSE.internal) log.error({ operation: 'hello', err: error }, 'Live hello failed');
        else log.info({ operation: 'hello', reason }, 'Live hello refused');
        close(code, reason);
      }
    });

    ws.on('close', (code) => {
      clearTimeout(helloTimer);
      clearTimeout(state.expiry);
      if (state.client) this.#hub.remove(state.client);
      this.#sockets.delete(ws);
      const left = (this.#perIp.get(ip) ?? 1) - 1;
      if (left > 0) this.#perIp.set(ip, left); else this.#perIp.delete(ip);
      log.info({ operation: 'close', code, app: state.client?.app ?? null }, 'Live line closed');
    });
  }

  /** Who is on the line, and which groups they hear. Uses the same checks as the HTTP API. */
  async #identify(message, log) {
    if (message.app === 'counter') {
      const token = text(message.deviceToken, 200);
      if (!token) throw helloError(CLOSE.badHello, 'bad_hello');
      const actor = await this.#auth.authenticateDevice({ 'x-counter-device': token }, log);
      return { app: 'counter', tenantId: actor.tenantId, branchId: actor.branchId, deviceId: actor.deviceId, channels: [`branch:${actor.branchId}`] };
    }
    if (message.app === 'portal') {
      const token = text(message.accessToken);
      if (!token) throw helloError(CLOSE.badHello, 'bad_hello');
      const actor = await this.#auth.authenticatePortal({ authorization: `Bearer ${token}` }, log);
      const visible = (await this.#branches.visibleBranches(actor.tenantId, actor.branchId ?? null)).map((branch) => branch.id);
      let branchIds = visible;
      if (message.branchId !== undefined && message.branchId !== null) {
        if (!isUuid(message.branchId) || !visible.includes(message.branchId)) throw helloError(CLOSE.forbidden, 'branch_not_found');
        branchIds = [message.branchId];
      }
      const { exp } = decodeJwt(token);
      return {
        app: 'portal', tenantId: actor.tenantId, userId: actor.userId, channels: branchIds.map((id) => `branch:${id}`),
        expiresAt: Number.isInteger(exp) ? exp * 1000 : null,
      };
    }
    if (message.app === 'diner') {
      const token = text(message.tableToken, 100);
      const row = token ? await this.#tables.tableByToken(token) : null;
      if (!row) throw helloError(CLOSE.unauthorized, 'table_not_found');
      return { app: 'diner', tenantId: row.tenant_id, branchId: row.branch_id, tableId: row.id, channels: [`table:${row.id}`] };
    }
    throw helloError(CLOSE.badHello, 'bad_hello');
  }

  /** Every 15 seconds: drop lines that stopped answering, and ping the rest with the latest numbers. */
  #heartbeat() {
    for (const ws of this.#sockets) {
      const state = ws.liveState;
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      try { ws.ping(); } catch { /* closing */ }
      if (state.client) state.client.send({ type: 'ping', epoch: this.#hub.epoch, seq: this.#hub.numbers(state.client) });
    }
  }

  get connections() { return this.#sockets.size; }

  /** On shutdown: tell every app to reconnect (to the new server), then let go. */
  async close() {
    clearInterval(this.#timer);
    if (!this.#wss) return;
    for (const ws of this.#sockets) ws.close(CLOSE.restarting, 'restarting');
    const deadline = Date.now() + 2_000;
    while (this.#sockets.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    for (const ws of this.#sockets) ws.terminate();
    await new Promise((resolve) => this.#wss.close(() => resolve()));
    this.#logger.info({ operation: 'close' }, 'Live updates stopped');
  }
}

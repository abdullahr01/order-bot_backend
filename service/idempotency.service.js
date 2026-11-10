import { createHash } from 'node:crypto';
import { isUniqueViolation } from '../db/database.js';
import { apiError } from '../shared/error-codes.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY = /^[\x21-\x7e]{8,200}$/;

/**
 * Idempotency-Key (guide §16, agreed 2026-11-10) for the counter's manual order and table
 * close. The same key with the same request within 24 hours gets the first answer again
 * instead of doing the work twice. Without the header, requests work as usual.
 */
export class IdempotencyService {
  #database;
  #repository;

  constructor({ database, repository }) {
    this.#database = database;
    this.#repository = repository;
  }

  /** The header, checked. Undefined when the app didn't send one. */
  static key(request) {
    const key = request.get('idempotency-key');
    if (key === undefined) return undefined;
    if (!KEY.test(key)) throw apiError('bad_request', 'Idempotency-Key must be 8 to 200 visible characters.');
    return key;
  }

  /**
   * Runs `work(tx)` in one transaction and stores its answer with the key. A retry that
   * arrives while the first is still running waits for it, then gets the same answer.
   */
  async run({ actor, log, now }, { key, method, path, body }, work) {
    if (key === undefined) return this.#database.withTx(work, { logger: log });
    const scope = {
      tenantId: actor.tenantId,
      caller: actor.deviceId ? `device:${actor.deviceId}` : `user:${actor.userId}`,
      key,
      since: new Date(now.getTime() - DAY_MS),
    };
    const requestHash = createHash('sha256').update(`${method} ${path} ${JSON.stringify(body ?? {})}`).digest('hex');
    const replay = (saved) => {
      if (saved.request_hash !== requestHash) throw apiError('bad_request', 'This Idempotency-Key was used for a different request.');
      log.info({ tenantId: actor.tenantId }, 'Repeated request: replaying the first answer');
      return saved.response;
    };

    try {
      return await this.#database.withTx(async (tx) => {
        await this.#repository.lock(tx, scope);
        const saved = await this.#repository.find(tx, scope);
        if (saved) return replay(saved);
        const response = await work(tx);
        await this.#repository.save(tx, { ...scope, requestHash, response, now });
        return response;
      }, { logger: log });
    } catch (error) {
      // Two copies at once: the first committed; answer this one with its result.
      if (!isUniqueViolation(error, 'idempotency_keys_pkey')) throw error;
      const saved = await this.#database.withTx((tx) => this.#repository.find(tx, scope), { logger: log });
      if (!saved) throw error;
      return replay(saved);
    }
  }
}

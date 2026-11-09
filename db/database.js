import postgres from 'postgres';
import baseLogger from '../shared/logger.js';
import { databaseConfig } from './config.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This connection is not limited by RLS: every query must filter by the
// tenant/branch taken from the verified credentials.
export class Database {
  #sql;
  #logger;

  constructor({ env = process.env, logger = baseLogger } = {}) {
    const config = databaseConfig(env);
    this.#sql = postgres(config.url, config.options);
    this.#logger = logger.child({ module: 'Database' });
  }

  get sql() { return this.#sql; }

  async withTx(work, { logger = this.#logger } = {}) {
    if (typeof work !== 'function') throw new TypeError('A transaction callback is required.');
    const log = logger.child({ module: 'Database', operation: 'transaction' });
    const started = performance.now();
    log.info('Starting database transaction');
    try {
      const result = await this.#sql.begin(async (tx) => {
        await tx`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '5000', true)`;
        return work(tx);
      });
      log.success({ durationMs: Math.round(performance.now() - started) }, 'Database transaction committed');
      return result;
    } catch (error) {
      log.error({ err: error, durationMs: Math.round(performance.now() - started) }, 'Database transaction failed and was rolled back');
      throw error;
    }
  }

  async close() { await this.#sql.end({ timeout: 5 }); }
}

// Must receive the transaction used for the order insert. No second connection.
export async function allocateOrderNumber(tx, tenantId) {
  if (!uuid.test(tenantId || '')) throw new TypeError('A valid tenantId is required.');
  const [counter] = await tx`
    insert into dinein.order_counters (tenant_id, day, last_number)
    select id, (transaction_timestamp() at time zone timezone)::date, 1200
    from dinein.tenants where id = ${tenantId}
    on conflict (tenant_id, day) do update set last_number = dinein.order_counters.last_number + 1
    returning day::text as day, last_number as number`;
  if (!counter) throw new Error('Restaurant was not found.');
  return counter;
}

// Remembered answers for Idempotency-Key, per restaurant and caller, for 24 hours.
export class IdempotencyRepository {
  /** Holds back a second copy of the same request until the first has committed. */
  async lock(tx, { tenantId, caller, key }) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}|${caller}|${key}`}, 0))`;
  }

  async find(tx, { tenantId, caller, key, since }) {
    const [row] = await tx`select request_hash, response from dinein.idempotency_keys
      where tenant_id = ${tenantId} and caller = ${caller} and key = ${key} and created_at > ${since}`;
    return row ?? null;
  }

  /** An expired row with the same key is replaced; a live one makes the insert fail (a race). */
  async save(tx, { tenantId, caller, key, requestHash, response, since, now }) {
    await tx`delete from dinein.idempotency_keys where tenant_id = ${tenantId} and caller = ${caller} and key = ${key} and created_at <= ${since}`;
    await tx`insert into dinein.idempotency_keys (tenant_id, caller, key, request_hash, response, created_at)
      values (${tenantId}, ${caller}, ${key}, ${requestHash}, ${tx.json(response)}, ${now})`;
  }
}

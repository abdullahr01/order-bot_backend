// Partner companies (UK) and what they owe us. No create endpoint, as in core.
export class PartnerRepository {
  #sql;

  constructor(sql) { this.#sql = sql; }

  async list(partnerId = null) {
    return this.#sql`select * from dinein.partners where (${partnerId}::uuid is null or id = ${partnerId}::uuid) order by lower(name)`;
  }

  async find(id, sql = this.#sql) {
    const [row] = await sql`select * from dinein.partners where id = ${id}`;
    return row ?? null;
  }

  async lock(tx, id) {
    const [row] = await tx`select * from dinein.partners where id = ${id} for update`;
    return row ?? null;
  }

  /** Their restaurants, the fees each paid per month, and our share received per month. */
  async statementData(partnerId, sql = this.#sql) {
    const [row] = await sql`
      select
        coalesce((select json_agg(t order by t.created_at) from (
          select id, business_name, created_at, timezone from dinein.tenants where partner_id = ${partnerId}) t), '[]') as tenants,
        coalesce((select json_agg(p) from (
          select p.tenant_id, to_char(p.month, 'YYYY-MM') as month, sum(p.amount)::int as amount
          from dinein.payments p join dinein.tenants t on t.id = p.tenant_id
          where t.partner_id = ${partnerId} group by 1, 2) p), '[]') as fees,
        coalesce((select json_agg(s) from (
          select to_char(month, 'YYYY-MM') as month, amount::float8 as amount, reference, received_at, recorded_by
          from dinein.partner_settlements where partner_id = ${partnerId}) s), '[]') as settlements`;
    return row;
  }

  async update(tx, id, { sharePercent, paymentDay }) {
    await tx`update dinein.partners set share_percent = ${sharePercent}, payment_day = ${paymentDay} where id = ${id}`;
  }

  async recordSettlement(tx, { partnerId, month, amount, reference, recordedBy, now }) {
    await tx`insert into dinein.partner_settlements (partner_id, month, amount, reference, received_at, recorded_by)
      values (${partnerId}, ${`${month}-01`}::date, ${amount}, ${reference}, ${now}, ${recordedBy})`;
  }
}

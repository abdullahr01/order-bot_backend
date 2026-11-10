// Plan, status and fee writes. Always called inside a transaction that has locked
// the restaurant with TenantRepository.lockForWrite.
export class SubscriptionRepository {
  async schedulePlan(tx, tenantId, planId) {
    await tx`update dinein.subscriptions set scheduled_plan_id = ${planId} where tenant_id = ${tenantId}`;
  }

  /** Applies a plan now. Add-ons the new plan doesn't offer stop at once. */
  async applyPlan(tx, tenantId, planId, endingAddonIds, now) {
    await tx`update dinein.subscriptions set plan_id = ${planId}, scheduled_plan_id = null where tenant_id = ${tenantId}`;
    if (endingAddonIds.length) {
      await tx`update dinein.tenant_addons set cancels_at = ${now}
        where tenant_id = ${tenantId} and addon_id = any(${endingAddonIds}::text[]) and cancels_at is null`;
    }
  }

  async cancelScheduled(tx, tenantId) {
    await tx`update dinein.subscriptions set scheduled_plan_id = null where tenant_id = ${tenantId}`;
  }

  /** Guide 9.3: past due starts the ladder, suspended keeps it, anything else clears it. */
  async setStatus(tx, tenantId, status, now) {
    await tx`
      update dinein.subscriptions set
        status = ${status}::text,
        past_due_since = case when ${status}::text = 'past_due' then ${now}::timestamptz
          when ${status}::text = 'suspended' then past_due_since else null end,
        trial_ends_at = case when ${status}::text = 'trial' then trial_ends_at else null end,
        billing_starts_at = case when ${status}::text = 'active' then coalesce(billing_starts_at, ${now}::timestamptz) else billing_starts_at end
      where tenant_id = ${tenantId}`;
  }

  /**
   * A suspended or cancelled restaurant serves nobody, so nothing may be left open:
   * open orders are cancelled and open tables closed by "System" (the founders' rule,
   * 2026-11-10). They appear in the void log with the reason.
   */
  async stopService(tx, tenantId, { reason, now }) {
    const history = tx.json([{ status: 'cancelled', at: now.toISOString() }]);
    const orders = await tx`
      update dinein.orders set status = 'cancelled', cancel_reason = ${reason}, cancelled_by = 'System',
        finished_at = ${now}, history = history || ${history}
      where tenant_id = ${tenantId} and status in ('new', 'accepted')
      returning id`;
    const tables = await tx`
      update dinein.table_sessions set status = 'closed', closed_at = ${now}, closed_as = 'force_closed',
        closed_by = 'System', close_reason = ${reason}
      where tenant_id = ${tenantId} and status <> 'closed'
      returning id`;
    await tx`update dinein.service_requests set handled_at = ${now}, handled_by = 'System'
      where tenant_id = ${tenantId} and handled_at is null`;
    return { orders: orders.length, tables: tables.length };
  }

  async paymentExists(tx, tenantId, kind, month) {
    const [row] = kind === 'setup'
      ? await tx`select exists (select 1 from dinein.payments where tenant_id = ${tenantId} and kind = 'setup') as found`
      : await tx`select exists (select 1 from dinein.payments where tenant_id = ${tenantId} and kind = 'monthly' and month = ${`${month}-01`}::date) as found`;
    return row.found;
  }

  async insertPayment(tx, { tenantId, kind, month, amount, method, reference, recordedBy, now }) {
    await tx`insert into dinein.payments (tenant_id, kind, month, amount, method, reference, recorded_by, recorded_at)
      values (${tenantId}, ${kind}, ${`${month}-01`}::date, ${amount}, ${method}, ${reference}, ${recordedBy}, ${now})`;
  }

  /** Live add-ons (not ending), for working out which a new plan drops. */
  async liveAddons(tx, tenantId, now) {
    return tx`select addon_id, quantity, activated_at, cancels_at from dinein.tenant_addons
      where tenant_id = ${tenantId} and (cancels_at is null or cancels_at > ${now})`;
  }
}

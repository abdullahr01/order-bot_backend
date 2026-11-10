// The audit log as the console shows it (core's EntitlementEvent).
export class EventModel {
  static toEvent(row) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name ?? '',
      action: row.action,
      featureKey: row.feature_key,
      actor: row.actor,
      before: row.before,
      after: row.after,
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.country ? { country: row.country } : {}),
    };
  }
}

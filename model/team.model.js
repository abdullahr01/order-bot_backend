// Validation ported from the partner's packages/core/src/schemas. Keep the two in step.
import { z } from 'zod';

const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

export class TeamModel {
  static member = z.object({
    name: z.string().trim().min(2, 'Enter their name').max(60),
    email: z.email('Enter a valid email address').trim().toLowerCase(),
    branchId: z.string().min(1, 'Choose their branch'),
  });

  /** `has_pin` comes from a join on counter_pins; the PIN itself never leaves the server. */
  static toMember(row) {
    return {
      id: row.id, tenantId: row.tenant_id, name: row.name, email: row.email, role: row.role, branchId: row.branch_id,
      hasPin: Boolean(row.has_pin), lastSignInAt: iso(row.last_sign_in_at), createdAt: iso(row.created_at),
    };
  }
}

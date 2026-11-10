// Validation ported from the partner's packages/core/src/schemas. Keep the two in step.
import { z } from 'zod';
import { MIN_REASON_LENGTH } from '../shared/rules/subscriptions.js';

const iso = (value) => new Date(value).toISOString();

export class BranchModel {
  static input = z.object({
    name: z.string().trim().min(2, 'Name the branch, e.g. “Blue Area”').max(60),
    area: z.string().trim().min(2, 'Add the area or address').max(120),
    reason: z.string().trim().min(MIN_REASON_LENGTH, 'Add a short reason. It is saved in the audit log.'),
  });

  static toBranch(row) {
    return { id: row.id, tenantId: row.tenant_id, name: row.name, area: row.area, isMain: row.is_main, createdAt: iso(row.created_at) };
  }
}

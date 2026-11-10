import { z } from 'zod';
import { ADMIN_ROLES } from '../shared/rules/constants.js';
import { COUNTRIES } from '../shared/rules/region.js';

export class AuthModel {
  /** app_metadata.admin_scope on a platform-team token. A partner must name their company. */
  static adminScope = z.object({
    role: z.enum(ADMIN_ROLES),
    countries: z.array(z.enum(COUNTRIES)).min(1),
    partnerId: z.uuid().nullable().default(null),
  }).refine((scope) => scope.role !== 'partner' || scope.partnerId !== null);
}

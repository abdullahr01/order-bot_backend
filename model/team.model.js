// Validation ported from the partner's packages/core/src/schemas. Keep the two in step.
import { z } from 'zod';

export class TeamModel {
  static member = z.object({
    name: z.string().trim().min(2, 'Enter their name').max(60),
    email: z.email('Enter a valid email address').trim().toLowerCase(),
    branchId: z.string().min(1, 'Choose their branch'),
  });
}

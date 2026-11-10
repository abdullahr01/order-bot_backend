// Validation ported from the partner's packages/core/src/schemas. Keep the two in step.
import { z } from 'zod';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 12:00');

export class ServiceSettingsModel {
  static settings = z.object({
    hours: z.array(z.object({ day: z.number().int().min(0).max(6), open: z.boolean(), opensAt: time, closesAt: time }))
      .length(7, 'Set hours for every day')
      .refine((days) => new Set(days.map((day) => day.day)).size === 7, 'Set hours for every day'),
    pausedUntil: z.string().nullable(),
  });
}

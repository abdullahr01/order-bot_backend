// Validation ported from the partner's packages/core/src/schemas. Keep the two in step.
import { z } from 'zod';

const NAME_MAX = 60;
const DESCRIPTION_MAX = 200;
const PRICE_MAX = 100_000;
const OPTION_GROUPS_MAX = 5;
const OPTION_CHOICES_MAX = 12;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 07:00');
const optionName = z.string().trim().min(1, 'Give it a name').max(30, 'Keep it under 30 characters');

const schedule = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1, 'Choose at least one day'),
  from: clock,
  to: clock,
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date').nullable(),
}).refine((value) => value.from !== value.to, { message: 'Start and end can’t be the same time', path: ['to'] });

const optionGroup = z.object({
  id: z.string().min(1).max(40),
  name: optionName,
  kind: z.enum(['one', 'extra']),
  choices: z.array(z.object({
    id: z.string().min(1).max(40),
    name: optionName,
    price: z.coerce.number({ message: 'Enter a price' }).int('Whole numbers only').min(0, 'Can’t be below 0').max(PRICE_MAX, 'That price looks too high'),
  })).min(1, 'Add at least one choice').max(OPTION_CHOICES_MAX, `Up to ${OPTION_CHOICES_MAX} choices`),
}).refine((group) => group.kind === 'extra' || group.choices.length >= 2, { message: '“Pick one” needs at least two choices', path: ['choices'] });

function uniqueIds(groups) {
  const ids = groups.flatMap((group) => [group.id, ...group.choices.map((choice) => choice.id)]);
  return new Set(ids).size === ids.length;
}

const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

export class MenuModel {
  /** What branch staff and counters may change on a dish: whether it can be ordered today. */
  static AVAILABILITY_FIELDS = Object.freeze(['available', 'soldOutUntil']);

  /** A data URL from the portal: the photo's type and its base64 contents. */
  static PHOTO_DATA_URL = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/;

  static schedule = schedule;

  static reorder = z.object({ ids: z.array(z.string()).max(1000) });

  static toCategory(row) {
    return { id: row.id, tenantId: row.tenant_id, name: row.name, position: row.position, stationId: row.station_id, schedule: row.schedule ?? null };
  }

  static toStation(row) {
    return { id: row.id, tenantId: row.tenant_id, name: row.name, position: row.position };
  }

  static toItem(row) {
    return {
      id: row.id, tenantId: row.tenant_id, categoryId: row.category_id, name: row.name, description: row.description ?? '',
      price: row.price, photoUrl: row.photo_url, available: row.available, soldOutUntil: iso(row.sold_out_until),
      position: row.position, options: row.options ?? [], updatedAt: iso(row.updated_at),
    };
  }

  static category = z.object({
    name: z.string().trim().min(2, 'Give the category a name').max(40, 'Keep it under 40 characters'),
    stationId: z.string().nullable().default(null),
    schedule: schedule.nullable().default(null),
  });

  static station = z.object({
    name: z.string().trim().min(2, 'Give the station a name').max(30, 'Keep it under 30 characters'),
  });

  static optionGroup = optionGroup;

  static item = z.object({
    categoryId: z.string().min(1, 'Choose a category'),
    name: z.string().trim().min(2, 'Give the dish a name').max(NAME_MAX, `Keep it under ${NAME_MAX} characters`),
    description: z.string().trim().max(DESCRIPTION_MAX, `Keep it under ${DESCRIPTION_MAX} characters`),
    price: z.coerce.number({ message: 'Enter a price' }).int('Whole numbers only').min(1, 'Enter a price').max(PRICE_MAX, 'That price looks too high'),
    photoUrl: z.string().nullable(),
    available: z.boolean(),
    soldOutUntil: z.string().nullable(),
    options: z.array(optionGroup).max(OPTION_GROUPS_MAX, `Up to ${OPTION_GROUPS_MAX} sets of options`).default([]).refine(uniqueIds, 'Each option needs its own id'),
  });
}

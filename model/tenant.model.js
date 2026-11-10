// Validation ported from the partner's packages/core/src/schemas. Keep the two in step.
import { z } from 'zod';
import { ADDON_IDS, PLAN_IDS } from '../shared/rules/plans.js';
import { COUNTRIES, isMobile, isOpen, REGIONS } from '../shared/rules/region.js';
import { MIN_REASON_LENGTH, TRIAL_DAYS } from '../shared/rules/subscriptions.js';

function checkPhone(value, issue) {
  if (value.ownerPhone && !isMobile(value.ownerPhone, value.country)) {
    issue.addIssue({
      code: 'custom', path: ['ownerPhone'],
      message: `Enter a ${value.country === 'GB' ? 'UK' : 'Pakistani'} mobile number, e.g. ${REGIONS[value.country].phone.example}`,
    });
  }
}

const detailFields = z.object({
  businessName: z.string().trim().min(2, 'Enter the business name').max(80, 'Keep it under 80 characters'),
  city: z.string().trim().min(2, 'Choose a city'),
  ownerName: z.string().trim().min(2, 'Enter the owner’s name').max(80),
  ownerPhone: z.string().trim().min(1, 'Enter the owner’s mobile number'),
  ownerEmail: z.email('Enter a valid email address').trim().toLowerCase(),
  country: z.enum(COUNTRIES, 'Choose a country').refine(isOpen, 'Restaurants in this country can’t be added yet.'),
});

const planSelection = z.object({
  planId: z.enum(PLAN_IDS, 'Choose a plan'),
  startAs: z.enum(['trial', 'active']),
  trialDays: z.literal([...TRIAL_DAYS], 'Choose a trial length'),
  addons: z.array(z.object({ addonId: z.enum(ADDON_IDS), quantity: z.number().int().min(1).max(200) })).max(ADDON_IDS.length),
});

export class TenantModel {
  static details = detailFields.superRefine(checkPhone);

  static planSelection = planSelection;

  /** The phone is checked by the service against the restaurant's own country. */
  static update = detailFields
    .pick({ businessName: true, city: true, ownerName: true, ownerPhone: true, ownerEmail: true })
    .extend({ reason: z.string().trim().min(MIN_REASON_LENGTH, 'Add a short reason. It is saved in the audit log.') });

  static create = detailFields.extend(planSelection.shape).extend({
    partnerId: z.string().nullable().optional(),
    reason: z.string().trim().min(MIN_REASON_LENGTH, 'Add a short note on how they signed up'),
  }).superRefine(checkPhone);

  static slugify(name) {
    return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
}

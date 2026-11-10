// Validation ported from the partner's packages/core/src/schemas. Keep the two in step.
import { z } from 'zod';
import { SUBSCRIPTION_STATUSES, TENANT_SORTS } from '../shared/rules/constants.js';
import { ADDON_IDS, PLAN_IDS } from '../shared/rules/plans.js';
import { COUNTRIES, isMobile, isOpen, REGIONS } from '../shared/rules/region.js';
import { MIN_REASON_LENGTH, TRIAL_DAYS } from '../shared/rules/subscriptions.js';

const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

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

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const positive = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

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

  static onboardingStep = z.object({
    stepId: z.string().trim().min(1, 'Choose a step').max(40),
    done: z.boolean('Say whether the step is done'),
  });

  static slugify(name) {
    return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  /** The restaurants list's query string. Unknown values fall back, as in core. */
  static listQuery(query) {
    const status = text(query.status);
    const planId = text(query.planId);
    const sort = text(query.sort);
    return {
      search: text(query.search)?.toLowerCase(),
      status: SUBSCRIPTION_STATUSES.includes(status) ? status : undefined,
      planId: PLAN_IDS.includes(planId) ? planId : undefined,
      city: text(query.city),
      sort: TENANT_SORTS.includes(sort) ? sort : 'last_order',
      page: positive(query.page, 1),
      pageSize: Math.min(positive(query.pageSize, 10), 100),
    };
  }

  static toTenant(row) {
    return {
      id: row.id,
      businessName: row.business_name,
      slug: row.slug,
      city: row.city,
      ownerName: row.owner_name,
      ownerPhone: row.owner_phone,
      ownerEmail: row.owner_email,
      country: row.country,
      currency: row.currency,
      timezone: row.timezone,
      taxProfile: row.tax_profile,
      createdAt: iso(row.created_at),
      lastOrderAt: iso(row.last_order_at),
      onboarding: row.onboarding
        ? { completedSteps: row.onboarding.completed_steps ?? [], completedAt: row.onboarding.completed_at ?? null }
        : null,
      partnerId: row.partner_id,
    };
  }
}

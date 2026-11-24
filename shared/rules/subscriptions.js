// Ported from the partner's packages/core/src/subscriptions. Keep the two in step.
import { explainEntitlements, isLive, monthlyValue } from "./entitlements.js";
import { FEATURES, FEATURE_KEYS } from "./features.js";
import { addonUnitPrice, DEFAULT_CATALOG, LIMIT_KEYS } from "./plans.js";
import { daysInMonth, localParts, monthKey } from "../time.js";
export const MIN_REASON_LENGTH = 5;
/** Billed on the 1st; the month billing starts is charged only from that local day. */
export function amountDueFor(month, monthly, billingStartsAt, timeZone) {
  if (!billingStartsAt) return 0;
  const [year, m] = month.split("-").map(Number);
  const start = localParts(new Date(billingStartsAt), timeZone);
  const startIndex = start.year * 12 + start.month;
  const monthIndex = year * 12 + m;
  if (startIndex < monthIndex || (startIndex === monthIndex && start.day === 1)) return monthly;
  if (startIndex > monthIndex) return 0;
  const days = daysInMonth(month);
  return Math.round(monthly * (days - start.day + 1) / days);
}
export function isFirstBilledMonth(month, billingStartsAt, timeZone) {
  if (!billingStartsAt) return false;
  const start = new Date(billingStartsAt);
  return monthKey(start, timeZone) === month && localParts(start, timeZone).day > 1;
}
export const TRIAL_DAYS = [
  14,
  30,
  60
];
export function planChangeKind(from, to, catalog = DEFAULT_CATALOG) {
  const diff = catalog.plans[to].monthlyPrice - catalog.plans[from].monthlyPrice;
  return diff > 0 ? "upgrade" : diff < 0 ? "downgrade" : "same";
}
export function addonsEndingOnPlan(addons, planId, catalog = DEFAULT_CATALOG) {
  return addons.filter((addon)=>addon.cancelsAt === null).flatMap((addon)=>{
    const def = catalog.addons[addon.addonId];
    if (def.availableTo.includes(planId)) return [];
    const included = def.grants.length > 0 && def.grants.every((key)=>catalog.plans[planId].features.includes(key));
    return [
      {
        addonId: addon.addonId,
        reason: included ? "included" : "not_offered"
      }
    ];
  });
}
const USAGE_BY_LIMIT = {
  tables: "tables",
  staff_accounts: "staffAccounts",
  stations: "stations",
  branches: "branches"
};
export function previewPlanChange(input, usage, toPlan) {
  const { subscription, addons, now = new Date(), catalog = DEFAULT_CATALOG } = input;
  const kind = planChangeKind(subscription.planId, toPlan, catalog);
  const ending = addonsEndingOnPlan(addons, toPlan, catalog);
  const endingIds = new Set(ending.map((e)=>e.addonId));
  const keptAddons = addons.filter((addon)=>!endingIds.has(addon.addonId));
  const before = explainEntitlements(input);
  const afterInput = {
    ...input,
    subscription: {
      ...subscription,
      planId: toPlan
    },
    addons: keptAddons
  };
  const after = explainEntitlements(afterInput);
  const on = (list)=>new Set(list.filter((f)=>f.enabled).map((f)=>f.key));
  const onBefore = on(before.features);
  const onAfter = on(after.features);
  const limitWarnings = usage ? LIMIT_KEYS.flatMap((key)=>{
    const usageKey = USAGE_BY_LIMIT[key];
    const newLimit = after.limits.find((l)=>l.key === key)?.value;
    if (newLimit === null || newLimit === undefined || usage[usageKey] <= newLimit) return [];
    return [
      {
        key,
        used: usage[usageKey],
        newLimit
      }
    ];
  }) : [];
  return {
    kind,
    appliesNow: kind !== "downgrade" || subscription.status === "trial",
    gained: FEATURE_KEYS.filter((key)=>onAfter.has(key) && !onBefore.has(key)),
    lost: FEATURE_KEYS.filter((key)=>onBefore.has(key) && !onAfter.has(key)),
    addonsEnding: ending,
    monthlyValueBefore: monthlyValue(subscription, addons, now, catalog),
    monthlyValueAfter: monthlyValue({
      ...subscription,
      planId: toPlan
    }, keptAddons, now, catalog),
    limitWarnings
  };
}
export function addonState(addonId, planId, addons, now = new Date(), catalog = DEFAULT_CATALOG) {
  const def = catalog.addons[addonId];
  const current = addons.find((a)=>a.addonId === addonId && isLive(a.cancelsAt, now));
  if (current) return current.cancelsAt ? {
    state: "ending",
    addon: current
  } : {
    state: "active",
    addon: current
  };
  const plan = catalog.plans[planId];
  if (!def.availableTo.includes(planId)) {
    const included = def.grants.length > 0 && def.grants.every((key)=>plan.features.includes(key));
    return {
      state: "unavailable",
      reason: included ? `Included in ${plan.name}` : `Not offered on ${plan.name}`
    };
  }
  return {
    state: "available"
  };
}
export function cheapestUnlock(key, planId, catalog = DEFAULT_CATALOG) {
  const onPlan = catalog.plans[planId];
  const addon = Object.values(catalog.addons).filter((a)=>a.availableTo.includes(planId) && a.grants.includes(key)).sort((a, b)=>addonUnitPrice(a, onPlan) - addonUnitPrice(b, onPlan))[0];
  if (addon) return {
    kind: "addon",
    addonId: addon.id,
    price: addonUnitPrice(addon, onPlan)
  };
  const current = catalog.plans[planId].monthlyPrice;
  const plan = Object.values(catalog.plans).filter((p)=>p.monthlyPrice > current && p.features.includes(key)).sort((a, b)=>a.monthlyPrice - b.monthlyPrice)[0];
  return plan ? {
    kind: "plan",
    planId: plan.id,
    price: plan.monthlyPrice
  } : null;
}
export function nextPlanForLimit(limit, planId, catalog = DEFAULT_CATALOG) {
  const current = catalog.plans[planId];
  const raises = (value)=>value === null || current.limits[limit] !== null && value > current.limits[limit];
  return Object.values(catalog.plans).filter((p)=>p.monthlyPrice > current.monthlyPrice && raises(p.limits[limit])).sort((a, b)=>a.monthlyPrice - b.monthlyPrice)[0]?.id ?? null;
}
export function missingForGrant(key, enabled) {
  return (FEATURES[key].requires ?? []).filter((dependency)=>!enabled.has(dependency));
}
export function dependentsOf(key, enabled) {
  const off = new Set([
    key
  ]);
  for(let changed = true; changed;){
    changed = false;
    for (const candidate of enabled){
      if (!off.has(candidate) && (FEATURES[candidate].requires ?? []).some((dependency)=>off.has(dependency))) {
        off.add(candidate);
        changed = true;
      }
    }
  }
  off.delete(key);
  return FEATURE_KEYS.filter((k)=>off.has(k));
}
export const STATUS_INFO = {
  trial: {
    label: "Trial",
    effect: "Everything in the plan, free until the trial ends.",
    destructive: false
  },
  active: {
    label: "Active",
    effect: "Everything the restaurant pays for.",
    destructive: false
  },
  past_due: {
    label: "Past due",
    effect: "Reminder at day 7, portal banner at day 15, reports locked and no changes to the menu, tables or team at day 30, a warning at day 43, suspended at day 45. Staff keep running the service until then.",
    destructive: false
  },
  suspended: {
    label: "Suspended",
    effect: "Open orders are cancelled and open tables closed at once; then diners can’t order and the portal and counter are read-only. A payment doesn’t lift it: switch it back on by hand.",
    destructive: true
  },
  cancelled: {
    label: "Cancelled",
    effect: "All service ends. Data is kept for 90 days, and the restaurant can export it.",
    destructive: true
  }
};
export function requiresTypedConfirmation(status) {
  return STATUS_INFO[status].destructive;
}

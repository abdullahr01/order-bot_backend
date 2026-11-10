// Ported from the partner's packages/core/src/entitlements. Keep the two in step.
import { FEATURES, FEATURE_KEYS } from "./features.js";
import { addonUnitPrice, DEFAULT_CATALOG, LIMIT_KEYS } from "./plans.js";
export const PAST_DUE_LADDER = [
  {
    day: 7,
    label: "Reminder",
    effect: "A payment reminder goes to the owner.",
    locks: []
  },
  {
    day: 15,
    label: "Portal banner",
    effect: "A banner in the owner portal asks for payment.",
    locks: []
  },
  {
    day: 30,
    label: "Reports and setup locked",
    effect: "Reports lock, and menu, tables and team become read-only.",
    locks: [
      "reports_basic",
      "reports_full",
      "finance_summary",
      "leak_reconciliation"
    ]
  },
  // Days 43 and 45 are the founders' decision (2026-11-09); core still needs updating to match.
  {
    day: 43,
    label: "Suspension warning",
    effect: "Service will be suspended in 2 days unless the payment arrives.",
    locks: []
  },
  {
    day: 45,
    label: "Suspended",
    effect: "Open orders are cancelled and the restaurant is suspended.",
    locks: [
      "qr_ordering"
    ]
  }
];
export const SETUP_LOCK_DAY = 30;
export const SUSPEND_WARNING_DAY = 43;
export const SUSPEND_DAY = 45;
export function pastDueStep(subscription, now) {
  const days = daysPastDue(subscription, now);
  return [
    ...PAST_DUE_LADDER
  ].reverse().find((step)=>days >= step.day) ?? null;
}
export function nextPastDueStep(subscription, now) {
  if (subscription.status !== "past_due") return null;
  const days = daysPastDue(subscription, now);
  const step = PAST_DUE_LADDER.find((s)=>s.day > days);
  return step ? {
    step,
    inDays: step.day - days
  } : null;
}
const DAY_MS = 24 * 60 * 60 * 1000;
export const isLive = (expiresAt, now)=>expiresAt === null || new Date(expiresAt) > now;
function liveOverride(overrides, match, now) {
  return overrides.filter((o)=>match(o) && isLive(o.expiresAt, now)).sort((a, b)=>b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
export function daysPastDue(subscription, now) {
  if (subscription.status !== "past_due" || !subscription.pastDueSince) return 0;
  return Math.floor((now.getTime() - new Date(subscription.pastDueSince).getTime()) / DAY_MS);
}
/** Day 30 of non-payment onwards: owners can't edit the menu, tables or team. */
export const isSetupLocked = (subscription, now)=>daysPastDue(subscription, now) >= SETUP_LOCK_DAY;
/** A suspended or cancelled restaurant can look but not change anything. */
export const isReadOnly = (subscription)=>subscription.status === "suspended" || subscription.status === "cancelled";
function blockedByStatus(key, subscription, now) {
  switch(subscription.status){
    case "trial":
    case "active":
      return false;
    case "past_due":
      {
        const days = daysPastDue(subscription, now);
        return PAST_DUE_LADDER.some((step)=>days >= step.day && step.locks.includes(key));
      }
    case "suspended":
    case "cancelled":
      return true;
  }
}
export function explainEntitlements({ subscription, addons, overrides, now = new Date(), catalog = DEFAULT_CATALOG }) {
  const plan = catalog.plans[subscription.planId];
  const addonDefs = catalog.addons;
  const liveAddons = addons.filter((addon)=>isLive(addon.cancelsAt, now));
  const base = FEATURE_KEYS.map((key)=>{
    const includedInPlan = plan.features.includes(key);
    const fromAddons = liveAddons.filter((a)=>addonDefs[a.addonId].grants.includes(key)).map((a)=>a.addonId);
    const override = liveOverride(overrides, (o)=>o.featureKey === key, now);
    const held = override ? override.granted : includedInPlan || fromAddons.length > 0;
    return {
      key,
      includedInPlan,
      fromAddons,
      override,
      held
    };
  });
  const afterStatus = new Map(base.map((f)=>[
      f.key,
      f.held && !blockedByStatus(f.key, subscription, now)
    ]));
  const enabled = new Set(FEATURE_KEYS.filter((key)=>afterStatus.get(key)));
  for(let changed = true; changed;){
    changed = false;
    for (const key of enabled){
      if ((FEATURES[key].requires ?? []).some((dependency)=>!enabled.has(dependency))) {
        enabled.delete(key);
        changed = true;
      }
    }
  }
  const features = base.map(({ key, includedInPlan, fromAddons, override, held })=>{
    const isOn = enabled.has(key);
    const statusBlocked = held && !afterStatus.get(key);
    const missing = (FEATURES[key].requires ?? []).filter((dependency)=>!enabled.has(dependency));
    return {
      key,
      enabled: isOn,
      includedInPlan,
      fromAddons,
      override,
      blockedBy: !held || isOn ? null : statusBlocked ? "status" : "dependency",
      missing: held && !isOn && !statusBlocked ? missing : []
    };
  });
  const bought = (key)=>liveAddons.filter((a)=>addonDefs[a.addonId].unit.limit === key).reduce((sum, a)=>sum + a.quantity, 0);
  const limits = LIMIT_KEYS.map((key)=>{
    const planValue = plan.limits[key];
    let value = planValue;
    let source = "plan";
    const extra = bought(key);
    if (value !== null && extra > 0) {
      value += extra;
      source = "addon";
    }
    const override = liveOverride(overrides, (o)=>o.limitKey === key, now);
    if (override) {
      value = override.limitValue;
      source = "override";
    }
    return {
      key,
      value,
      planValue,
      source,
      override
    };
  });
  return {
    status: subscription.status,
    features,
    limits
  };
}
export function resolveEntitlements(input) {
  const explained = explainEntitlements(input);
  return {
    features: explained.features.filter((f)=>f.enabled).map((f)=>f.key),
    limits: Object.fromEntries(explained.limits.map((l)=>[
        l.key,
        l.value
      ])),
    status: explained.status
  };
}
export function monthlyValue(subscription, addons, now = new Date(), catalog = DEFAULT_CATALOG) {
  if (subscription.status !== "active" && subscription.status !== "past_due") return 0;
  return listPrice(subscription, addons, now, catalog);
}
export function listPrice(subscription, addons, now = new Date(), catalog = DEFAULT_CATALOG) {
  const plan = catalog.plans[subscription.planId];
  const extras = addons.filter((addon)=>isLive(addon.cancelsAt, now)).reduce((sum, addon)=>sum + addonUnitPrice(catalog.addons[addon.addonId], plan) * addon.quantity, 0);
  return plan.monthlyPrice + extras;
}

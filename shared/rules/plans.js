// Ported from the partner's packages/core/src/plans. Keep the two in step.
import { FEATURES } from "./features.js";
export const PLAN_IDS = [
  "starter",
  "growth",
  "pro"
];
export const LIMIT_KEYS = [
  "tables",
  "staff_accounts",
  "stations",
  "branches"
];
export const LIMIT_LABELS = {
  tables: "tables",
  staff_accounts: "staff logins",
  stations: "kitchen stations",
  branches: "branches"
};
const STARTER_FEATURES = [
  "qr_ordering",
  "bill_request",
  "quick_requests",
  "kot_printing",
  "offline_counter",
  "owner_live_view",
  "daily_summary",
  "void_log",
  "cash_close",
  "reports_basic"
];
const GROWTH_FEATURES = [
  ...STARTER_FEATURES,
  "station_routing",
  "time_menus",
  "leak_reconciliation",
  "reports_full",
  "upsell_rules",
  "split_bill",
  "review_prompt"
];
const PRO_FEATURES = [
  ...GROWTH_FEATURES,
  "pra_invoicing",
  "loyalty",
  "kds",
  "menu_import",
  "finance_summary",
  "priority_support"
];
export const PLANS = {
  starter: {
    id: "starter",
    name: "Starter",
    monthlyPrice: 15_000,
    setupFee: 30_000,
    tagline: "Cafés and small family restaurants",
    features: STARTER_FEATURES,
    limits: {
      tables: 10,
      staff_accounts: 3,
      stations: 1,
      branches: 1
    }
  },
  growth: {
    id: "growth",
    name: "Growth",
    monthlyPrice: 25_000,
    setupFee: 40_000,
    tagline: "Busy family and BBQ restaurants",
    features: GROWTH_FEATURES,
    limits: {
      tables: 20,
      staff_accounts: 6,
      stations: 4,
      branches: 1
    }
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPrice: 35_000,
    setupFee: 50_000,
    tagline: "Large restaurants and those needing PRA invoicing",
    features: PRO_FEATURES,
    limits: {
      tables: 50,
      staff_accounts: 10,
      stations: null,
      branches: 1
    }
  }
};
export const ADDON_IDS = [
  "extra_tables",
  "extra_staff",
  "extra_station",
  "extra_branch"
];
export const ADDONS = {
  extra_tables: {
    id: "extra_tables",
    name: "Extra tables",
    monthlyPrice: 1_000,
    planShare: null,
    availableTo: [
      "starter",
      "growth",
      "pro"
    ],
    grants: [],
    unit: {
      limit: "tables",
      one: "table",
      many: "tables"
    },
    hint: "Once the total reaches the next plan’s price, move up a plan instead."
  },
  extra_staff: {
    id: "extra_staff",
    name: "Extra staff login",
    monthlyPrice: 500,
    planShare: null,
    availableTo: [
      "starter",
      "growth",
      "pro"
    ],
    grants: [],
    unit: {
      limit: "staff_accounts",
      one: "login",
      many: "logins"
    },
    hint: "Waiters need no login."
  },
  extra_station: {
    id: "extra_station",
    name: "Extra kitchen station",
    monthlyPrice: 1_500,
    planShare: null,
    availableTo: [
      "starter"
    ],
    grants: [
      "station_routing"
    ],
    unit: {
      limit: "stations",
      one: "station",
      many: "stations"
    },
    hint: "Two extra stations or more usually means Growth."
  },
  extra_branch: {
    id: "extra_branch",
    name: "Additional branch",
    monthlyPrice: null,
    planShare: 80,
    availableTo: [
      "starter",
      "growth",
      "pro"
    ],
    grants: [
      "multi_branch"
    ],
    unit: {
      limit: "branches",
      one: "branch",
      many: "branches"
    },
    hint: "Each branch has its own tables, staff and counter app."
  }
};
export function addonUnitPrice(addon, plan) {
  return addon.planShare !== null ? Math.round(plan.monthlyPrice * addon.planShare / 100) : addon.monthlyPrice ?? 0;
}
export const addonPriceRule = (addon, currency = "PKR")=>addon.planShare !== null ? `${addon.planShare}% of the plan per ${addon.unit.one}` : `${currency === "GBP" ? "£" : "PKR "}${(addon.monthlyPrice ?? 0).toLocaleString("en-US")} per ${addon.unit.one}`;
export const DEFAULT_CATALOG = {
  plans: PLANS,
  addons: ADDONS
};
export const GB_STARTING_CATALOG = {
  plans: {
    starter: {
      ...PLANS.starter,
      monthlyPrice: 99,
      setupFee: 199,
      tagline: "Cafés and small family restaurants"
    },
    growth: {
      ...PLANS.growth,
      monthlyPrice: 169,
      setupFee: 299,
      tagline: "Busy curry houses and grills"
    },
    pro: {
      ...PLANS.pro,
      monthlyPrice: 249,
      setupFee: 399,
      tagline: "Large restaurants and groups"
    }
  },
  addons: {
    extra_tables: {
      ...ADDONS.extra_tables,
      monthlyPrice: 5
    },
    extra_staff: {
      ...ADDONS.extra_staff,
      monthlyPrice: 5
    },
    extra_station: {
      ...ADDONS.extra_station,
      monthlyPrice: 10
    },
    extra_branch: {
      ...ADDONS.extra_branch
    }
  }
};
export function plansByPrice(catalog) {
  return PLAN_IDS.map((id)=>catalog.plans[id]).sort((a, b)=>a.monthlyPrice - b.monthlyPrice);
}
export function validatePlan(plan, catalog) {
  const problems = [];
  const pkr = (n)=>`PKR ${n.toLocaleString("en-US")}`;
  if (!Number.isInteger(plan.monthlyPrice) || plan.monthlyPrice <= 0) problems.push("The monthly price must be a whole number above zero.");
  if (!Number.isInteger(plan.setupFee) || plan.setupFee < 0) problems.push("The setup fee must be a whole number of zero or more.");
  const index = PLAN_IDS.indexOf(plan.id);
  const below = PLAN_IDS[index - 1];
  const above = PLAN_IDS[index + 1];
  if (below && plan.monthlyPrice <= catalog.plans[below].monthlyPrice) problems.push(`Must cost more than ${catalog.plans[below].name} (${pkr(catalog.plans[below].monthlyPrice)}).`);
  if (above && plan.monthlyPrice >= catalog.plans[above].monthlyPrice) problems.push(`Must cost less than ${catalog.plans[above].name} (${pkr(catalog.plans[above].monthlyPrice)}).`);
  for (const key of plan.features){
    const missing = (FEATURES[key].requires ?? []).filter((dependency)=>!plan.features.includes(dependency));
    if (missing.length) problems.push(`${FEATURES[key].label} needs ${missing.map((k)=>FEATURES[k].label).join(" and ")} in the same plan.`);
  }
  for (const key of LIMIT_KEYS){
    const value = plan.limits[key];
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      problems.push("Limits must be whole numbers of zero or more, or unlimited.");
      break;
    }
  }
  for (const key of [
    "tables",
    "stations",
    "branches"
  ]){
    const value = plan.limits[key];
    if (value !== null && value < 1) problems.push(`A plan needs at least one of ${LIMIT_LABELS[key]}.`);
  }
  return problems;
}

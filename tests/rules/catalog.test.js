import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { phaseTwo } from "../../shared/rules/features.js";
import { monthlyValue, resolveEntitlements } from "../../shared/rules/entitlements.js";
import { addonState } from "../../shared/rules/subscriptions.js";
import { addonPriceRule, addonUnitPrice, DEFAULT_CATALOG, plansByPrice, validatePlan } from "../../shared/rules/plans.js";
const NOW = new Date("2026-10-07T12:00:00Z");
const sub = (planId)=>({
    tenantId: "t",
    planId,
    status: "active",
    trialEndsAt: null,
    currentPeriodEnd: "2026-11-01T00:00:00Z",
    pastDueSince: null,
    scheduledPlanId: null,
    billingStartsAt: null,
    setupFee: 0
  });
function edited(change) {
  const catalog = structuredClone(DEFAULT_CATALOG);
  change(catalog);
  return catalog;
}
describe("catalogue as data (Business Plan 9.1)", ()=>{
  it("a price change reaches every restaurant's bill", ()=>{
    const catalog = edited((c)=>c.plans.growth.monthlyPrice = 27_000);
    assert.equal(monthlyValue(sub("growth"), [], NOW, catalog), 27_000);
    assert.equal(monthlyValue(sub("growth"), [], NOW), 25_000, "the seed is unchanged");
  });
  it("a feature added to a plan reaches every restaurant on it", ()=>{
    const catalog = edited((c)=>c.plans.starter.features = [
        ...c.plans.starter.features,
        "time_menus"
      ]);
    const { features } = resolveEntitlements({
      subscription: sub("starter"),
      addons: [],
      overrides: [],
      now: NOW,
      catalog
    });
    assert.ok(features.includes("time_menus"));
  });
  it("an add-on withdrawn from a plan stays with restaurants that already have it", ()=>{
    const catalog = edited((c)=>c.addons.extra_staff.availableTo = [
        "growth",
        "pro"
      ]);
    const active = [
      {
        tenantId: "t",
        addonId: "extra_staff",
        quantity: 2,
        activatedAt: "2026-09-01T00:00:00Z",
        cancelsAt: null
      }
    ];
    assert.equal(addonState("extra_staff", "starter", active, NOW, catalog).state, "active");
    assert.equal(addonState("extra_staff", "starter", [], NOW, catalog).state, "unavailable");
  });
  it("an extra branch follows the plan's own price", ()=>{
    const branch = DEFAULT_CATALOG.addons.extra_branch;
    assert.deepEqual(plansByPrice(DEFAULT_CATALOG).map((p)=>addonUnitPrice(branch, p)), [
      12_000,
      20_000,
      28_000
    ]);
    assert.equal(addonPriceRule(branch), "80% of the plan per branch");
    assert.equal(addonPriceRule(DEFAULT_CATALOG.addons.extra_tables), "PKR 1,000 per table");
  });
  it("features not built yet are marked, so they are never sold early (Business Plan 8.3)", ()=>{
    assert.deepEqual(phaseTwo(DEFAULT_CATALOG.plans.starter.features), []);
    assert.ok(phaseTwo(DEFAULT_CATALOG.plans.pro.features).includes("pra_invoicing"));
  });
});
describe("plan validation", ()=>{
  it("the seed catalogue is valid", ()=>{
    for (const plan of Object.values(DEFAULT_CATALOG.plans))assert.deepEqual(validatePlan(plan, DEFAULT_CATALOG), [], plan.id);
  });
  it("prices must keep the tier order", ()=>{
    const tooCheap = {
      ...DEFAULT_CATALOG.plans.growth,
      monthlyPrice: 14_000
    };
    assert.ok(validatePlan(tooCheap, DEFAULT_CATALOG).some((p)=>p.includes("more than Starter")));
    const tooDear = {
      ...DEFAULT_CATALOG.plans.growth,
      monthlyPrice: 40_000
    };
    assert.ok(validatePlan(tooDear, DEFAULT_CATALOG).some((p)=>p.includes("less than Pro")));
  });
  it("a feature's prerequisites must be in the same plan", ()=>{
    const broken = {
      ...DEFAULT_CATALOG.plans.growth,
      features: DEFAULT_CATALOG.plans.growth.features.filter((k)=>k !== "kot_printing")
    };
    assert.ok(validatePlan(broken, DEFAULT_CATALOG).some((p)=>p.includes("needs Kitchen slips")));
  });
  it("limits must be whole numbers or unlimited, with at least one table, station and branch", ()=>{
    const bad = {
      ...DEFAULT_CATALOG.plans.starter,
      limits: {
        ...DEFAULT_CATALOG.plans.starter.limits,
        staff_accounts: -1,
        tables: 0,
        branches: 0
      }
    };
    const problems = validatePlan(bad, DEFAULT_CATALOG);
    assert.ok(problems.some((p)=>p.includes("whole numbers")));
    assert.ok(problems.some((p)=>p.includes("at least one of tables")) && problems.some((p)=>p.includes("at least one of branches")));
  });
});

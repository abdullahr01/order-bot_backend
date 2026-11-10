import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLANS } from "../../shared/rules/plans.js";
import { explainEntitlements, listPrice, monthlyValue, nextPastDueStep, pastDueStep, resolveEntitlements } from "../../shared/rules/entitlements.js";
const NOW = new Date("2026-10-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays)=>new Date(NOW.getTime() + offsetDays * DAY).toISOString();
function sub(planId, status = "active", pastDueDays = 0) {
  return {
    tenantId: "t",
    planId,
    status,
    trialEndsAt: null,
    currentPeriodEnd: iso(20),
    pastDueSince: status === "past_due" || status === "suspended" ? iso(-pastDueDays) : null,
    scheduledPlanId: null,
    billingStartsAt: null,
    setupFee: 0
  };
}
const addon = (addonId, extra = {})=>({
    tenantId: "t",
    addonId,
    quantity: 1,
    activatedAt: iso(-10),
    cancelsAt: null,
    ...extra
  });
const featureOverride = (featureKey, granted, expiresAt = null)=>({
    id: `o_${featureKey}`,
    tenantId: "t",
    featureKey,
    limitKey: null,
    limitValue: null,
    granted,
    reason: "test",
    expiresAt,
    createdBy: "test",
    createdAt: iso(-1)
  });
const resolve = (subscription, addons = [], overrides = [])=>resolveEntitlements({
    subscription,
    addons,
    overrides,
    now: NOW
  });
const features = (subscription, addons = [], overrides = [])=>new Set(resolve(subscription, addons, overrides).features);
describe("plans (Business Plan 8.2)", ()=>{
  it("each plan resolves to exactly its features", ()=>{
    for (const plan of Object.values(PLANS)){
      assert.deepEqual([
        ...features(sub(plan.id))
      ].sort(), [
        ...plan.features
      ].sort(), plan.id);
    }
  });
  it("prices, setup fees and limits match the v5.1 plan table", ()=>{
    assert.deepEqual(Object.values(PLANS).map((p)=>[
        p.id,
        p.monthlyPrice,
        p.setupFee,
        p.limits.tables,
        p.limits.staff_accounts,
        p.limits.stations
      ]), [
      [
        "starter",
        15_000,
        30_000,
        10,
        3,
        1
      ],
      [
        "growth",
        25_000,
        40_000,
        20,
        6,
        4
      ],
      [
        "pro",
        35_000,
        50_000,
        50,
        10,
        null
      ]
    ]);
  });
  it("every plan has table ordering, kitchen slips, the offline counter and owner control", ()=>{
    for (const plan of Object.values(PLANS)){
      const f = features(sub(plan.id));
      for (const key of [
        "qr_ordering",
        "kot_printing",
        "offline_counter",
        "void_log",
        "cash_close",
        "reports_basic"
      ])assert.ok(f.has(key), `${plan.id} ${key}`);
    }
  });
  it("each step up keeps everything below it", ()=>{
    assert.ok(PLANS.starter.features.every((key)=>PLANS.growth.features.includes(key)));
    assert.ok(PLANS.growth.features.every((key)=>PLANS.pro.features.includes(key)));
    assert.ok(!features(sub("starter")).has("station_routing") && features(sub("growth")).has("station_routing"));
    assert.ok(!features(sub("growth")).has("pra_invoicing") && features(sub("pro")).has("pra_invoicing"));
  });
});
describe("add-ons (Business Plan 8.4)", ()=>{
  it("extra tables, logins and stations add to the plan's limits", ()=>{
    const { limits } = resolve(sub("starter"), [
      addon("extra_tables", {
        quantity: 4
      }),
      addon("extra_staff", {
        quantity: 2
      }),
      addon("extra_station")
    ]);
    assert.equal(limits.tables, 14);
    assert.equal(limits.staff_accounts, 5);
    assert.equal(limits.stations, 2);
  });
  it("an extra station on Starter also turns on station routing", ()=>{
    assert.ok(features(sub("starter"), [
      addon("extra_station")
    ]).has("station_routing"));
  });
  it("extra branches add up and turn on multi-branch", ()=>{
    const resolved = resolve(sub("pro"), [
      addon("extra_branch", {
        quantity: 3
      })
    ]);
    assert.equal(resolved.limits.branches, 4);
    assert.ok(resolved.features.includes("multi_branch"));
  });
  it("an unlimited limit stays unlimited whatever is bought", ()=>{
    assert.equal(resolve(sub("pro"), [
      addon("extra_station", {
        quantity: 3
      })
    ]).limits.stations, null);
  });
  it("an add-on removed for the period end keeps working until then", ()=>{
    assert.equal(resolve(sub("starter"), [
      addon("extra_tables", {
        quantity: 2,
        cancelsAt: iso(5)
      })
    ]).limits.tables, 12);
    assert.equal(resolve(sub("starter"), [
      addon("extra_tables", {
        quantity: 2,
        cancelsAt: iso(-1)
      })
    ]).limits.tables, 10);
  });
  it("monthly value: fixed prices per unit, and an extra branch at 80% of the plan", ()=>{
    assert.equal(monthlyValue(sub("starter"), [
      addon("extra_tables", {
        quantity: 4
      }),
      addon("extra_staff", {
        quantity: 2
      })
    ], NOW), 15_000 + 4_000 + 1_000);
    assert.equal(monthlyValue(sub("growth"), [
      addon("extra_branch", {
        quantity: 2
      })
    ], NOW), 25_000 + 2 * 20_000);
    assert.equal(monthlyValue(sub("pro", "trial"), [], NOW), 0);
    assert.equal(listPrice(sub("pro", "trial"), [], NOW), 35_000);
  });
  it("Starter plus ten extra tables costs the same as Growth", ()=>{
    assert.equal(monthlyValue(sub("starter"), [
      addon("extra_tables", {
        quantity: 10
      })
    ], NOW), PLANS.growth.monthlyPrice);
  });
});
describe("overrides", ()=>{
  it("a grant adds a feature and a revocation removes one", ()=>{
    assert.ok(features(sub("starter"), [], [
      featureOverride("time_menus", true)
    ]).has("time_menus"));
    assert.ok(!features(sub("growth"), [], [
      featureOverride("time_menus", false)
    ]).has("time_menus"));
  });
  it("an expired grant no longer applies", ()=>{
    assert.ok(!features(sub("starter"), [], [
      featureOverride("time_menus", true, iso(-1))
    ]).has("time_menus"));
  });
  it("revoking a prerequisite switches off what depends on it", ()=>{
    const f = features(sub("growth"), [], [
      featureOverride("qr_ordering", false)
    ]);
    assert.ok(!f.has("bill_request") && !f.has("quick_requests") && !f.has("upsell_rules"));
    const explained = explainEntitlements({
      subscription: sub("growth"),
      addons: [],
      overrides: [
        featureOverride("qr_ordering", false)
      ],
      now: NOW
    });
    const bill = explained.features.find((x)=>x.key === "bill_request");
    assert.equal(bill.blockedBy, "dependency");
    assert.deepEqual(bill.missing, [
      "qr_ordering"
    ]);
  });
  it("a limit override sets the limit outright, add-ons included", ()=>{
    const override = {
      ...featureOverride("qr_ordering", true),
      featureKey: null,
      limitKey: "tables",
      limitValue: 16
    };
    assert.equal(resolve(sub("starter"), [
      addon("extra_tables", {
        quantity: 4
      })
    ], [
      override
    ]).limits.tables, 16);
  });
});
describe("subscription status (Business Plan 8.11)", ()=>{
  it("past due before day 30 keeps every feature", ()=>{
    assert.deepEqual([
      ...features(sub("growth", "past_due", 20))
    ].sort(), [
      ...PLANS.growth.features
    ].sort());
  });
  it("from day 30 reports lock; ordering and the counter carry on", ()=>{
    const f = features(sub("growth", "past_due", 31));
    assert.ok(!f.has("reports_basic") && !f.has("reports_full") && !f.has("leak_reconciliation"));
    assert.ok(f.has("qr_ordering") && f.has("kot_printing") && f.has("offline_counter") && f.has("cash_close"));
  });
  it("from day 45 diner QR ordering pauses too, but never the counter", ()=>{
    const f = features(sub("growth", "past_due", 46));
    assert.ok(!f.has("qr_ordering") && !f.has("bill_request") && !f.has("quick_requests"));
    assert.ok(f.has("kot_printing") && f.has("offline_counter") && f.has("void_log"));
  });
  it("the ladder says where the restaurant is and what comes next", ()=>{
    assert.equal(pastDueStep(sub("starter", "past_due", 3), NOW), null);
    assert.deepEqual(nextPastDueStep(sub("starter", "past_due", 3), NOW)?.inDays, 4);
    assert.equal(pastDueStep(sub("starter", "past_due", 16), NOW)?.label, "Portal banner");
    assert.equal(nextPastDueStep(sub("starter", "past_due", 16), NOW)?.step.label, "Reports and setup locked");
    assert.equal(nextPastDueStep(sub("starter", "past_due", 50), NOW), null);
    assert.equal(nextPastDueStep(sub("starter"), NOW), null);
  });
  it("suspended and cancelled have no features", ()=>{
    assert.equal(features(sub("pro", "suspended", 50)).size, 0);
    assert.equal(features(sub("pro", "cancelled")).size, 0);
  });
});

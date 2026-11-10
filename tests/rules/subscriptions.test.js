import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addonState, cheapestUnlock, dependentsOf, missingForGrant, nextPlanForLimit, previewPlanChange } from "../../shared/rules/subscriptions.js";
const NOW = new Date("2026-10-06T12:00:00Z");
const sub = (planId, status = "active")=>({
    tenantId: "t",
    planId,
    status,
    trialEndsAt: null,
    currentPeriodEnd: "2026-10-26T00:00:00Z",
    pastDueSince: null,
    scheduledPlanId: null,
    billingStartsAt: null,
    setupFee: 0
  });
const addon = (addonId, quantity = 1)=>({
    tenantId: "t",
    addonId,
    quantity,
    activatedAt: "2026-09-01T00:00:00Z",
    cancelsAt: null
  });
const usage = {
  menuItems: 40,
  tables: 18,
  staffAccounts: 4,
  stations: 2,
  branches: 1
};
describe("plan changes", ()=>{
  it("upgrades apply now and end add-ons the new plan includes", ()=>{
    const preview = previewPlanChange({
      subscription: sub("starter"),
      addons: [
        addon("extra_station"),
        addon("extra_tables", 4)
      ],
      overrides: [],
      now: NOW
    }, usage, "growth");
    assert.equal(preview.kind, "upgrade");
    assert.ok(preview.appliesNow);
    assert.deepEqual(preview.addonsEnding, [
      {
        addonId: "extra_station",
        reason: "included"
      }
    ]);
    assert.ok(preview.gained.includes("time_menus"));
    assert.equal(preview.monthlyValueAfter, 25_000 + 4_000);
  });
  it("downgrades wait for the period end, list what is lost, and flag tables over the new limit", ()=>{
    const preview = previewPlanChange({
      subscription: sub("growth"),
      addons: [],
      overrides: [],
      now: NOW
    }, usage, "starter");
    assert.equal(preview.kind, "downgrade");
    assert.ok(!preview.appliesNow);
    assert.ok(preview.lost.includes("station_routing") && preview.lost.includes("time_menus"));
    assert.deepEqual(preview.limitWarnings, [
      {
        key: "tables",
        used: 18,
        newLimit: 10
      },
      {
        key: "staff_accounts",
        used: 4,
        newLimit: 3
      },
      {
        key: "stations",
        used: 2,
        newLimit: 1
      }
    ]);
  });
  it("downgrades during a trial apply now", ()=>{
    assert.ok(previewPlanChange({
      subscription: sub("pro", "trial"),
      addons: [],
      overrides: [],
      now: NOW
    }, null, "starter").appliesNow);
  });
});
describe("add-on availability", ()=>{
  it("explains why an add-on cannot be bought", ()=>{
    assert.deepEqual(addonState("extra_station", "growth", [], NOW), {
      state: "unavailable",
      reason: "Included in Growth"
    });
    assert.deepEqual(addonState("extra_tables", "pro", [], NOW), {
      state: "available"
    });
  });
  it("an active add-on can be bought in more units, not twice", ()=>{
    assert.equal(addonState("extra_tables", "starter", [
      addon("extra_tables", 2)
    ], NOW).state, "active");
    assert.equal(addonState("extra_staff", "starter", [
      addon("extra_branch")
    ], NOW).state, "available", "one add-on never covers another");
  });
});
describe("single-feature grants", ()=>{
  it("refuses a grant whose prerequisites are missing", ()=>{
    assert.deepEqual(missingForGrant("leak_reconciliation", new Set([
      "kot_printing"
    ])), [
      "void_log"
    ]);
    assert.deepEqual(missingForGrant("station_routing", new Set([
      "kot_printing"
    ])), []);
  });
  it("lists what a revocation also switches off", ()=>{
    const enabled = new Set([
      "kot_printing",
      "station_routing",
      "kds",
      "void_log",
      "leak_reconciliation"
    ]);
    assert.deepEqual(dependentsOf("kot_printing", enabled), [
      "station_routing",
      "leak_reconciliation",
      "kds"
    ]);
  });
});
describe("upgrade suggestions", ()=>{
  it("prefers the cheapest add-on, then the cheapest plan that includes the feature", ()=>{
    assert.deepEqual(cheapestUnlock("station_routing", "starter"), {
      kind: "addon",
      addonId: "extra_station",
      price: 1_500
    });
    assert.deepEqual(cheapestUnlock("time_menus", "starter"), {
      kind: "plan",
      planId: "growth",
      price: 25_000
    });
    assert.deepEqual(cheapestUnlock("pra_invoicing", "growth"), {
      kind: "plan",
      planId: "pro",
      price: 35_000
    });
    assert.deepEqual(cheapestUnlock("multi_branch", "growth"), {
      kind: "addon",
      addonId: "extra_branch",
      price: 20_000
    });
    assert.equal(cheapestUnlock("pra_invoicing", "pro"), null);
  });
  it("finds the next plan that raises a limit", ()=>{
    assert.equal(nextPlanForLimit("tables", "starter"), "growth");
    assert.equal(nextPlanForLimit("stations", "growth"), "pro");
    assert.equal(nextPlanForLimit("tables", "pro"), null);
    assert.equal(nextPlanForLimit("branches", "starter"), null, "branches are bought, not upgraded to");
  });
});

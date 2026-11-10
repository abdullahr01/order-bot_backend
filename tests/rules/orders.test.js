import assert from "node:assert/strict";
import { test } from "node:test";
import { CANCEL_REASONS, canCancel, canTransition, lineName, matchesOrderSearch, nextStatus, resolveChoices, statusTime } from "../../shared/rules/orders.js";
test("orders go to a waiter, then are served", ()=>{
  assert.equal(nextStatus("new"), "accepted");
  assert.equal(nextStatus("accepted"), "served");
  assert.equal(nextStatus("served"), null);
  assert.ok(!canTransition("new", "served"), "a waiter takes it first");
  assert.ok(!canTransition("served", "accepted"), "cannot go back");
});
test("orders can be cancelled until they are served", ()=>{
  assert.ok(canCancel("new") && canCancel("accepted"));
  assert.ok(!canCancel("served") && !canCancel("cancelled"));
  assert.ok(!canTransition("served", "cancelled"));
});
test("an empty table is the first reason offered for rejecting an order (Business Plan 6.4)", ()=>{
  assert.equal(CANCEL_REASONS[0], "Nobody is at the table");
});
test("statusTime returns the latest entry for a status", ()=>{
  const history = [
    {
      status: "new",
      at: "2026-10-11T10:00:00.000Z"
    },
    {
      status: "accepted",
      at: "2026-10-11T10:03:00.000Z"
    }
  ];
  assert.equal(statusTime({
    history
  }, "accepted"), "2026-10-11T10:03:00.000Z");
  assert.equal(statusTime({
    history
  }, "served"), null);
});
test("search matches the order number or the table", ()=>{
  const order = {
    number: 1247,
    table: 7
  };
  assert.ok(matchesOrderSearch(order, "#1247"));
  assert.ok(matchesOrderSearch(order, "124"));
  assert.ok(matchesOrderSearch(order, "t7") && matchesOrderSearch(order, "Table 7"));
  assert.ok(!matchesOrderSearch(order, "t17"));
  assert.ok(!matchesOrderSearch({
    number: 1247,
    table: null
  }, "t7"));
  assert.ok(matchesOrderSearch(order, "  "));
});
test("dish options: one from each pick-one set, extras added to the price", ()=>{
  const karahi = {
    name: "Chicken Karahi",
    options: [
      {
        id: "g1",
        name: "Spice",
        kind: "one",
        choices: [
          {
            id: "mild",
            name: "Mild",
            price: 0
          },
          {
            id: "hot",
            name: "Hot",
            price: 0
          }
        ]
      },
      {
        id: "g2",
        name: "Extras",
        kind: "extra",
        choices: [
          {
            id: "butter",
            name: "Butter on top",
            price: 100
          },
          {
            id: "naan",
            name: "Naan",
            price: 40
          }
        ]
      }
    ]
  };
  assert.deepEqual(resolveChoices(karahi, [
    "hot",
    "butter",
    "naan"
  ]), {
    ok: true,
    labels: [
      "Hot",
      "+ Butter on top",
      "+ Naan"
    ],
    extra: 140
  });
  assert.deepEqual(resolveChoices(karahi, [
    "mild"
  ]), {
    ok: true,
    labels: [
      "Mild"
    ],
    extra: 0
  });
  assert.equal(resolveChoices(karahi, []).ok, false, "spice must be chosen");
  assert.equal(resolveChoices(karahi, [
    "mild",
    "hot"
  ]).ok, false, "only one spice");
  assert.equal(resolveChoices(karahi, [
    "mild",
    "gone"
  ]).ok, false, "unknown choice");
  assert.equal(resolveChoices({
    name: "Raita",
    options: []
  }).ok, true);
  assert.equal(lineName({
    name: "Chicken Karahi",
    options: [
      "Hot",
      "+ Naan"
    ]
  }), "Chicken Karahi (Hot, + Naan)");
  assert.equal(lineName({
    name: "Raita"
  }), "Raita");
});

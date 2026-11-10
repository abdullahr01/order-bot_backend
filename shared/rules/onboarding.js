// Ported from the partner's packages/core/src/onboarding. Keep the two in step.
export function onboardingSteps(enabled, tableLimit) {
  const has = (key)=>enabled.has(key);
  const steps = [
    {
      id: "agreement",
      label: "Sign the agreement",
      detail: "Data ownership, billing on the 1st, the past-due ladder and the notice period. Keep the signed copy."
    },
    {
      id: "collect_menu",
      label: "Collect the menu, photos and station list",
      detail: "Before the visit: the paper menu, dish photos, and which station cooks each item."
    },
    {
      id: "menu",
      label: "Enter the menu",
      detail: `Categories, items, prices, Urdu names, options such as spice level and portion, add-ons, prep times and each item’s station.${has("menu_import") ? " Menu import from a photo can do the first pass." : ""}`
    },
    {
      id: "tables",
      label: "Add tables, waiters and staff logins, and print the QR cards",
      detail: `${tableLimit === null ? "Every table" : `Up to ${tableLimit} tables`}, numbered to match the floor. Laminate the cards; waiters need only their names.`
    },
    {
      id: "counter",
      label: "Install the counter app and the print helper",
      detail: `Install the counter in Chrome on the counter PC and pair it to the branch. Install the print helper and test the printer${has("station_routing") ? " at every station" : ""}. Put the router and printer on a UPS.`
    }
  ];
  if (has("time_menus")) steps.push({
    id: "time_menus",
    label: "Set the time-based menus",
    detail: "Breakfast, hi-tea, lunch deals, and sehri and iftar in Ramadan."
  });
  steps.push({
    id: "verify_access",
    label: "Check feature access",
    detail: "Confirm the features below match exactly what was sold."
  }, {
    id: "training",
    label: "Train the counter staff and waiters",
    detail: "About an hour. Run a test meal at two tables: scan, order, kitchen slip, bill and confirm payment."
  }, {
    id: "go_live",
    label: "Go live",
    detail: "The cards go on the tables. Be on site for the first two evening services."
  });
  return steps;
}

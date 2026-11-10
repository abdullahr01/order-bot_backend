// Ported from the partner's packages/core/src/features. Keep the two in step.
export const FEATURE_KEYS = [
  "qr_ordering",
  "bill_request",
  "quick_requests",
  "kot_printing",
  "offline_counter",
  "owner_live_view",
  "daily_summary",
  "void_log",
  "cash_close",
  "reports_basic",
  "station_routing",
  "time_menus",
  "leak_reconciliation",
  "reports_full",
  "upsell_rules",
  "split_bill",
  "review_prompt",
  "pra_invoicing",
  "loyalty",
  "kds",
  "menu_import",
  "finance_summary",
  "priority_support",
  "multi_branch"
];
export const FEATURES = {
  qr_ordering: {
    key: "qr_ordering",
    label: "QR table ordering",
    description: "Diners scan the table’s QR code and order from their phone.",
    group: "ordering",
    phase: 1
  },
  bill_request: {
    key: "bill_request",
    label: "Bill request",
    description: "Diners ask for the bill from their phone.",
    group: "ordering",
    requires: [
      "qr_ordering"
    ],
    phase: 1
  },
  quick_requests: {
    key: "quick_requests",
    label: "Quick requests",
    description: "Water, roti, napkins, cutlery and call waiter in one tap.",
    group: "ordering",
    requires: [
      "qr_ordering"
    ],
    phase: 1
  },
  kot_printing: {
    key: "kot_printing",
    label: "Kitchen slips",
    description: "A slip prints in the kitchen the moment an order is accepted.",
    group: "counter",
    phase: 1
  },
  offline_counter: {
    key: "offline_counter",
    label: "Offline counter",
    description: "The counter keeps taking orders, billing and printing when the internet drops.",
    group: "counter",
    phase: 1
  },
  owner_live_view: {
    key: "owner_live_view",
    label: "Owner live view",
    description: "Tables, sales today and open bills on the owner’s phone.",
    group: "control",
    phase: 1
  },
  daily_summary: {
    key: "daily_summary",
    label: "Daily summary",
    description: "The day’s sales, voids and cash sent to the owner at closing time.",
    group: "control",
    phase: 1
  },
  void_log: {
    key: "void_log",
    label: "Void log",
    description: "Every void and force close needs a reason and records who did it.",
    group: "control",
    phase: 1
  },
  cash_close: {
    key: "cash_close",
    label: "Cash close",
    description: "Counted cash against recorded cash payments at the end of the day.",
    group: "control",
    phase: 1
  },
  reports_basic: {
    key: "reports_basic",
    label: "Basic reports",
    description: "Sales by day and hour, top items, average bill, diner vs staff orders.",
    group: "insights",
    phase: 1
  },
  station_routing: {
    key: "station_routing",
    label: "Station routing",
    description: "Each item’s slip prints at its own station: kitchen, BBQ, drinks.",
    group: "counter",
    requires: [
      "kot_printing"
    ],
    phase: 1
  },
  time_menus: {
    key: "time_menus",
    label: "Time-based menus",
    description: "Breakfast, hi-tea, lunch deals, sehri and iftar menus that switch on their own.",
    group: "menu",
    phase: 1
  },
  leak_reconciliation: {
    key: "leak_reconciliation",
    label: "Kitchen-to-bill check",
    description: "Every kitchen slip matched to a paid line, with gaps flagged daily.",
    group: "control",
    requires: [
      "kot_printing",
      "void_log"
    ],
    phase: 2
  },
  reports_full: {
    key: "reports_full",
    label: "Waiter and table reports",
    description: "Time to accept, time to serve, table turnover and meal length.",
    group: "insights",
    requires: [
      "reports_basic"
    ],
    phase: 2
  },
  upsell_rules: {
    key: "upsell_rules",
    label: "Cart suggestions",
    description: "Owner-set prompts such as “add a drink?” in the diner’s cart.",
    group: "guests",
    requires: [
      "qr_ordering"
    ],
    phase: 2
  },
  split_bill: {
    key: "split_bill",
    label: "Split bill",
    description: "Split a table’s bill equally or by item.",
    group: "billing",
    phase: 2
  },
  review_prompt: {
    key: "review_prompt",
    label: "Google review prompt",
    description: "A “How was your meal?” link to Google after payment, shown to every diner.",
    group: "guests",
    requires: [
      "qr_ordering"
    ],
    phase: 2
  },
  pra_invoicing: {
    key: "pra_invoicing",
    label: "PRA invoicing",
    description: "PRA eIMS invoice with its QR code, printed and shown after payment.",
    group: "billing",
    phase: 2
  },
  loyalty: {
    key: "loyalty",
    label: "Loyalty stamp card",
    description: "Optional stamp card by phone number for repeat visits.",
    group: "guests",
    phase: 2
  },
  kds: {
    key: "kds",
    label: "Kitchen display",
    description: "A screen in the kitchen instead of, or as well as, printed slips.",
    group: "counter",
    requires: [
      "kot_printing"
    ],
    phase: 2
  },
  menu_import: {
    key: "menu_import",
    label: "Menu import from photo",
    description: "The menu typed in from a photo of the paper menu.",
    group: "menu",
    phase: 2
  },
  finance_summary: {
    key: "finance_summary",
    label: "Finance and tax summary",
    description: "A monthly summary for the restaurant’s accountant.",
    group: "insights",
    requires: [
      "reports_basic"
    ],
    phase: 2
  },
  priority_support: {
    key: "priority_support",
    label: "Priority support",
    description: "Support during evening service as well as business hours.",
    group: "scale",
    phase: 1
  },
  multi_branch: {
    key: "multi_branch",
    label: "Multi-branch",
    description: "Several branches, each with its own tables, staff and counter, under one owner.",
    group: "scale",
    phase: 1
  }
};
export const FEATURE_GROUP_LABELS = {
  ordering: "Table ordering",
  counter: "Counter and kitchen",
  control: "Owner control",
  menu: "Menu",
  insights: "Reports",
  guests: "Guests",
  billing: "Billing and tax",
  scale: "Support and scale"
};
export function isFeatureKey(value) {
  return FEATURE_KEYS.includes(value);
}
export const phaseTwo = (keys)=>FEATURE_KEYS.filter((key)=>keys.includes(key) && FEATURES[key].phase === 2);

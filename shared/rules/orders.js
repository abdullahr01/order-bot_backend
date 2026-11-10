// Ported from the partner's packages/core/src/orders. Keep the two in step.
export const ACTIVE_STATUSES = [
  "new",
  "accepted"
];
const NEXT = {
  new: "accepted",
  accepted: "served",
  served: null,
  cancelled: null
};
export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}
export function nextStatus(status) {
  return NEXT[status];
}
export function canCancel(status) {
  return isActiveStatus(status);
}
export function canTransition(from, to) {
  return to === "cancelled" ? canCancel(from) : NEXT[from] === to;
}
export const CANCEL_REASONS = [
  "Nobody is at the table",
  "An item is not available",
  "Diner asked to cancel",
  "Ordered twice by mistake"
];
export const MIN_CANCEL_REASON_LENGTH = 3;
export const lineName = (item)=>item.options?.length ? `${item.name} (${item.options.join(", ")})` : item.name;
export const optionLabel = (group, choice)=>group.kind === "extra" ? `+ ${choice.name}` : choice.name;
export function resolveChoices(item, choiceIds = []) {
  const picked = new Set(choiceIds);
  if (picked.size !== choiceIds.length) return {
    ok: false,
    error: `An option is chosen twice for ${item.name}.`
  };
  const known = new Set(item.options.flatMap((g)=>g.choices.map((c)=>c.id)));
  if ([
    ...picked
  ].some((id)=>!known.has(id))) return {
    ok: false,
    error: `The options for ${item.name} have changed. Please choose again.`
  };
  const labels = [];
  let extra = 0;
  for (const group of item.options){
    const chosen = group.choices.filter((c)=>picked.has(c.id));
    if (group.kind === "one" && chosen.length !== 1) return {
      ok: false,
      error: `Choose ${group.name.toLowerCase()} for ${item.name}.`
    };
    for (const choice of chosen){
      labels.push(optionLabel(group, choice));
      extra += choice.price;
    }
  }
  return {
    ok: true,
    labels,
    extra
  };
}
export function orderSubtotal(order) {
  return order.items.reduce((sum, item)=>sum + item.quantity * item.unitPrice, 0);
}
export function statusTime(order, status) {
  return order.history.findLast((entry)=>entry.status === status)?.at ?? null;
}
export function matchesOrderSearch(order, query) {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  const table = /^(?:t|table)\s*(\d+)$/.exec(q);
  if (table) return order.table === Number(table[1]);
  return String(order.number).startsWith(q);
}

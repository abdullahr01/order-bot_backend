// Ported from the partner's packages/core/src/access. Keep the two in step.
export const PERMISSIONS = [
  "orders.manage",
  "orders.all_branches",
  "figures.view",
  "menu.edit",
  "menu.availability",
  "service.pause",
  "service.hours",
  "team.manage",
  "tables.manage",
  "account.manage"
];
const STAFF = [
  "orders.manage",
  "menu.availability",
  "service.pause"
];
export function portalRoleOf(role) {
  if (role === "tenant_owner") return "owner";
  if (role === "tenant_staff") return "staff";
  return null;
}
export function can(role, permission) {
  const portalRole = portalRoleOf(role);
  if (portalRole === "owner") return true;
  if (portalRole === "staff") return STAFF.includes(permission);
  return false;
}
export const HISTORY_DAYS = {
  owner: 30,
  staff: 7
};
export const ROLE_LABELS = {
  owner: "Owner",
  staff: "Branch staff"
};

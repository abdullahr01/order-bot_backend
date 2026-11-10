// Ported from the partner's packages/core/src/mock/handlers/scope.ts. Keep the two in step.
// Who on the platform team may see what. The caller is `{ adminScope, viewCountry }`.

/** No scope in the token means the founder, so older tokens keep working. */
export const FOUNDER_SCOPE = Object.freeze({ role: 'founder', countries: Object.freeze(['PK', 'GB']), partnerId: null });

export const scopeOf = (caller) => caller.adminScope ?? FOUNDER_SCOPE;

/** The country the console is showing: the one asked for if allowed, else the first allowed. */
export function viewCountry(caller) {
  const { countries } = scopeOf(caller);
  return caller.viewCountry && countries.includes(caller.viewCountry) ? caller.viewCountry : countries[0];
}

/** Whether this person may see the restaurant at all, whichever country is on screen. */
export function canSee(caller, tenant) {
  const scope = scopeOf(caller);
  if (!scope.countries.includes(tenant.country)) return false;
  return scope.role !== 'partner' || tenant.partnerId === scope.partnerId;
}

export const isFounder = (caller) => scopeOf(caller).role === 'founder';
export const isPartner = (caller) => scopeOf(caller).role === 'partner';

/** Pakistan's prices: the founder and the team. The UK's: the founder only. Partners never. */
export const canEditPrices = (caller, country) => !isPartner(caller) && (country === 'PK' || isFounder(caller));

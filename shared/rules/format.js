// Ported from the partner's packages/core/src/format (the parts the server needs).
const pkr = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2, minimumFractionDigits: 0 });

export const formatPKR = (amount) => `PKR ${pkr.format(amount)}`;

/** "PKR 15,000" or "£149": an amount in a restaurant's own currency. */
export const formatMoney = (amount, currency) => (currency === 'GBP' ? gbp.format(amount) : formatPKR(amount));

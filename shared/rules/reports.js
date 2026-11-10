// Ported from the partner's packages/core/src/reports. Keep the two in step.
// Difference: days and hours are the restaurant's own, not the browser's.
import { dayKey, localParts } from '../time.js';

const counted = (orders) => orders.filter((order) => order.status !== 'cancelled');

/** Cancelled orders never count towards orders or revenue. */
export function summarize(orders) {
  const done = counted(orders);
  const revenue = done.reduce((sum, order) => sum + order.total, 0);
  return {
    orders: done.length,
    revenue,
    averageOrder: done.length ? Math.round(revenue / done.length) : 0,
    cancelled: orders.length - done.length,
  };
}

export function change(current, previous) {
  return previous === 0 ? null : (current - previous) / previous;
}

export function bySource(orders) {
  const done = counted(orders);
  return ['qr', 'staff'].map((source) => {
    const mine = done.filter((order) => order.source === source);
    return { source, orders: mine.length, revenue: mine.reduce((sum, order) => sum + order.total, 0) };
  }).filter((row) => row.orders > 0);
}

/** Monday first: 0 = Monday … 6 = Sunday. */
export const weekdayOf = (date, timeZone) => (localParts(date, timeZone).weekday + 6) % 7;

export function byWeekday(orders, timeZone) {
  const counts = Array.from({ length: 7 }, () => 0);
  for (const order of counted(orders)) counts[weekdayOf(new Date(order.createdAt), timeZone)] += 1;
  return counts.map((total, day) => ({ day, orders: total }));
}

/** Every hour from the first to the last hour with an order. */
export function byHour(orders, timeZone) {
  const hours = counted(orders).map((order) => localParts(new Date(order.createdAt), timeZone).hour);
  if (hours.length === 0) return [];
  const first = Math.min(...hours);
  const last = Math.max(...hours);
  return Array.from({ length: last - first + 1 }, (_, index) => ({
    hour: first + index, orders: hours.filter((hour) => hour === first + index).length,
  }));
}

export function topItems(orders, limit = 10) {
  const items = new Map();
  for (const order of counted(orders)) {
    for (const item of order.items) {
      const row = items.get(item.name) ?? { quantity: 0, revenue: 0 };
      row.quantity += item.quantity;
      row.revenue += item.quantity * item.unitPrice;
      items.set(item.name, row);
    }
  }
  return [...items.entries()]
    .map(([name, row]) => ({ name, ...row }))
    .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
    .slice(0, limit);
}

export function byDay(orders, days, timeZone) {
  const done = counted(orders);
  return days.map((date) => {
    const mine = done.filter((order) => dayKey(new Date(order.createdAt), timeZone) === date);
    return { date, orders: mine.length, revenue: mine.reduce((sum, order) => sum + order.total, 0) };
  });
}

// The partner's date rules, run in the restaurant's own time zone instead of the browser's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { amountDueFor, isFirstBilledMonth } from '../../shared/rules/subscriptions.js';
import { endOfServiceDay, itemAvailability, scheduleOpen, scheduleText } from '../../shared/rules/menu.js';
import { defaultHours, openStatus, runsPastMidnight } from '../../shared/rules/service.js';
import { byDay, byHour, bySource, byWeekday, change, summarize, topItems } from '../../shared/rules/reports.js';
import { dayKey, daysInMonth, localParts, monthKey, startOfLocalDay } from '../../shared/time.js';

const PK = 'Asia/Karachi';
const UK = 'Europe/London';
// 2026-10-12 is a Monday.
const at = (local) => new Date(`${local}+05:00`);
const hours = (overrides = {}) => defaultHours().map((day) => ({ ...day, opensAt: '12:00', closesAt: '23:00', ...overrides[day.day] }));

test('open during the day, closed outside it', () => {
  const open = openStatus({ hours: hours(), pausedUntil: null }, at('2026-10-12T15:00:00'), PK);
  assert.equal(open.state, 'open');
  assert.equal(localParts(open.closesAt, PK).hour, 23);
  const closed = openStatus({ hours: hours(), pausedUntil: null }, at('2026-10-12T10:00:00'), PK);
  assert.equal(closed.state, 'closed');
  assert.equal(localParts(closed.opensAt, PK).hour, 12);
});

test('hours past midnight belong to the night before', () => {
  const late = hours({ 1: { closesAt: '02:00' } });
  assert.ok(runsPastMidnight({ opensAt: '12:00', closesAt: '02:00' }));
  assert.equal(openStatus({ hours: late, pausedUntil: null }, at('2026-10-13T01:30:00'), PK).state, 'open');
  assert.equal(openStatus({ hours: late, pausedUntil: null }, at('2026-10-13T02:30:00'), PK).state, 'closed');
});

test('a closed day is skipped when finding the next opening', () => {
  const status = openStatus({ hours: hours({ 2: { open: false } }), pausedUntil: null }, at('2026-10-12T23:30:00'), PK);
  assert.equal(status.state, 'closed');
  assert.equal(localParts(status.opensAt, PK).weekday, 3, 'opens Wednesday');
});

test('a pause wins while it lasts', () => {
  const now = at('2026-10-12T15:00:00');
  assert.equal(openStatus({ hours: hours(), pausedUntil: at('2026-10-12T16:00:00').toISOString() }, now, PK).state, 'paused');
  assert.equal(openStatus({ hours: hours(), pausedUntil: at('2026-10-12T14:00:00').toISOString() }, now, PK).state, 'open');
});

test('the same moment is a different opening state in each country', () => {
  const now = new Date('2026-10-12T10:30:00Z'); // 15:30 in Lahore, 11:30 in London
  assert.equal(openStatus({ hours: hours(), pausedUntil: null }, now, PK).state, 'open');
  assert.equal(openStatus({ hours: hours(), pausedUntil: null }, now, UK).state, 'closed');
});

test('UK opening times follow the clock change', () => {
  const before = openStatus({ hours: hours(), pausedUntil: null }, new Date('2026-10-24T09:00:00Z'), UK);
  assert.equal(before.opensAt.toISOString(), '2026-10-24T11:00:00.000Z', 'British Summer Time');
  const after = openStatus({ hours: hours(), pausedUntil: null }, new Date('2026-10-26T09:00:00Z'), UK);
  assert.equal(after.opensAt.toISOString(), '2026-10-26T12:00:00.000Z', 'Greenwich Mean Time');
});

test('availability: hidden beats sold out, and sold out ends on its own', () => {
  const now = at('2026-10-12T15:00:00');
  const later = at('2026-10-13T05:00:00').toISOString();
  assert.equal(itemAvailability({ available: true, soldOutUntil: null }, now), 'available');
  assert.equal(itemAvailability({ available: true, soldOutUntil: later }, now), 'sold_out');
  assert.equal(itemAvailability({ available: true, soldOutUntil: later }, at('2026-10-13T06:00:00')), 'available');
  assert.equal(itemAvailability({ available: false, soldOutUntil: later }, now), 'hidden');
});

test('sold out today lasts until 5 am local time', () => {
  assert.equal(endOfServiceDay(at('2026-10-12T21:30:00'), PK), at('2026-10-13T05:00:00').toISOString());
  assert.equal(endOfServiceDay(at('2026-10-13T01:15:00'), PK), at('2026-10-13T05:00:00').toISOString(), 'after midnight: same morning');
  assert.equal(endOfServiceDay(new Date('2026-11-09T21:00:00Z'), UK), '2026-11-10T05:00:00.000Z');
});

test('time-based menus, including windows past midnight and seasons', () => {
  const breakfast = { days: [1], from: '07:00', to: '12:00', until: null };
  assert.ok(scheduleOpen(breakfast, at('2026-10-12T08:00:00'), PK));
  assert.ok(!scheduleOpen(breakfast, at('2026-10-12T12:00:00'), PK));
  const late = { days: [1], from: '22:00', to: '02:00', until: null };
  assert.ok(scheduleOpen(late, at('2026-10-13T01:00:00'), PK), 'Tuesday 1 am belongs to Monday');
  assert.ok(!scheduleOpen({ ...late, until: '2026-10-12' }, at('2026-10-13T01:00:00'), PK), 'season over');
  assert.equal(scheduleText({ days: [0, 1, 2, 3, 4, 5, 6], from: '07:00', to: '12:00', until: null }), 'Daily, 7:00 am – 12:00 pm');
  assert.equal(scheduleText({ days: [5, 6], from: '16:00', to: '19:00', until: '2027-03-20' }), 'Fri, Sat, 4:00 pm – 7:00 pm, until 20 Mar');
});

test('billing: the first month is charged from the day billing starts', () => {
  assert.equal(amountDueFor('2026-10', 31_000, '2026-10-21T10:00:00+05:00', PK), 11_000);
  assert.ok(isFirstBilledMonth('2026-10', '2026-10-21T10:00:00+05:00', PK));
  assert.equal(amountDueFor('2026-11', 25_000, '2026-10-21T10:00:00+05:00', PK), 25_000);
  assert.equal(amountDueFor('2026-09', 25_000, '2026-10-21T10:00:00+05:00', PK), 0);
  assert.equal(amountDueFor('2026-10', 25_000, null, PK), 0, 'a trial pays nothing');
  assert.equal(amountDueFor('2026-11', 25_000, '2026-11-01T09:00:00+05:00', PK), 25_000);
  assert.ok(!isFirstBilledMonth('2026-11', '2026-11-01T09:00:00+05:00', PK));
});

test('billing uses the restaurant’s date, not the server’s', () => {
  const lateEvening = '2026-10-31T20:00:00Z'; // already 1 November in Lahore, still 31 October in London
  assert.equal(amountDueFor('2026-11', 30_000, lateEvening, PK), 30_000);
  assert.ok(!isFirstBilledMonth('2026-11', lateEvening, PK));
  assert.equal(amountDueFor('2026-10', 31_000, lateEvening, UK), 1_000);
});

test('report sums leave out cancelled orders and group by the local day and hour', () => {
  const order = (overrides) => ({ status: 'served', total: 1000, source: 'qr', createdAt: '2026-10-09T19:30:00+05:00', items: [{ name: 'Biryani', quantity: 2, unitPrice: 450 }], ...overrides });
  const orders = [
    order({}),
    order({ total: 500, items: [{ name: 'Raita', quantity: 1, unitPrice: 500 }] }),
    order({ status: 'cancelled', total: 9000 }),
    order({ total: 1500, source: 'staff', createdAt: '2026-10-10T13:10:00+05:00' }),
  ];
  const sums = summarize(orders);
  assert.deepEqual([sums.orders, sums.revenue, sums.averageOrder, sums.cancelled], [3, 3000, 1000, 1]);
  assert.equal(change(110, 100), 0.1);
  assert.equal(change(5, 0), null);
  assert.deepEqual(bySource(orders).map((row) => [row.source, row.orders, row.revenue]), [['qr', 2, 1500], ['staff', 1, 1500]]);
  assert.equal(byWeekday(orders, PK)[4].orders, 2, 'two on Friday 9 October');
  assert.deepEqual(byHour(orders, PK).map((row) => row.hour), [13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(topItems(orders)[0], { name: 'Biryani', quantity: 4, revenue: 1800 });
  assert.deepEqual(byDay(orders, ['2026-10-09'], PK), [{ date: '2026-10-09', orders: 2, revenue: 1500 }]);
});

test('day and month helpers cross boundaries in local time', () => {
  const instant = new Date('2026-10-31T20:00:00Z');
  assert.equal(dayKey(instant, PK), '2026-11-01');
  assert.equal(dayKey(instant, UK), '2026-10-31');
  assert.equal(monthKey(instant, PK), '2026-11');
  assert.equal(monthKey(instant, PK, -1), '2026-10');
  assert.equal(monthKey(new Date('2026-01-15T00:00:00Z'), UK, -1), '2025-12');
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(startOfLocalDay(instant, PK).toISOString(), '2026-10-31T19:00:00.000Z');
});

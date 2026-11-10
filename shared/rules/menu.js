// Ported from the partner's packages/core/src/menu. Keep the two in step.
// Difference: every time check uses the restaurant's time zone, not the browser's.
import { dayKey, localDay, localParts, zonedToUtc } from '../time.js';

export function itemAvailability(item, now = new Date()) {
  if (!item.available) return 'hidden';
  if (item.soldOutUntil && new Date(item.soldOutUntil).getTime() > now.getTime()) return 'sold_out';
  return 'available';
}

/** Sold out "for today" lasts until 5 am local time, so a 1 am sell-out returns for the next service. */
export function endOfServiceDay(now, timeZone) {
  const offset = localParts(now, timeZone).hour >= 5 ? 1 : 0;
  return zonedToUtc(localDay(now, timeZone, offset), 5 * 60, timeZone).toISOString();
}

export const MENU_PHOTO_MAX_PX = 640;
export const MENU_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const MENU_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** A window that runs past midnight belongs to the day it starts on. */
export function scheduleOpen(schedule, now, timeZone) {
  if (!schedule) return true;
  if (schedule.until && dayKey(now, timeZone) > schedule.until) return false;
  const from = minutes(schedule.from);
  const to = minutes(schedule.to);
  const local = localParts(now, timeZone);
  const at = local.hour * 60 + local.minute;
  const today = local.weekday;
  const yesterday = (today + 6) % 7;
  if (from < to) return schedule.days.includes(today) && at >= from && at < to;
  return (schedule.days.includes(today) && at >= from) || (schedule.days.includes(yesterday) && at < to);
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clock12 = (time) => {
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 === 0 ? 12 : hour % 12}:${time.slice(3, 5)} ${hour < 12 ? 'am' : 'pm'}`;
};

/** "Daily, 7:00 am – 12:00 pm", "Fri, Sat, 4:00 pm – 7:00 pm, until 20 Mar" */
export function scheduleText(schedule) {
  const days = schedule.days.length === 7 ? 'Daily' : [...schedule.days].sort().map((day) => DAY_SHORT[day]).join(', ');
  const until = schedule.until
    ? `, until ${new Date(`${schedule.until}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`
    : '';
  return `${days}, ${clock12(schedule.from)} – ${clock12(schedule.to)}${until}`;
}

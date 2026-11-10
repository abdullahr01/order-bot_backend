// Ported from the partner's packages/core/src/service. Keep the two in step.
// Difference: opening hours are worked out in the restaurant's time zone.
import { localDay, zonedToUtc } from '../time.js';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const minutesOf = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** Noon until 1 am, every day. */
export function defaultHours() {
  return DAY_NAMES.map((_, day) => ({ day, open: true, opensAt: '12:00', closesAt: '01:00' }));
}

/** A closing time at or before the opening time runs past midnight. */
export const runsPastMidnight = (hours) => minutesOf(hours.closesAt) <= minutesOf(hours.opensAt);

/** The service window containing `now`, looking at today and the night before. */
function currentWindow(hours, now, timeZone) {
  for (const offset of [0, -1]) {
    const base = localDay(now, timeZone, offset);
    const day = hours.find((entry) => entry.day === base.weekday);
    if (!day?.open) continue;
    const start = zonedToUtc(base, minutesOf(day.opensAt), timeZone);
    const end = zonedToUtc(base, minutesOf(day.closesAt) + (runsPastMidnight(day) ? 24 * 60 : 0), timeZone);
    if (now >= start && now < end) return { start, end };
  }
  return null;
}

function nextOpening(hours, now, timeZone) {
  for (let offset = 0; offset <= 7; offset += 1) {
    const base = localDay(now, timeZone, offset);
    const day = hours.find((entry) => entry.day === base.weekday);
    if (!day?.open) continue;
    const start = zonedToUtc(base, minutesOf(day.opensAt), timeZone);
    if (start > now) return start;
  }
  return null;
}

/** Whether diners can order right now, and until when. */
export function openStatus({ hours, pausedUntil }, now, timeZone) {
  const window = currentWindow(hours, now, timeZone);
  const paused = pausedUntil ? new Date(pausedUntil) : null;
  if (paused && paused > now) return { state: 'paused', until: paused, closesAt: window?.end ?? null };
  if (window) return { state: 'open', closesAt: window.end };
  return { state: 'closed', opensAt: nextOpening(hours, now, timeZone) };
}

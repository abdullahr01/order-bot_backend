// Restaurant-local dates. Timestamps are UTC; a restaurant's day, month, opening
// hours and sold-out reset all follow its own time zone (Asia/Karachi, Europe/London).
const formatters = new Map();
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const pad = (value) => String(value).padStart(2, '0');

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return formatters.get(timeZone);
}

export function localParts(date, timeZone) {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
  };
}

/** "2026-10-27" in the restaurant's own day. */
export function dayKey(date, timeZone) {
  const { year, month, day } = localParts(date, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "2026-10" in the restaurant's own month, optionally months before or after. */
export function monthKey(date, timeZone, offset = 0) {
  const { year, month } = localParts(date, timeZone);
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

export function daysInMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

/** The local calendar day `offset` days from the one containing `date`. */
export function localDay(date, timeZone, offset = 0) {
  const { year, month, day } = localParts(date, timeZone);
  const shifted = new Date(Date.UTC(year, month - 1, day + offset));
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: shifted.getUTCDay(),
  };
}

/** The instant a local wall-clock time happens. Minutes past 24:00 run into the next day. */
export function zonedToUtc({ year, month, day }, minutes, timeZone) {
  const target = Date.UTC(year, month - 1, day, 0, minutes);
  let guess = target;
  // Two passes settle the offset, including across a clock change.
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = localParts(new Date(guess), timeZone);
    guess += target - Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
  }
  return new Date(guess);
}

/** The start of a restaurant's local day. */
export const startOfLocalDay = (date, timeZone, offset = 0) => zonedToUtc(localDay(date, timeZone, offset), 0, timeZone);

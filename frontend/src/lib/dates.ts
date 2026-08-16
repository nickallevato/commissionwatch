/**
 * The one place a calendar date or an instant gets turned into text.
 *
 * Before this module existed, four pages each solved the same
 * `new Date("2024-12-10")`-is-UTC-midnight bug a different way — every one of
 * them carrying a comment explaining the hazard, none of them noticing the
 * duplication — and three more called bare `toLocaleString()` with no locale
 * and no timezone label, so a correction's timestamp rendered in whatever
 * zone the reader's browser happened to be set to. See
 * `docs/superpowers/specs/2026-08-16-design-review.md` § "Date formatting has
 * five implementations".
 *
 * Every export here takes the malformed-input path the same way: return the
 * input unchanged. Never throw, never render "Invalid Date" — a raw string on
 * the page is honest about not having been parsed; a guess is not.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Format a `YYYY-MM-DD` (or full ISO timestamp) as "August 14, 2026".
 *
 * Parsed off the string rather than through `Date`, because
 * `new Date("2024-12-10")` is UTC midnight and renders as the previous day
 * west of Greenwich.
 */
export function formatDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  const name = MONTHS[month - 1];
  if (!year || !name || !day) return iso;
  return `${name} ${day}, ${year}`;
}

/**
 * Format a `YYYY-MM-DD` (or full ISO timestamp) as "Fri, Aug 14, 2026".
 *
 * Same string-parse discipline as `formatDay` — the weekday is computed from
 * a UTC-midnight `Date` built from the parsed parts, never from parsing the
 * original string directly, so it cannot slide a day either.
 */
export function formatDayShort(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const name = MONTHS_SHORT[month - 1];
  if (!year || !name || !day) return iso;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return iso;
  return `${WEEKDAYS_SHORT[date.getUTCDay()]}, ${name} ${day}, ${year}`;
}

/**
 * Format an ISO instant as "2026-08-14 at 17:02 UTC".
 *
 * A time-of-day without a timezone label is a defect, not a style choice: it
 * renders in whatever zone the reader's browser happens to be set to, silently.
 * UTC is always named, matching the convention `SourcePage.tsx` established
 * for a document's fetch time.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const asIso = date.toISOString();
  return `${asIso.slice(0, 10)} at ${asIso.slice(11, 16)} UTC`;
}

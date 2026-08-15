import type { Knex } from "knex";
import { whereMeetingPublished } from "../publication";

/**
 * The corpus in Open Civic Data's shape.
 *
 * Every other export here is CSV built for a person opening a spreadsheet. This
 * one is for a second organisation ingesting the record without writing an
 * adapter for us — which is the difference between data that is *visible* and
 * data that is *reusable*, and it is the whole argument for using somebody
 * else's schema rather than our own.
 *
 * OCD is the established vocabulary for exactly this material: `Event` for a
 * meeting, `EventAgendaItem` for what was on the agenda. We follow it rather
 * than inventing a shape, and where our record cannot fill a field we omit the
 * field instead of guessing at it.
 *
 * ## `sources` is the load-bearing part
 *
 * OCD requires `sources` to have at least one entry, which is that schema's way
 * of stating this project's oldest invariant: no unsourced claim. So a meeting
 * with no recorded source URL is **excluded from the export and counted**,
 * never emitted with a fabricated or inferred source. `omitted_unsourced` in
 * the envelope is that count, published rather than hidden — a consumer needs
 * to know the export is incomplete, and by how much.
 *
 * ## The wall
 *
 * Published meetings only, through `whereMeetingPublished` rather than a
 * retyped predicate. A bulk export is the easiest place in the product to walk
 * through the wall by accident, because it takes no id and nobody has to guess
 * one — the same reason `/api/anomalies`, `/search` and the sitemap each needed
 * their own guard.
 */

/** OCD's status vocabulary. Ours is a superset of nothing; it maps cleanly. */
const OCD_STATUS: Readonly<Record<string, string>> = {
  scheduled: "confirmed",
  completed: "passed",
  cancelled: "cancelled",
};

export interface OcdSource {
  url: string;
  note: string;
}

export interface OcdAgendaItem {
  description: string;
  order: string;
}

export interface OcdEvent {
  /** OCD's own identifier convention for a locally-issued id. */
  _id: string;
  name: string;
  /** ISO date. OCD permits a date or a datetime; we have dates. */
  start_date: string;
  status: string;
  classification: "committee-meeting";
  jurisdiction: string;
  agenda: OcdAgendaItem[];
  sources: OcdSource[];
}

export interface OcdExport {
  /** What shape this is, so a consumer need not infer it from the contents. */
  schema: "open-civic-data/event";
  generated_at: string;
  /** Events actually emitted. */
  count: number;
  /**
   * Published meetings withheld because no source URL is recorded for them.
   *
   * Stated rather than silently dropped: OCD's `sources` minItems is a promise
   * a consumer relies on, and quietly shrinking the export to keep the promise
   * would make this file disagree with `/api/data/meetings.csv` for a reason
   * nobody could see.
   */
  omitted_unsourced: number;
  events: OcdEvent[];
}

interface MeetingRow {
  id: string;
  date: Date | string;
  status: string | null;
  agenda_url: string | null;
  minutes_url: string | null;
  commission_name: string | null;
  jurisdiction_name: string | null;
  jurisdiction_state: string | null;
}

interface ItemRow {
  meeting_id: string;
  item_number: number;
  title: string;
  description: string | null;
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

/**
 * OCD's jurisdiction identifiers are `ocd-jurisdiction/country:us/state:mt/...`
 * and are issued by a registry we are not part of. Emitting a plausible-looking
 * one would be inventing an identifier in somebody else's namespace, so this
 * carries the plain name and a consumer maps it themselves.
 */
function jurisdictionLabel(row: MeetingRow): string {
  const parts = [row.jurisdiction_name, row.jurisdiction_state].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.join(", ") || "unknown";
}

function sourcesFor(row: MeetingRow): OcdSource[] {
  const sources: OcdSource[] = [];
  if (row.agenda_url) sources.push({ url: row.agenda_url, note: "agenda" });
  if (row.minutes_url) sources.push({ url: row.minutes_url, note: "minutes" });
  return sources;
}

export async function buildOcdExport(db: Knex, now: Date = new Date()): Promise<OcdExport> {
  const meetings: MeetingRow[] = await whereMeetingPublished(
    db("meetings")
      .join("commissions", "commissions.id", "meetings.commission_id")
      .join("jurisdictions", "jurisdictions.id", "commissions.jurisdiction_id"),
    "meetings.published_at",
  )
    .select(
      "meetings.id",
      "meetings.date",
      "meetings.status",
      "meetings.agenda_url",
      "meetings.minutes_url",
      "commissions.name as commission_name",
      "jurisdictions.name as jurisdiction_name",
      "jurisdictions.state as jurisdiction_state",
    )
    .orderBy("meetings.date", "desc");

  const ids = meetings.map((meeting) => meeting.id);
  const items: ItemRow[] =
    ids.length === 0
      ? []
      : await db("agenda_items")
          .whereIn("meeting_id", ids)
          .select("meeting_id", "item_number", "title", "description")
          .orderBy([
            { column: "meeting_id", order: "asc" },
            { column: "item_number", order: "asc" },
          ]);

  const itemsByMeeting = new Map<string, ItemRow[]>();
  for (const item of items) {
    const list = itemsByMeeting.get(item.meeting_id);
    if (list) list.push(item);
    else itemsByMeeting.set(item.meeting_id, [item]);
  }

  const events: OcdEvent[] = [];
  let omitted = 0;

  for (const meeting of meetings) {
    const sources = sourcesFor(meeting);
    if (sources.length === 0) {
      omitted += 1;
      continue;
    }

    events.push({
      _id: `ocd-event/${meeting.id}`,
      name: `${meeting.commission_name ?? "Meeting"} — ${isoDate(meeting.date)}`,
      start_date: isoDate(meeting.date),
      status: OCD_STATUS[meeting.status ?? ""] ?? "confirmed",
      classification: "committee-meeting",
      jurisdiction: jurisdictionLabel(meeting),
      agenda: (itemsByMeeting.get(meeting.id) ?? []).map((item) => ({
        // OCD's EventAgendaItem carries a free-text description. Our title is
        // the item as printed; the description is the body where there is one.
        description: item.description ? `${item.title} — ${item.description}` : item.title,
        order: String(item.item_number),
      })),
      sources,
    });
  }

  return {
    schema: "open-civic-data/event",
    generated_at: now.toISOString(),
    count: events.length,
    omitted_unsourced: omitted,
    events,
  };
}

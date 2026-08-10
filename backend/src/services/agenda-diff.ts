import type { Knex } from "knex";

/**
 * P5 · The agenda diff timeline.
 *
 * What changed in an agenda, and how close to the vote.
 *
 * Two rules govern everything in this file.
 *
 * **Diff items, never bytes.** Two PDF renderings of an identical agenda differ
 * in their creation timestamp and their generator string. A byte diff would
 * report that as a change and a reader would have no way to tell it from a real
 * one. The unit a reader cares about is the agenda item, so that is the unit
 * compared — the text extracted from each version, held in
 * `document_versions.item_snapshot`.
 *
 * **Describe the record, never the motive.** "Item 6 was added 19 hours before
 * the meeting" is a fact about two documents and their timestamps. Why it was
 * added is not ours to assert and nothing generated here may imply it. Every
 * string this module produces is reviewed against that sentence.
 */

// ---------------------------------------------------------------------------
// The per-version snapshot
// ---------------------------------------------------------------------------

/**
 * One agenda item as extracted from one artifact.
 *
 * Deliberately narrow. The description is not carried: it is the part most
 * likely to differ for formatting reasons alone, and a diff that reports a
 * rewrapped paragraph as a change to the record is noise wearing the costume of
 * a finding.
 */
export interface VersionItem {
  item_number: number;
  title: string;
}

/**
 * Reads a stored snapshot back.
 *
 * `null` means "not extracted" — a Word document the parser cannot read, an
 * artifact backfilled from before this table existed. It is not "no items", and
 * the two must never collapse into each other: one is a gap in what we know and
 * the other is a claim about the agenda.
 *
 * A malformed row reads as `null` for the same reason. Half a snapshot would
 * produce a diff asserting removals that never happened.
 */
export function parseItemSnapshot(value: unknown): VersionItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: VersionItem[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const itemNumber = record.item_number;
    const title = record.title;
    if (typeof itemNumber !== "number" || !Number.isFinite(itemNumber)) return null;
    if (typeof title !== "string") return null;
    items.push({ item_number: itemNumber, title });
  }
  return items;
}

/** The snapshot the parse stage writes, from the drafts it just extracted. */
export function snapshotFromDrafts(
  drafts: ReadonlyArray<{ itemNumber: number; title: string }>,
): VersionItem[] {
  return drafts.map((draft) => ({ item_number: draft.itemNumber, title: draft.title }));
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

export type AgendaChangeKind = "added" | "removed" | "retitled";

export interface AgendaChange {
  kind: AgendaChangeKind;
  item_number: number;
  title: string;
  /** Present only on `retitled`: the title this item carried in the older version. */
  previous_title?: string;
}

/**
 * Identity for diff purposes.
 *
 * Case and whitespace are extraction artefacts — a PDF line break becomes a
 * space, a heading is upper-cased by the template — so an item is matched on
 * its title with both flattened. Punctuation is kept: "Ordinance 2091" and
 * "Ordinance 2091.1" are different items and must not merge.
 */
export function normalizeTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function indexByTitle(items: readonly VersionItem[]): Map<string, VersionItem[]> {
  const index = new Map<string, VersionItem[]>();
  for (const item of items) {
    const key = normalizeTitle(item.title);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [item]);
    else bucket.push(item);
  }
  return index;
}

/**
 * Items added, removed and retitled between two extracted agendas.
 *
 * An item present in both, under the same title, is unchanged and is not
 * reported — including when it moved position. Reordering is not a change to
 * what the body will consider, and reporting it would bury the changes that
 * are.
 *
 * A retitle is inferred, never assumed: an unmatched removal and an unmatched
 * addition sharing an `item_number` are the same slot carrying different text.
 * Anything left unpaired stays a plain addition or removal, because guessing
 * which removal "became" which addition would put an invented relationship into
 * the published record.
 */
export function diffAgendaItems(
  from: readonly VersionItem[],
  to: readonly VersionItem[],
): AgendaChange[] {
  const fromIndex = indexByTitle(from);
  const toIndex = indexByTitle(to);

  const removed: VersionItem[] = [];
  for (const item of from) {
    const matches = toIndex.get(normalizeTitle(item.title))?.length ?? 0;
    if (matches === 0) removed.push(item);
  }
  const added: VersionItem[] = [];
  for (const item of to) {
    const matches = fromIndex.get(normalizeTitle(item.title))?.length ?? 0;
    if (matches === 0) added.push(item);
  }

  const changes: AgendaChange[] = [];
  const pairedAdds = new Set<VersionItem>();
  const pairedRemovals = new Set<VersionItem>();

  for (const removal of removed) {
    const partner = added.find(
      (candidate) => !pairedAdds.has(candidate) && candidate.item_number === removal.item_number,
    );
    if (partner === undefined) continue;
    pairedAdds.add(partner);
    pairedRemovals.add(removal);
    changes.push({
      kind: "retitled",
      item_number: partner.item_number,
      title: partner.title,
      previous_title: removal.title,
    });
  }

  for (const item of added) {
    if (pairedAdds.has(item)) continue;
    changes.push({ kind: "added", item_number: item.item_number, title: item.title });
  }
  for (const item of removed) {
    if (pairedRemovals.has(item)) continue;
    changes.push({ kind: "removed", item_number: item.item_number, title: item.title });
  }

  changes.sort((a, b) => a.item_number - b.item_number || a.kind.localeCompare(b.kind));
  return changes;
}

/** "2 items added, 1 removed" — counts only, in a fixed order. */
export function summariseChanges(changes: readonly AgendaChange[]): string {
  const counts: Record<AgendaChangeKind, number> = { added: 0, removed: 0, retitled: 0 };
  for (const change of changes) counts[change.kind] += 1;
  const parts: string[] = [];
  const label = (n: number, word: string): string => `${n} ${n === 1 ? "item" : "items"} ${word}`;
  if (counts.added > 0) parts.push(label(counts.added, "added"));
  if (counts.removed > 0) parts.push(label(counts.removed, "removed"));
  if (counts.retitled > 0) parts.push(label(counts.retitled, "retitled"));
  if (parts.length === 0) return "no change to the extracted items";
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

export interface DocumentVersionSummary {
  id: string;
  version_no: number;
  first_seen_at: string;
  sha256: string;
  byte_size: number;
  /** `null` when the version was never extracted — not the same as zero. */
  item_count: number | null;
}

export interface AgendaDiffPair {
  from: DocumentVersionSummary;
  to: DocumentVersionSummary;
  /** `null` when either side was never extracted, so no diff can be honest. */
  changes: AgendaChange[] | null;
  from_items: VersionItem[] | null;
  to_items: VersionItem[] | null;
}

export interface DocumentTimeline {
  document_id: string;
  title: string;
  document_type: string;
  url: string;
  versions: DocumentVersionSummary[];
  /** One entry per consecutive pair. Empty when the document has one version. */
  diffs: AgendaDiffPair[];
}

/** A `document_versions` row joined to its document and its artifact. */
export interface TimelineRow {
  document_id: string;
  document_title: string;
  document_type: string;
  document_url: string;
  version_id: string;
  version_no: number;
  first_seen_at: Date | string;
  sha256: string;
  byte_size: number;
  item_snapshot: unknown;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Groups rows into one timeline per document and diffs each consecutive pair.
 *
 * Pure, so the diff logic is testable without a database and the route is a
 * query plus this call.
 */
export function buildTimelines(rows: readonly TimelineRow[]): DocumentTimeline[] {
  const byDocument = new Map<string, TimelineRow[]>();
  for (const row of rows) {
    const bucket = byDocument.get(row.document_id);
    if (bucket === undefined) byDocument.set(row.document_id, [row]);
    else bucket.push(row);
  }

  const timelines: DocumentTimeline[] = [];
  for (const [documentId, group] of byDocument) {
    const ordered = [...group].sort((a, b) => a.version_no - b.version_no);
    const first = ordered[0];
    if (first === undefined) continue;

    const snapshots = ordered.map((row) => parseItemSnapshot(row.item_snapshot));
    const versions: DocumentVersionSummary[] = ordered.map((row, index) => ({
      id: row.version_id,
      version_no: row.version_no,
      first_seen_at: toIso(row.first_seen_at),
      sha256: row.sha256,
      byte_size: row.byte_size,
      item_count: snapshots[index]?.length ?? null,
    }));

    const diffs: AgendaDiffPair[] = [];
    for (let index = 1; index < ordered.length; index += 1) {
      const fromItems = snapshots[index - 1] ?? null;
      const toItems = snapshots[index] ?? null;
      const fromSummary = versions[index - 1];
      const toSummary = versions[index];
      if (fromSummary === undefined || toSummary === undefined) continue;
      diffs.push({
        from: fromSummary,
        to: toSummary,
        // A missing snapshot on either side means we cannot say what changed.
        // Reporting an empty change list would read as "nothing changed".
        changes:
          fromItems !== null && toItems !== null ? diffAgendaItems(fromItems, toItems) : null,
        from_items: fromItems,
        to_items: toItems,
      });
    }

    timelines.push({
      document_id: documentId,
      title: first.document_title,
      document_type: first.document_type,
      url: first.document_url,
      versions,
      diffs,
    });
  }

  timelines.sort((a, b) => a.title.localeCompare(b.title) || a.document_id.localeCompare(b.document_id));
  return timelines;
}

/** Every version of every document on one meeting, oldest first. */
export async function loadTimelineRows(db: Knex, meetingId: string): Promise<TimelineRow[]> {
  const rows: unknown = await db("document_versions")
    .join("meeting_documents", "document_versions.meeting_document_id", "meeting_documents.id")
    .join("artifacts", "document_versions.artifact_id", "artifacts.id")
    .where("meeting_documents.meeting_id", meetingId)
    .orderBy([
      { column: "meeting_documents.title", order: "asc" },
      { column: "document_versions.version_no", order: "asc" },
    ])
    .select(
      "meeting_documents.id as document_id",
      "meeting_documents.title as document_title",
      "meeting_documents.document_type as document_type",
      "meeting_documents.url as document_url",
      "document_versions.id as version_id",
      "document_versions.version_no as version_no",
      "document_versions.first_seen_at as first_seen_at",
      "document_versions.item_snapshot as item_snapshot",
      "artifacts.sha256 as sha256",
      "artifacts.byte_size as byte_size",
    );
  return Array.isArray(rows) ? (rows as TimelineRow[]) : [];
}

export async function loadDocumentTimelines(
  db: Knex,
  meetingId: string,
): Promise<DocumentTimeline[]> {
  return buildTimelines(await loadTimelineRows(db, meetingId));
}

// ---------------------------------------------------------------------------
// When the meeting was scheduled to convene
// ---------------------------------------------------------------------------

/**
 * The UTC offset of `zone` at `instant`, in milliseconds.
 *
 * Derived from `Intl`, which knows the IANA database Node ships with, rather
 * than from a hardcoded −7. Montana observes daylight saving, and an agenda
 * republished in June must not be measured with November's offset.
 */
function zoneOffsetMs(instant: Date, zone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = new Map(
    formatter.formatToParts(instant).map((part) => [part.type, part.value] as const),
  );
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.get(type) ?? "0");
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
  return asUtc - instant.getTime();
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/u;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})/u;

/**
 * The instant a meeting was scheduled to convene, or `null`.
 *
 * `null` whenever `meetings.time` is absent, which is the common case for a
 * completed Granicus meeting. A meeting with no published hour has no known
 * hour, and assuming midnight would manufacture the very number the finding
 * reports — every agenda for such a meeting would appear to land on the day
 * itself. Not knowing is reported as not knowing.
 */
export function scheduledInstant(
  date: Date | string | null | undefined,
  time: string | null | undefined,
  zone: string,
): Date | null {
  if (date === null || date === undefined) return null;
  if (typeof time !== "string") return null;

  const timeParts = TIME_PATTERN.exec(time.trim());
  if (timeParts === null) return null;
  const hour = Number(timeParts[1]);
  const minute = Number(timeParts[2]);
  if (hour > 23 || minute > 59) return null;

  let year: number;
  let month: number;
  let day: number;
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) return null;
    // `pg` parses a bare DATE into local midnight, so the calendar parts are
    // the local ones. Reading UTC parts here would slip a day west of Greenwich.
    year = date.getFullYear();
    month = date.getMonth() + 1;
    day = date.getDate();
  } else {
    const dateParts = DATE_PATTERN.exec(date);
    if (dateParts === null) return null;
    year = Number(dateParts[1]);
    month = Number(dateParts[2]);
    day = Number(dateParts[3]);
  }

  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  try {
    // Two passes: the offset is looked up at a provisional instant, then
    // re-checked at the corrected one. They differ only across a DST boundary,
    // and taking the second reading is what makes the hour on either side of it
    // right.
    const provisional = zoneOffsetMs(new Date(wallClock), zone);
    const corrected = zoneOffsetMs(new Date(wallClock - provisional), zone);
    return new Date(wallClock - corrected);
  } catch {
    // An unknown IANA zone. Refusing to produce an instant means the finding is
    // not raised, which is the safe direction: no claim beats a wrong one.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The finding
// ---------------------------------------------------------------------------

export const DEFAULT_AGENDA_CHANGE_WINDOW_HOURS = 48;

export interface AgendaChangeFlagDraft {
  meeting_id: string;
  flag_type: "last_minute_agenda_change";
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  review_state: "published" | "held";
  metadata: Record<string, unknown>;
}

export interface AgendaChangeInput {
  meetingId: string;
  /** `null` when the meeting publishes no time — no window can be measured. */
  scheduledAt: Date | null;
  windowHours: number;
  timelines: readonly DocumentTimeline[];
  /** Roster names for the jurisdiction, used to decide whether to hold. */
  memberNames: readonly string[];
}

function hoursBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

/**
 * Whether any changed item names someone on the roster.
 *
 * Nothing naming a person auto-publishes. The test is mechanical — a roster
 * name appearing in a changed title — and it errs towards holding: a name is
 * matched case-insensitively anywhere in the text, so "Karen Smith Park" holds
 * a flag that names no person. An operator releasing an over-held flag is a
 * minute of work; an under-held one is published before anyone looks.
 */
function namesAPerson(
  changes: readonly AgendaChange[],
  documentTitle: string,
  memberNames: readonly string[],
): boolean {
  const haystack = [
    // The document title is checked too, because it is quoted verbatim in the
    // description. Everything that reaches the page is tested, not just the
    // evidence list.
    documentTitle,
    ...changes.map((change) => `${change.title} ${change.previous_title ?? ""}`),
  ]
    .join(" ")
    .toLocaleLowerCase("en-US");
  return memberNames.some((name) => {
    const needle = name.trim().toLocaleLowerCase("en-US");
    return needle.length > 0 && haystack.includes(needle);
  });
}

function severityFor(hoursBefore: number): AgendaChangeFlagDraft["severity"] {
  if (hoursBefore < 24) return "high";
  return "medium";
}

/**
 * One flag per version that first appeared inside the window before the meeting.
 *
 * Narrowed from the spec's "within N hours of" to "within N hours **before**".
 * A revision published after a body has met is a different fact about the
 * record — it cannot have changed what was voted on — and folding the two into
 * one flag type would make the flag mean two things.
 *
 * A pair whose diff could not be computed still raises nothing: without both
 * snapshots there is no item list, and the invariant requires the evidence to
 * carry one. The republication is still visible on the timeline, which states
 * what is known without asserting what is not.
 */
export function agendaChangeFlags(input: AgendaChangeInput): AgendaChangeFlagDraft[] {
  const { scheduledAt, windowHours } = input;
  if (scheduledAt === null || !Number.isFinite(windowHours) || windowHours <= 0) return [];

  const flags: AgendaChangeFlagDraft[] = [];
  for (const timeline of input.timelines) {
    for (const pair of timeline.diffs) {
      if (pair.changes === null || pair.changes.length === 0) continue;
      const firstSeen = new Date(pair.to.first_seen_at);
      if (Number.isNaN(firstSeen.getTime())) continue;
      const hoursBefore = hoursBetween(firstSeen, scheduledAt);
      if (hoursBefore < 0 || hoursBefore > windowHours) continue;

      const rounded = Math.round(hoursBefore);
      const held = namesAPerson(pair.changes, timeline.title, input.memberNames);
      flags.push({
        meeting_id: input.meetingId,
        flag_type: "last_minute_agenda_change",
        severity: severityFor(hoursBefore),
        review_state: held ? "held" : "published",
        // States what the two documents are and when they appeared. It does not
        // say the change was late in any sense but the arithmetic one, and it
        // offers no reason for it.
        description:
          `"${timeline.title}" was republished ${rounded} ${rounded === 1 ? "hour" : "hours"} ` +
          `before the scheduled start: ${summariseChanges(pair.changes)}. ` +
          `Version ${pair.from.version_no} was first seen ${pair.from.first_seen_at}; ` +
          `version ${pair.to.version_no} was first seen ${pair.to.first_seen_at}.`,
        metadata: {
          document_id: timeline.document_id,
          document_title: timeline.title,
          document_url: timeline.url,
          from_version: pair.from.version_no,
          to_version: pair.to.version_no,
          // Both artifact hashes. The claim is checkable against the stored
          // bytes by anyone who has them.
          from_sha256: pair.from.sha256,
          to_sha256: pair.to.sha256,
          from_first_seen_at: pair.from.first_seen_at,
          to_first_seen_at: pair.to.first_seen_at,
          scheduled_at: scheduledAt.toISOString(),
          hours_before: Number(hoursBefore.toFixed(2)),
          window_hours: windowHours,
          changes: pair.changes,
        },
      });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Loading the inputs the finding needs
// ---------------------------------------------------------------------------

export interface AgendaChangeSettings {
  windowHours: number;
  timezone: string;
  memberNames: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The jurisdiction's window, zone and roster, reached through the commission.
 *
 * Falls back to the documented defaults rather than throwing: a meeting whose
 * jurisdiction row has gone missing is a data problem, not a reason for the
 * whole detection run to fail.
 */
export async function loadAgendaChangeSettings(
  db: Knex,
  commissionId: string,
): Promise<AgendaChangeSettings> {
  const row: unknown = await db("commissions")
    .join("jurisdictions", "commissions.jurisdiction_id", "jurisdictions.id")
    .where("commissions.id", commissionId)
    .first(
      "jurisdictions.id as jurisdiction_id",
      "jurisdictions.agenda_change_window_hours as window_hours",
      "jurisdictions.timezone as timezone",
    );
  const record = asRecord(row);
  if (record === null) {
    return {
      windowHours: DEFAULT_AGENDA_CHANGE_WINDOW_HOURS,
      timezone: "America/Denver",
      memberNames: [],
    };
  }

  const windowHours = Number(record.window_hours);
  const memberRows: unknown = await db("members")
    .where({ jurisdiction_id: record.jurisdiction_id })
    .select("name");
  const memberNames: string[] = [];
  for (const memberRow of Array.isArray(memberRows) ? memberRows : []) {
    const member = asRecord(memberRow);
    if (member !== null && typeof member.name === "string") memberNames.push(member.name);
  }

  return {
    windowHours:
      Number.isFinite(windowHours) && windowHours > 0
        ? windowHours
        : DEFAULT_AGENDA_CHANGE_WINDOW_HOURS,
    timezone: typeof record.timezone === "string" && record.timezone !== ""
      ? record.timezone
      : "America/Denver",
    memberNames,
  };
}

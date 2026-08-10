import type { Knex } from "knex";
import { financeCoverage, type FinanceCoverage } from "./finance/coverage";
import { parseVoteDonorEvidence, type VoteDonorEvidence } from "./finance/evidence";
import { whereFindingPublic, whereMeetingPublished } from "./publication";

/**
 * Officials as subjects, not as a roster line.
 *
 * Everything here reads through `publication.ts`. That is the whole of the
 * access rule and it is not restated: an unpublished meeting contributes no
 * vote, no timeline row, no attendance denominator and no month on the activity
 * strip, and an unapproved finding does not appear at all. A profile assembled
 * from ingested-but-unpublished records would publish the withheld record in
 * aggregate — arithmetic over a secret is still a disclosure of it — through a
 * page that takes an official's id rather than a meeting's, which is exactly
 * the shape of hole B-a closed on `/api/anomalies`.
 *
 * ## What is deliberately absent
 *
 * **There is no aggregate donor figure.** It would be easy to total every
 * federal contribution whose filed recipient name matches this official's and
 * print it at the top of the page, and it would be wrong twice over: it is a
 * name match presented as a fact about a named person, and no operator has
 * approved it. The donor overlay therefore shows *published findings only* —
 * claims a human read and released — and, when there are none, the coverage
 * note explaining which filing cabinet was opened. See `finance/coverage.ts`.
 *
 * **Attendance is not derived from meetings with no roll call.** A meeting that
 * recorded no votes says nothing about who was in the room, and counting it as
 * an absence would manufacture a statistic out of a clerk's formatting choice.
 * The denominator is meetings where this official has at least one recorded
 * vote, and the profile reports that denominator rather than hiding it.
 */

export interface OfficialSummary {
  id: string;
  jurisdiction_id: string;
  name: string;
  title: string | null;
  term_start: string;
  term_end: string | null;
  party: string | null;
  jurisdiction: { id: string; name: string; state: string } | null;
}

export interface VotingRecord {
  yes: number;
  no: number;
  abstain: number;
  absent: number;
  total: number;
}

export interface Attendance {
  /** Published meetings where this official has at least one recorded vote. */
  meetingsWithRollCall: number;
  present: number;
  absent: number;
  /** `null` when there is no roll call to compute a rate from. */
  rate: number | null;
}

export interface Alignment {
  /**
   * Votes on items where at least two officials voted and a majority position
   * exists. A unanimous item is comparable; a 2–2 tie is not.
   */
  comparableVotes: number;
  withMajority: number;
  /** `null` when nothing is comparable — never 0, which would read as "always dissents". */
  rate: number | null;
}

export interface ActivityMonth {
  /** `YYYY-MM`. */
  month: string;
  votes: number;
}

export interface TimelineEntry {
  meeting_id: string;
  date: string;
  commission_name: string;
  location: string | null;
  record: VotingRecord;
  /** Items where this official's position differed from the item's majority. */
  dissents: number;
}

export interface OfficialFinding {
  id: string;
  meeting_id: string | null;
  flag_type: string;
  severity: string;
  description: string;
  created_at: string;
  /** Present only on a `vote_donor_conflict` whose metadata parses. */
  evidence: VoteDonorEvidence | null;
}

export interface OfficialProfile {
  official: OfficialSummary;
  record: VotingRecord;
  attendance: Attendance;
  alignment: Alignment;
  activity: ActivityMonth[];
  timeline: TimelineEntry[];
  findings: OfficialFinding[];
  finance: FinanceCoverage;
}

interface VoteRow {
  id: string;
  meeting_id: string;
  agenda_item_id: string | null;
  vote: "yes" | "no" | "abstain" | "absent";
  date: string | Date;
  commission_name: string;
  location: string | null;
}

const ACTIVITY_MONTHS = 12;
const TIMELINE_LIMIT = 24;

export async function getOfficialProfile(
  db: Knex,
  id: string,
  options: { now?: Date } = {},
): Promise<OfficialProfile | null> {
  const member = (await db("members").where({ id }).first()) as
    | (Omit<OfficialSummary, "jurisdiction"> & Record<string, unknown>)
    | undefined;
  if (!member) return null;

  const jurisdiction = (await db("jurisdictions")
    .where({ id: member.jurisdiction_id })
    .first("id", "name", "state")) as OfficialSummary["jurisdiction"];

  const votes = (await whereMeetingPublished(
    db("votes as v")
      .join("meetings as m", "v.meeting_id", "m.id")
      .join("commissions as c", "m.commission_id", "c.id")
      .where("v.member_id", id),
    "m.published_at",
  ).select(
    "v.id",
    "v.meeting_id",
    "v.agenda_item_id",
    "v.vote",
    "m.date",
    "m.location",
    "c.name as commission_name",
  )) as VoteRow[];

  const majorities = await loadMajorities(db, votes);

  return {
    official: { ...(member as unknown as OfficialSummary), jurisdiction: jurisdiction ?? null },
    record: tally(votes),
    attendance: attendanceOf(votes),
    alignment: alignmentOf(votes, majorities),
    activity: activityOf(votes, options.now ?? new Date()),
    timeline: timelineOf(votes, majorities),
    findings: await loadFindings(db, id),
    finance: financeCoverage(),
  };
}

/* ------------------------------------------------------------------------- */

function emptyRecord(): VotingRecord {
  return { yes: 0, no: 0, abstain: 0, absent: 0, total: 0 };
}

function tally(votes: readonly VoteRow[]): VotingRecord {
  const record = emptyRecord();
  for (const vote of votes) {
    record[vote.vote] += 1;
    record.total += 1;
  }
  return record;
}

/**
 * The majority position on each item this official voted on, so both the
 * alignment rate and the per-meeting dissent count read from one computation.
 *
 * A tie has no majority and is excluded rather than resolved. `absent` is not a
 * position and never counts towards one.
 */
async function loadMajorities(
  db: Knex,
  votes: readonly VoteRow[],
): Promise<Map<string, string>> {
  const itemIds = Array.from(
    new Set(votes.map((vote) => vote.agenda_item_id).filter((value): value is string => Boolean(value))),
  );
  if (itemIds.length === 0) return new Map();

  const rows = (await db("votes")
    .whereIn("agenda_item_id", itemIds)
    .whereNot({ vote: "absent" })
    .select("agenda_item_id", "vote")
    .count("* as total")
    .groupBy("agenda_item_id", "vote")) as Array<{
    agenda_item_id: string;
    vote: string;
    total: string | number;
  }>;

  const byItem = new Map<string, Array<{ vote: string; total: number }>>();
  for (const row of rows) {
    const bucket = byItem.get(row.agenda_item_id) ?? [];
    bucket.push({ vote: row.vote, total: Number(row.total) });
    byItem.set(row.agenda_item_id, bucket);
  }

  const majorities = new Map<string, string>();
  for (const [itemId, tallies] of byItem) {
    const ordered = [...tallies].sort((left, right) => right.total - left.total);
    if (ordered.length === 0) continue;
    if (ordered.length > 1 && ordered[0].total === ordered[1].total) continue;
    majorities.set(itemId, ordered[0].vote);
  }
  return majorities;
}

function attendanceOf(votes: readonly VoteRow[]): Attendance {
  const byMeeting = new Map<string, boolean>();
  for (const vote of votes) {
    const present = byMeeting.get(vote.meeting_id) ?? false;
    byMeeting.set(vote.meeting_id, present || vote.vote !== "absent");
  }

  const meetingsWithRollCall = byMeeting.size;
  let present = 0;
  for (const wasPresent of byMeeting.values()) if (wasPresent) present += 1;

  return {
    meetingsWithRollCall,
    present,
    absent: meetingsWithRollCall - present,
    rate: meetingsWithRollCall === 0 ? null : round3(present / meetingsWithRollCall),
  };
}

function alignmentOf(votes: readonly VoteRow[], majorities: Map<string, string>): Alignment {
  let comparableVotes = 0;
  let withMajority = 0;

  for (const vote of votes) {
    if (!vote.agenda_item_id || vote.vote === "absent") continue;
    const majority = majorities.get(vote.agenda_item_id);
    if (!majority) continue;
    comparableVotes += 1;
    if (vote.vote === majority) withMajority += 1;
  }

  return {
    comparableVotes,
    withMajority,
    rate: comparableVotes === 0 ? null : round3(withMajority / comparableVotes),
  };
}

/**
 * Votes per calendar month over the last twelve, oldest first.
 *
 * Every month is present, including the empty ones. A strip that drew only the
 * months with votes would compress a six-month gap into a single narrow bar and
 * read as steady activity, which is the opposite of what the record says.
 */
function activityOf(votes: readonly VoteRow[], now: Date): ActivityMonth[] {
  const months: ActivityMonth[] = [];
  const index = new Map<string, number>();

  for (let offset = ACTIVITY_MONTHS - 1; offset >= 0; offset -= 1) {
    const point = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const key = `${point.getUTCFullYear()}-${String(point.getUTCMonth() + 1).padStart(2, "0")}`;
    index.set(key, months.length);
    months.push({ month: key, votes: 0 });
  }

  for (const vote of votes) {
    const key = isoDate(vote.date).slice(0, 7);
    const position = index.get(key);
    if (position !== undefined) months[position].votes += 1;
  }

  return months;
}

function timelineOf(votes: readonly VoteRow[], majorities: Map<string, string>): TimelineEntry[] {
  const byMeeting = new Map<string, TimelineEntry>();

  for (const vote of votes) {
    let entry = byMeeting.get(vote.meeting_id);
    if (!entry) {
      entry = {
        meeting_id: vote.meeting_id,
        date: isoDate(vote.date),
        commission_name: vote.commission_name,
        location: vote.location,
        record: emptyRecord(),
        dissents: 0,
      };
      byMeeting.set(vote.meeting_id, entry);
    }
    entry.record[vote.vote] += 1;
    entry.record.total += 1;

    if (vote.agenda_item_id && vote.vote !== "absent") {
      const majority = majorities.get(vote.agenda_item_id);
      if (majority && majority !== vote.vote) entry.dissents += 1;
    }
  }

  return Array.from(byMeeting.values())
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, TIMELINE_LIMIT);
}

/**
 * Published findings naming this official.
 *
 * The subject is identified through `metadata->>'memberId'`, which is what the
 * correlation rule writes. It is a `->>` comparison rather than a join because
 * `anomaly_flags` has no member column — and adding one would imply every
 * finding has a single subject, which the meeting-derived ones do not.
 */
async function loadFindings(db: Knex, memberId: string): Promise<OfficialFinding[]> {
  const query = db("anomaly_flags")
    .whereRaw("anomaly_flags.metadata->>'memberId' = ?", [memberId])
    .select(
      "anomaly_flags.id",
      "anomaly_flags.meeting_id",
      "anomaly_flags.flag_type",
      "anomaly_flags.severity",
      "anomaly_flags.description",
      "anomaly_flags.metadata",
      "anomaly_flags.created_at",
    )
    .orderBy("anomaly_flags.created_at", "desc");

  const rows = (await whereFindingPublic(db, query)) as Array<{
    id: string;
    meeting_id: string | null;
    flag_type: string;
    severity: string;
    description: string;
    metadata: unknown;
    created_at: string | Date;
  }>;

  return rows.map((row) => ({
    id: row.id,
    meeting_id: row.meeting_id,
    flag_type: row.flag_type,
    severity: row.severity,
    description: row.description,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    evidence: row.flag_type === "vote_donor_conflict" ? parseVoteDonorEvidence(row.metadata) : null,
  }));
}

function isoDate(value: string | Date): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
      value.getDate(),
    ).padStart(2, "0")}`;
  }
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : value;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

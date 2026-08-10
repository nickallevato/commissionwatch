import type { Knex } from "knex";
import {
  agendaChangeFlags,
  loadAgendaChangeSettings,
  loadDocumentTimelines,
  scheduledInstant,
} from "./agenda-diff";
import { checkVoteDonorConflict } from "./finance/correlation";
import { anomalyEvents } from "./notification";
import { loadPolicy, resolveReviewState } from "./review/policy";
import { ensureApprovalRequests } from "./review/queue";

/**
 * Bumped to 4.0.0: `vote_donor_conflict` is now raised by
 * `finance/correlation.ts`, where before nothing raised it at all. A
 * `detection_runs` row recording which rules produced a finding is only useful
 * if the version changes when the set of rules does.
 *
 * 3.0.0 was P5, where `last_minute_agenda_change` stopped meaning what it meant
 * in 2.0.0 — it is derived from document version history rather than from
 * ingestion timestamps.
 */
export const RULES_VERSION = "4.0.0";

/**
 * The shape the individual `check*` rules produce — an anomaly that has not
 * been persisted yet, so it has no `id`, `created_at` or `source`.
 *
 * `metadata` and `review_state` are optional and are set by the rules that have
 * evidence to record. `review_state` defaults to `published` in the database;
 * a rule whose evidence names a person must set `held` explicitly.
 */
export interface AnomalyFlag {
  meeting_id: string;
  flag_type: string;
  description: string;
  severity: string;
  agenda_item_id?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
  review_state?: "published" | "held";
}

/**
 * A persisted `anomaly_flags` row, as returned by `INSERT ... RETURNING *`.
 * This is what the detection endpoints serialize, so every column the API
 * contract declares required must be present here.
 */
export interface AnomalyFlagRow extends Omit<AnomalyFlag, "metadata" | "review_state"> {
  id: string;
  agenda_item_id: string | null;
  /** `null` on the wire, `undefined` on an unpersisted draft — hence the Omit. */
  metadata: Record<string, unknown> | null;
  source: string;
  /**
   * Required on a persisted row: the column is NOT NULL and the insert resolves
   * it through the threshold. Optional on a draft, where it means "the rule had
   * no opinion" rather than "published".
   */
  review_state: "published" | "held";
  created_at: string;
}

interface Meeting {
  id: string;
  commission_id: string;
  /** `pg` parses a bare `DATE` into a local-midnight `Date`. */
  date: string | Date;
  /** Nullable in migration 003. A completed Granicus meeting often has none. */
  time: string | null;
  status: string;
  agenda_url: string | null;
  minutes_url: string | null;
  created_at: string;
  updated_at: string;
}

interface AgendaItem {
  id: string;
  meeting_id: string;
  item_number: number;
  title: string;
  description: string | null;
  category: string | null;
  created_at: string;
}

export async function detectAnomalies(db: Knex, meetingId: string): Promise<AnomalyFlagRow[]> {
  const meeting = await db("meetings").where({ id: meetingId }).first() as Meeting | undefined;
  if (!meeting) return [];

  const runId = await startDetectionRun(db, meetingId);

  const flags: AnomalyFlag[] = [];

  const checks = [
    checkEmergencySession(db, meeting),
    checkMissingMinutes(db, meeting),
    checkQuorumIssue(db, meeting),
    checkLastMinuteAgendaChange(db, meeting),
    checkUnanimousControversial(db, meeting),
    checkClosedDoorVote(db, meeting),
    // The seventh rule, and the only one that reads a table outside the
    // meeting record. It returns drafts that are always `held`; see
    // `finance/correlation.ts` for why that is structural rather than a
    // severity decision.
    checkVoteDonorConflict(db, meeting),
  ];

  const results = await Promise.all(checks);
  for (const result of results) {
    if (Array.isArray(result)) {
      flags.push(...result);
    } else if (result) {
      flags.push(result);
    }
  }

  // The persisted rows — not `flags` — are what callers get back. The insert
  // adds `source` and the database fills in `id`, `created_at` and `metadata`,
  // none of which exist on the in-memory objects the rules produced.
  let inserted: AnomalyFlagRow[] = [];

  // B-b's replacement, applied at the moment a finding is written. A rule that
  // already said `held` — a changed agenda item naming someone on the roster —
  // stays held whatever the threshold says; the threshold can only add holds.
  const policy = await loadPolicy(db);

  await db.transaction(async (trx) => {
    await trx("anomaly_flags")
      .where({ meeting_id: meetingId, source: "auto" })
      .del();

    if (flags.length > 0) {
      // `metadata` is jsonb and is serialised here rather than in each rule, so
      // no rule can forget and hand Knex an object it will stringify as
      // `[object Object]`.
      const rows = flags.map(({ metadata, review_state, ...flag }) => ({
        ...flag,
        source: "auto",
        review_state: resolveReviewState(
          { severity: flag.severity, alwaysHold: review_state === "held" },
          policy,
        ),
        ...(metadata === undefined ? {} : { metadata: JSON.stringify(metadata) }),
      }));
      inserted = await trx("anomaly_flags").insert(rows).returning("*");
    }
  });

  await completeDetectionRun(db, runId, inserted.length);

  // Every held finding gets a queue entry here rather than waiting for someone
  // to open the console, so "how long has this been waiting?" is measured from
  // when it was raised.
  if (inserted.some((flag) => flag.review_state === "held")) {
    await ensureApprovalRequests(db, policy);
  }

  // **Only published findings are announced.** `IMMEDIATE_SEVERITIES` in the
  // notification service is exactly `critical` and `high` — the severities the
  // default threshold holds — so emitting the whole batch would withhold a
  // finding from the site and email it in the same breath.
  const announceable = inserted.filter((flag) => flag.review_state === "published");
  if (announceable.length > 0) {
    anomalyEvents.emit("anomaly.detected", announceable);
  }

  return inserted;
}

export async function detectAnomaliesBatch(
  db: Knex,
  options: { commission_id?: string; date_from?: string; date_to?: string; limit?: number },
): Promise<{ meetings_scanned: number; flags_created: number; flags_by_type: Record<string, number> }> {
  const limit = Math.min(options.limit || 100, 100);

  const query = db("meetings").select("id").orderBy("date", "desc").limit(limit);
  if (options.commission_id) query.where({ commission_id: options.commission_id });
  if (options.date_from) query.where("date", ">=", options.date_from);
  if (options.date_to) query.where("date", "<=", options.date_to);

  const meetings = await query;

  let totalFlags = 0;
  const flagsByType: Record<string, number> = {};

  for (const meeting of meetings) {
    const flags = await detectAnomalies(db, meeting.id);
    totalFlags += flags.length;
    for (const flag of flags) {
      flagsByType[flag.flag_type] = (flagsByType[flag.flag_type] || 0) + 1;
    }
  }

  return {
    meetings_scanned: meetings.length,
    flags_created: totalFlags,
    flags_by_type: flagsByType,
  };
}

async function startDetectionRun(db: Knex, meetingId: string): Promise<string> {
  const [run] = await db("detection_runs")
    .insert({ meeting_id: meetingId, rules_version: RULES_VERSION })
    .returning("id");
  return run.id ?? run;
}

async function completeDetectionRun(db: Knex, runId: string, flagsCreated: number): Promise<void> {
  await db("detection_runs")
    .where({ id: runId })
    .update({ flags_created: flagsCreated, completed_at: db.fn.now() });
}

export async function checkEmergencySession(_db: Knex, meeting: Meeting): Promise<AnomalyFlag | null> {
  if (meeting.status === "emergency" || meeting.status === "special") {
    return {
      meeting_id: meeting.id,
      flag_type: "emergency_session",
      description: `Meeting scheduled as ${meeting.status} session`,
      severity: "high",
    };
  }
  return null;
}

export async function checkMissingMinutes(_db: Knex, meeting: Meeting): Promise<AnomalyFlag | null> {
  const meetingDate = new Date(meeting.date);
  const daysSinceMeeting = (Date.now() - meetingDate.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceMeeting > 14 && !meeting.minutes_url) {
    let severity = "medium";
    if (daysSinceMeeting > 90) severity = "critical";
    else if (daysSinceMeeting > 60) severity = "high";
    else if (daysSinceMeeting > 30) severity = "high";

    return {
      meeting_id: meeting.id,
      flag_type: "missing_minutes",
      description: `Minutes not published ${Math.floor(daysSinceMeeting)} days after meeting`,
      severity,
    };
  }
  return null;
}

export async function checkQuorumIssue(db: Knex, meeting: Meeting): Promise<AnomalyFlag | null> {
  const memberCount = await db("members")
    .whereIn("jurisdiction_id", db("commissions").select("jurisdiction_id").where({ id: meeting.commission_id }))
    .where(function () {
      this.whereNull("term_end").orWhere("term_end", ">=", meeting.date);
    })
    .where(function () {
      this.whereNull("term_start").orWhere("term_start", "<=", meeting.date);
    })
    .count("* as total")
    .first();

  const total = Number(memberCount?.total ?? 0);
  if (total === 0) return null;

  const presentVotes = await db("votes")
    .where({ meeting_id: meeting.id })
    .whereNot({ vote: "absent" })
    .countDistinct("member_id as present")
    .first();

  const present = Number(presentVotes?.present ?? 0);
  if (present === 0) return null;

  const quorum = Math.floor(total / 2) + 1;
  if (present < quorum) {
    return {
      meeting_id: meeting.id,
      flag_type: "quorum_issue",
      description: `Only ${present} of ${total} members present (quorum requires ${quorum})`,
      severity: "critical",
    };
  }
  return null;
}

/**
 * Agendas republished inside the jurisdiction's window before the meeting.
 *
 * **This replaced a heuristic that could not be substantiated.** The previous
 * implementation compared `agenda_items.created_at` — the moment *we* ingested
 * a row — against the meeting date, and concluded from it that an item had been
 * "added less than 24 hours before meeting". For any meeting swept the day
 * before it convened, that flagged every item on the agenda, and published the
 * claim. It was a statement about our own database wearing the clothes of a
 * statement about the public record, which is the precise thing the project's
 * sourcing invariant forbids.
 *
 * What replaces it compares two published documents: version *n* of an agenda
 * and version *n+1*, the items extracted from each, and when each was first
 * seen. The evidence carries both artifact hashes, so the claim is checkable by
 * anyone holding the bytes. A meeting with one version of its agenda — the
 * common case — raises nothing, because nothing changed.
 */
export async function checkLastMinuteAgendaChange(db: Knex, meeting: Meeting): Promise<AnomalyFlag[]> {
  const settings = await loadAgendaChangeSettings(db, meeting.commission_id);
  const timelines = await loadDocumentTimelines(db, meeting.id);
  return agendaChangeFlags({
    meetingId: meeting.id,
    scheduledAt: scheduledInstant(meeting.date, meeting.time, settings.timezone),
    windowHours: settings.windowHours,
    timelines,
    memberNames: settings.memberNames,
  });
}

export async function checkUnanimousControversial(db: Knex, meeting: Meeting): Promise<AnomalyFlag[]> {
  const agendaItems: AgendaItem[] = await db("agenda_items")
    .where({ meeting_id: meeting.id })
    .select("id", "title", "category");

  const controversialCategories = ["public_hearing", "zoning", "budget", "ordinance"];
  const flags: AnomalyFlag[] = [];

  for (const item of agendaItems) {
    if (!item.category || !controversialCategories.includes(item.category.toLowerCase())) continue;

    const votes = await db("votes")
      .where({ agenda_item_id: item.id })
      .whereNot({ vote: "absent" });

    if (votes.length < 3) continue;

    const allSame = votes.every((v: { vote: string }) => v.vote === votes[0].vote);
    if (allSame) {
      flags.push({
        meeting_id: meeting.id,
        flag_type: "unanimous_controversial",
        description: `Unanimous ${votes[0].vote} vote on ${item.category} item "${item.title}" with ${votes.length} voting members`,
        severity: "low",
        agenda_item_id: item.id,
      });
    }
  }

  return flags;
}

const EXECUTIVE_SESSION_PATTERN = /\b(executive[_ ]session|closed[_ ]session)\b/i;
const PROCEDURAL_MOTION_PATTERN = /\bmotion to (enter|exit|return from)\b/i;

export async function checkClosedDoorVote(db: Knex, meeting: Meeting): Promise<AnomalyFlag[]> {
  const agendaItems: AgendaItem[] = await db("agenda_items")
    .where({ meeting_id: meeting.id })
    .select("id", "title", "description", "category");

  const flags: AnomalyFlag[] = [];

  for (const item of agendaItems) {
    const isExecutiveSession =
      (item.category && EXECUTIVE_SESSION_PATTERN.test(item.category)) ||
      EXECUTIVE_SESSION_PATTERN.test(item.title) ||
      (item.description && EXECUTIVE_SESSION_PATTERN.test(item.description));

    if (!isExecutiveSession) continue;
    if (PROCEDURAL_MOTION_PATTERN.test(item.title)) continue;

    const voteCount = await db("votes")
      .where({ agenda_item_id: item.id })
      .whereNot({ vote: "absent" })
      .count("* as total")
      .first();

    const total = Number(voteCount?.total ?? 0);
    if (total > 0) {
      flags.push({
        meeting_id: meeting.id,
        flag_type: "closed_door_vote",
        description: `${total} votes recorded on executive/closed session item "${item.title}"`,
        severity: "high",
        agenda_item_id: item.id,
      });
    }
  }

  return flags;
}

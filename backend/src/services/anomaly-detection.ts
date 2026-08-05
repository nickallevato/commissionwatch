import type { Knex } from "knex";
import { anomalyEvents } from "./notification";

export const RULES_VERSION = "2.0.0";

/**
 * The shape the individual `check*` rules produce — an anomaly that has not
 * been persisted yet, so it has no `id`, `created_at`, `metadata` or `source`.
 */
export interface AnomalyFlag {
  meeting_id: string;
  flag_type: string;
  description: string;
  severity: string;
  agenda_item_id?: string | null;
  source?: string;
}

/**
 * A persisted `anomaly_flags` row, as returned by `INSERT ... RETURNING *`.
 * This is what the detection endpoints serialize, so every column the API
 * contract declares required must be present here.
 */
export interface AnomalyFlagRow extends AnomalyFlag {
  id: string;
  agenda_item_id: string | null;
  metadata: Record<string, unknown> | null;
  source: string;
  created_at: string;
}

interface Meeting {
  id: string;
  commission_id: string;
  date: string;
  time: string;
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

  await db.transaction(async (trx) => {
    await trx("anomaly_flags")
      .where({ meeting_id: meetingId, source: "auto" })
      .del();

    if (flags.length > 0) {
      const rows = flags.map((f) => ({ ...f, source: "auto" }));
      inserted = await trx("anomaly_flags").insert(rows).returning("*");
    }
  });

  await completeDetectionRun(db, runId, inserted.length);

  if (inserted.length > 0) {
    anomalyEvents.emit("anomaly.detected", inserted);
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

export async function checkLastMinuteAgendaChange(db: Knex, meeting: Meeting): Promise<AnomalyFlag[]> {
  const agendaItems: AgendaItem[] = await db("agenda_items")
    .where({ meeting_id: meeting.id })
    .select("id", "title", "created_at");

  const flags: AnomalyFlag[] = [];
  const meetingDate = new Date(meeting.date);

  for (const item of agendaItems) {
    const createdAt = new Date(item.created_at);
    const hoursBeforeMeeting = (meetingDate.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
    if (hoursBeforeMeeting >= 0 && hoursBeforeMeeting < 24) {
      flags.push({
        meeting_id: meeting.id,
        flag_type: "last_minute_agenda_change",
        description: `Agenda item "${item.title}" added less than 24 hours before meeting`,
        severity: "medium",
        agenda_item_id: item.id,
      });
    }
  }

  return flags;
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

import type { Knex } from "knex";

interface AnomalyFlag {
  meeting_id: string;
  flag_type: string;
  description: string;
  severity: string;
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

export async function detectAnomalies(db: Knex, meetingId: string): Promise<AnomalyFlag[]> {
  const meeting = await db("meetings").where({ id: meetingId }).first() as Meeting | undefined;
  if (!meeting) return [];

  const flags: AnomalyFlag[] = [];

  const checks = [
    checkEmergencySession(db, meeting),
    checkMissingMinutes(db, meeting),
    checkQuorumIssue(db, meeting),
    checkLastMinuteAgendaChange(db, meeting),
    checkUnanimousControversial(db, meeting),
  ];

  const results = await Promise.all(checks);
  for (const result of results) {
    if (result) flags.push(result);
  }

  if (flags.length > 0) {
    await db("anomaly_flags").insert(flags);
  }

  return flags;
}

async function checkEmergencySession(_db: Knex, meeting: Meeting): Promise<AnomalyFlag | null> {
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

async function checkMissingMinutes(db: Knex, meeting: Meeting): Promise<AnomalyFlag | null> {
  const meetingDate = new Date(meeting.date);
  const daysSinceMeeting = (Date.now() - meetingDate.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceMeeting > 14 && !meeting.minutes_url) {
    const existingFlag = await db("anomaly_flags")
      .where({ meeting_id: meeting.id, flag_type: "missing_minutes" })
      .first();
    if (existingFlag) return null;

    return {
      meeting_id: meeting.id,
      flag_type: "missing_minutes",
      description: `Minutes not published ${Math.floor(daysSinceMeeting)} days after meeting`,
      severity: daysSinceMeeting > 30 ? "high" : "medium",
    };
  }
  return null;
}

async function checkQuorumIssue(db: Knex, meeting: Meeting): Promise<AnomalyFlag | null> {
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

  const quorum = Math.ceil(total / 2) + 1;
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

async function checkLastMinuteAgendaChange(db: Knex, meeting: Meeting): Promise<AnomalyFlag | null> {
  const agendaItems = await db("agenda_items")
    .where({ meeting_id: meeting.id })
    .select("created_at");

  const meetingDate = new Date(meeting.date);
  for (const item of agendaItems) {
    const createdAt = new Date(item.created_at);
    const hoursBeforeMeeting = (meetingDate.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
    if (hoursBeforeMeeting >= 0 && hoursBeforeMeeting < 24) {
      return {
        meeting_id: meeting.id,
        flag_type: "last_minute_agenda_change",
        description: "Agenda item added less than 24 hours before meeting",
        severity: "medium",
      };
    }
  }
  return null;
}

async function checkUnanimousControversial(db: Knex, meeting: Meeting): Promise<AnomalyFlag | null> {
  const agendaItems = await db("agenda_items")
    .where({ meeting_id: meeting.id })
    .select("id", "category");

  const controversialCategories = ["public_hearing", "zoning", "budget", "ordinance"];

  for (const item of agendaItems) {
    if (!item.category || !controversialCategories.includes(item.category.toLowerCase())) continue;

    const votes = await db("votes")
      .where({ agenda_item_id: item.id })
      .whereNot({ vote: "absent" });

    if (votes.length < 3) continue;

    const allSame = votes.every((v: { vote: string }) => v.vote === votes[0].vote);
    if (allSame) {
      return {
        meeting_id: meeting.id,
        flag_type: "unanimous_controversial",
        description: `Unanimous ${votes[0].vote} vote on ${item.category} item with ${votes.length} voting members`,
        severity: "low",
      };
    }
  }
  return null;
}

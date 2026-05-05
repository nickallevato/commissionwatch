import db from "../config/database";

interface AnomalyFlag {
  id: string;
  meeting_id: string;
  flag_type: string;
  description: string;
  severity: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export async function detectAnomalies(meetingId: string): Promise<AnomalyFlag[]> {
  const meeting = await db("meetings").where({ id: meetingId }).first();
  if (!meeting) return [];

  const detectedFlags: Array<{
    meeting_id: string;
    flag_type: string;
    description: string;
    severity: string;
    metadata: string | null;
  }> = [];

  // Rule 1: emergency_session — meeting scheduled < 48h before date OR agenda posted < 24h before meeting
  const meetingDate = new Date(meeting.date);
  const createdAt = new Date(meeting.created_at);
  const hoursBefore = (meetingDate.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
  if (hoursBefore < 48) {
    detectedFlags.push({
      meeting_id: meetingId,
      flag_type: "emergency_session",
      description: `Meeting was scheduled only ${Math.round(hoursBefore)} hours before its date`,
      severity: hoursBefore < 24 ? "critical" : "high",
      metadata: JSON.stringify({ hours_notice: Math.round(hoursBefore) }),
    });
  }

  // Rule 2: missing_minutes — meeting completed, no minutes_url, > 14 days ago
  if (meeting.status === "completed" && !meeting.minutes_url) {
    const daysSince = (Date.now() - meetingDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 14) {
      detectedFlags.push({
        meeting_id: meetingId,
        flag_type: "missing_minutes",
        description: `Meeting completed ${Math.round(daysSince)} days ago with no minutes posted`,
        severity: daysSince > 30 ? "high" : "medium",
        metadata: JSON.stringify({ days_since_meeting: Math.round(daysSince) }),
      });
    }
  }

  // Rule 3: quorum_issue — votes on an item < majority of active members
  const commission = await db("commissions").where({ id: meeting.commission_id }).first();
  if (commission) {
    const activeMembers = await db("members")
      .where({ jurisdiction_id: commission.jurisdiction_id })
      .where("term_start", "<=", meeting.date)
      .where(function () {
        this.whereNull("term_end").orWhere("term_end", ">=", meeting.date);
      })
      .count("* as total")
      .first();

    const memberCount = Number(activeMembers?.total ?? 0);
    const majority = Math.floor(memberCount / 2) + 1;

    if (memberCount > 0) {
      const agendaItems = await db("agenda_items").where({ meeting_id: meetingId });

      for (const item of agendaItems) {
        const voteCount = await db("votes")
          .where({ meeting_id: meetingId, agenda_item_id: item.id })
          .whereNot("vote", "absent")
          .count("* as total")
          .first();

        const present = Number(voteCount?.total ?? 0);
        if (present > 0 && present < majority) {
          detectedFlags.push({
            meeting_id: meetingId,
            flag_type: "quorum_issue",
            description: `Agenda item "${item.title}" had only ${present} votes, below quorum of ${majority}`,
            severity: "high",
            metadata: JSON.stringify({
              agenda_item_id: item.id,
              votes_present: present,
              quorum_needed: majority,
              total_members: memberCount,
            }),
          });
        }
      }
    }
  }

  // Rule 4: last_minute_agenda_change — agenda_items updated_at > meeting date - 24h
  const cutoff = new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000);
  const lateChanges = await db("agenda_items")
    .where({ meeting_id: meetingId })
    .where("updated_at", ">", cutoff.toISOString())
    .where("created_at", "<", "updated_at");

  for (const item of lateChanges) {
    detectedFlags.push({
      meeting_id: meetingId,
      flag_type: "last_minute_agenda_change",
      description: `Agenda item "${item.title}" was modified within 24 hours of meeting`,
      severity: "medium",
      metadata: JSON.stringify({ agenda_item_id: item.id, updated_at: item.updated_at }),
    });
  }

  // Rule 5: unanimous_controversial — all votes are 'yes' AND item has public comment
  const itemsWithVotes = await db("agenda_items")
    .where({ meeting_id: meetingId })
    .whereExists(
      db("votes").whereRaw("votes.agenda_item_id = agenda_items.id"),
    );

  for (const item of itemsWithVotes) {
    const votes = await db("votes")
      .where({ meeting_id: meetingId, agenda_item_id: item.id })
      .whereNot("vote", "absent");

    if (votes.length > 0 && votes.every((v: { vote: string }) => v.vote === "yes")) {
      const hasPublicComment =
        item.category?.toLowerCase().includes("public") ||
        item.title?.toLowerCase().includes("public hearing") ||
        item.description?.toLowerCase().includes("public comment");

      if (hasPublicComment) {
        detectedFlags.push({
          meeting_id: meetingId,
          flag_type: "unanimous_controversial",
          description: `Unanimous yes vote on public hearing item "${item.title}"`,
          severity: "low",
          metadata: JSON.stringify({ agenda_item_id: item.id, vote_count: votes.length }),
        });
      }
    }
  }

  // Insert detected flags and return
  if (detectedFlags.length === 0) return [];

  const inserted = await db("anomaly_flags").insert(detectedFlags).returning("*");
  return inserted;
}

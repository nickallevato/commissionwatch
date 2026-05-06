import { AnomalyFlag, DetectionContext, JurisdictionConfig, Detector } from './types';

export const detectEmergencySession: Detector = (ctx, config) => {
  const flags: AnomalyFlag[] = [];
  if (!ctx.scheduledDate || !ctx.publishedDate) return flags;

  const scheduled = new Date(ctx.scheduledDate);
  const published = new Date(ctx.publishedDate);
  const hoursNotice = (scheduled.getTime() - published.getTime()) / (1000 * 60 * 60);

  if (hoursNotice < config.emergencyNoticeHours && hoursNotice >= 0) {
    flags.push({
      flagType: 'emergency_session',
      severity: hoursNotice < 24 ? 'critical' : 'high',
      description: `Meeting scheduled with only ${Math.round(hoursNotice)}h notice (minimum: ${config.emergencyNoticeHours}h)`,
      metadata: { hoursNotice: Math.round(hoursNotice), threshold: config.emergencyNoticeHours },
    });
  }
  return flags;
};

export const detectClosedDoorVote: Detector = (ctx, _config) => {
  const flags: AnomalyFlag[] = [];
  const closedPatterns = [
    /executive\s+session/i,
    /closed\s+session/i,
    /private\s+session/i,
    /closed\s+to\s+(the\s+)?public/i,
    /executive\s+meeting/i,
  ];

  const rawText = ctx.parsedDoc.rawText;
  const agendaItems = ctx.parsedDoc.agendaItems.value;
  const motions = ctx.parsedDoc.motions.value;

  for (const item of agendaItems) {
    const text = `${item.title} ${item.description || ''}`;
    if (closedPatterns.some((p) => p.test(text))) {
      const hasVote = motions.some(
        (m) => m.agendaItemNumber === item.itemNumber && m.votes.length > 0
      );
      if (hasVote) {
        flags.push({
          flagType: 'closed_door_vote',
          severity: 'critical',
          description: `Vote taken during closed/executive session: item #${item.itemNumber} "${item.title}"`,
          metadata: { itemNumber: item.itemNumber, title: item.title },
        });
      }
    }
  }

  if (flags.length === 0 && closedPatterns.some((p) => p.test(rawText))) {
    const hasAnyVote = motions.some((m) => m.votes.length > 0);
    if (hasAnyVote) {
      flags.push({
        flagType: 'closed_door_vote',
        severity: 'high',
        description: 'Document references executive/closed session and contains votes',
        metadata: { matchedInRawText: true },
      });
    }
  }

  return flags;
};

export const detectLastMinuteAgendaChange: Detector = (ctx, _config) => {
  const flags: AnomalyFlag[] = [];
  if (!ctx.previousAgendaItems) return flags;

  const currentItems = ctx.parsedDoc.agendaItems.value.map((i) => i.title.toLowerCase().trim());
  const previousItems = ctx.previousAgendaItems.map((t) => t.toLowerCase().trim());

  const added = currentItems.filter((t) => !previousItems.includes(t));
  const removed = previousItems.filter((t) => !currentItems.includes(t));

  if (added.length > 0) {
    flags.push({
      flagType: 'last_minute_agenda_change',
      severity: added.length >= 3 ? 'high' : 'medium',
      description: `${added.length} agenda item(s) added after initial publication`,
      metadata: { added, count: added.length },
    });
  }

  if (removed.length > 0) {
    flags.push({
      flagType: 'last_minute_agenda_change',
      severity: removed.length >= 3 ? 'high' : 'medium',
      description: `${removed.length} agenda item(s) removed after initial publication`,
      metadata: { removed, count: removed.length },
    });
  }

  return flags;
};

export const detectQuorumIssue: Detector = (ctx, config) => {
  const flags: AnomalyFlag[] = [];
  const attendees = ctx.parsedDoc.attendees.value;

  if (attendees.length === 0) return flags;

  const presentCount = attendees.filter((a) => a.present).length;

  if (presentCount < config.quorumSize) {
    flags.push({
      flagType: 'quorum_issue',
      severity: 'critical',
      description: `Only ${presentCount} of ${config.totalMembers} members present (quorum requires ${config.quorumSize})`,
      metadata: { presentCount, quorumSize: config.quorumSize, totalMembers: config.totalMembers },
    });
    return flags;
  }

  const motions = ctx.parsedDoc.motions.value;
  for (const motion of motions) {
    if (motion.votes.length === 0) continue;
    const votingMembers = motion.votes.filter((v) => v.vote !== 'absent').length;
    if (votingMembers < config.quorumSize) {
      flags.push({
        flagType: 'quorum_issue',
        severity: 'high',
        description: `Vote on "${motion.title}" had only ${votingMembers} participating members (quorum: ${config.quorumSize})`,
        metadata: { motionTitle: motion.title, votingMembers, quorumSize: config.quorumSize },
      });
    }
  }

  return flags;
};

export const detectUnanimousControversial: Detector = (ctx, config) => {
  const flags: AnomalyFlag[] = [];
  const motions = ctx.parsedDoc.motions.value;

  for (const motion of motions) {
    if (motion.votes.length === 0) continue;

    const activeVotes = motion.votes.filter((v) => v.vote !== 'absent');
    if (activeVotes.length < config.quorumSize) continue;

    const isUnanimous = activeVotes.every((v) => v.vote === 'yes');
    if (!isUnanimous) continue;

    const text = `${motion.title} ${motion.description || ''}`.toLowerCase();
    const matchedTopic = config.controversialTopics.find((topic) => text.includes(topic));

    if (matchedTopic) {
      flags.push({
        flagType: 'unanimous_controversial',
        severity: 'medium',
        description: `Unanimous vote on potentially contentious topic "${motion.title}" (matched: "${matchedTopic}")`,
        metadata: { motionTitle: motion.title, matchedTopic, voteCount: activeVotes.length },
      });
    }
  }

  return flags;
};

export const detectMissingMinutes: Detector = (ctx, config) => {
  const flags: AnomalyFlag[] = [];

  if (ctx.minutesPublished !== false) return flags;
  if (ctx.meetingAge === undefined) return flags;

  if (ctx.meetingAge > config.minutesDeadlineDays) {
    flags.push({
      flagType: 'missing_minutes',
      severity: ctx.meetingAge > config.minutesDeadlineDays * 2 ? 'high' : 'medium',
      description: `Meeting minutes not published after ${ctx.meetingAge} days (deadline: ${config.minutesDeadlineDays} days)`,
      metadata: { meetingAgeDays: ctx.meetingAge, deadlineDays: config.minutesDeadlineDays },
    });
  }

  return flags;
};

export const ALL_DETECTORS: Detector[] = [
  detectEmergencySession,
  detectClosedDoorVote,
  detectLastMinuteAgendaChange,
  detectQuorumIssue,
  detectUnanimousControversial,
  detectMissingMinutes,
];

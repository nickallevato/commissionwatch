import { ParsedDocument, ExtractedMotion, ExtractedAgendaItem } from '../parser/types';
import { AnomalyFlag } from '../anomaly/types';
import { detectAnomalies, DetectOptions } from '../anomaly';
import { getJurisdictionConfig } from '../anomaly/config';
import {
  RundownSheet,
  RundownKeyItems,
  AttendanceSummary,
  AgendaOutcome,
  VoteRecord,
  GenerateOptions,
} from './types';

export function generateRundown(parsedDoc: ParsedDocument, options: GenerateOptions): RundownSheet {
  const { meetingId, jurisdiction, anomalyFlags } = options;
  const config = getJurisdictionConfig(jurisdiction);

  const attendance = buildAttendanceSummary(parsedDoc, config.quorumSize);
  const agendaOutcomes = buildAgendaOutcomes(parsedDoc);
  const votes = buildVoteRecords(parsedDoc);
  const keyQuotes = parsedDoc.quotes.value.slice(0, 5);

  const anomalies = anomalyFlags ?? detectAnomalies(parsedDoc, meetingId, { jurisdiction });

  const keyItems: RundownKeyItems = {
    attendance,
    agendaOutcomes,
    votes,
    keyQuotes,
    anomalies,
  };

  const summary = buildSummary(parsedDoc, attendance, votes, anomalies);

  return {
    meetingId,
    summary,
    keyItems,
    generatedAt: new Date().toISOString(),
  };
}

function buildAttendanceSummary(doc: ParsedDocument, quorumSize: number): AttendanceSummary {
  const attendees = doc.attendees.value;
  const present = attendees.filter((a) => a.present).map((a) => a.name);
  const absent = attendees.filter((a) => !a.present).map((a) => a.name);

  return {
    present,
    absent,
    totalMembers: attendees.length,
    quorumMet: present.length >= quorumSize,
  };
}

function buildAgendaOutcomes(doc: ParsedDocument): AgendaOutcome[] {
  const agendaItems = doc.agendaItems.value;
  const motions = doc.motions.value;

  return agendaItems.map((item) => {
    const relatedMotion = motions.find((m) => m.agendaItemNumber === item.itemNumber);
    return {
      itemNumber: item.itemNumber,
      title: item.title,
      category: item.category,
      outcome: determineOutcome(relatedMotion),
    };
  });
}

function determineOutcome(motion?: ExtractedMotion): AgendaOutcome['outcome'] {
  if (!motion) return 'discussed';
  switch (motion.result) {
    case 'passed': return 'approved';
    case 'tabled': return 'tabled';
    case 'failed': return 'deferred';
    default: return 'no_action';
  }
}

function buildVoteRecords(doc: ParsedDocument): VoteRecord[] {
  return doc.motions.value.map((motion) => {
    const tally = { yes: 0, no: 0, abstain: 0, absent: 0 };
    for (const vote of motion.votes) {
      tally[vote.vote]++;
    }
    return {
      motion: motion.title,
      mover: motion.mover,
      seconder: motion.seconder,
      result: motion.result,
      tally,
    };
  });
}

function buildSummary(
  doc: ParsedDocument,
  attendance: AttendanceSummary,
  votes: VoteRecord[],
  anomalies: AnomalyFlag[]
): string {
  const parts: string[] = [];

  const date = doc.meetingDate.value ?? 'Unknown date';
  parts.push(`Meeting held ${date}.`);

  parts.push(
    `${attendance.present.length} of ${attendance.totalMembers} members present` +
    (attendance.quorumMet ? ' (quorum met).' : ' (NO QUORUM).')
  );

  if (votes.length > 0) {
    const passed = votes.filter((v) => v.result === 'passed').length;
    const failed = votes.filter((v) => v.result === 'failed').length;
    const tabled = votes.filter((v) => v.result === 'tabled').length;
    const voteParts: string[] = [];
    if (passed) voteParts.push(`${passed} passed`);
    if (failed) voteParts.push(`${failed} failed`);
    if (tabled) voteParts.push(`${tabled} tabled`);
    parts.push(`${votes.length} vote(s) recorded: ${voteParts.join(', ') || 'outcomes pending'}.`);
  }

  if (anomalies.length > 0) {
    const critical = anomalies.filter((a) => a.severity === 'critical' || a.severity === 'high');
    if (critical.length > 0) {
      parts.push(`${critical.length} high-priority anomaly flag(s) detected.`);
    }
  }

  return parts.join(' ');
}

import { describe, it, expect } from 'vitest';
import { ParsedDocument, ExtractedAttendee, ExtractedMotion, ExtractedAgendaItem } from '../src/parser/types';
import { detectAnomalies } from '../src/anomaly/index';
import {
  detectEmergencySession,
  detectClosedDoorVote,
  detectLastMinuteAgendaChange,
  detectQuorumIssue,
  detectUnanimousControversial,
  detectMissingMinutes,
} from '../src/anomaly/detectors';
import { BOZEMAN_CONFIG } from '../src/anomaly/config';
import { DetectionContext } from '../src/anomaly/types';

function makeParsedDoc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    meetingDate: { value: '2025-01-07', confidence: 'high' },
    meetingTime: { value: '6:00 PM', confidence: 'high' },
    attendees: { value: [], confidence: 'high' },
    agendaItems: { value: [], confidence: 'high' },
    motions: { value: [], confidence: 'high' },
    quotes: { value: [], confidence: 'high' },
    rawText: '',
    sourceType: 'html',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<DetectionContext> = {}): DetectionContext {
  return {
    meetingId: '00000000-0000-0000-0000-000000000001',
    parsedDoc: makeParsedDoc(),
    ...overrides,
  };
}

describe('detectEmergencySession', () => {
  it('flags meeting with less than 48h notice', () => {
    const ctx = makeCtx({
      scheduledDate: '2025-01-10T18:00:00Z',
      publishedDate: '2025-01-10T06:00:00Z',
    });
    const flags = detectEmergencySession(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].flagType).toBe('emergency_session');
    expect(flags[0].severity).toBe('critical');
  });

  it('assigns high severity for 24-48h notice', () => {
    const ctx = makeCtx({
      scheduledDate: '2025-01-12T18:00:00Z',
      publishedDate: '2025-01-11T06:00:00Z',
    });
    const flags = detectEmergencySession(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('high');
  });

  it('does not flag meetings with adequate notice', () => {
    const ctx = makeCtx({
      scheduledDate: '2025-01-15T18:00:00Z',
      publishedDate: '2025-01-10T06:00:00Z',
    });
    const flags = detectEmergencySession(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(0);
  });

  it('returns empty when dates missing', () => {
    const ctx = makeCtx({});
    const flags = detectEmergencySession(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(0);
  });
});

describe('detectClosedDoorVote', () => {
  it('flags votes during executive session agenda items', () => {
    const doc = makeParsedDoc({
      agendaItems: {
        value: [{ itemNumber: 1, title: 'Executive Session - Personnel Matter' }],
        confidence: 'high',
      },
      motions: {
        value: [
          {
            agendaItemNumber: 1,
            title: 'Executive Session Personnel',
            votes: [{ memberName: 'Sample', vote: 'yes' }],
          },
        ],
        confidence: 'high',
      },
      rawText: 'Executive Session discussion',
    });
    const ctx = makeCtx({ parsedDoc: doc });
    const flags = detectClosedDoorVote(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('critical');
  });

  it('flags when raw text mentions closed session with votes', () => {
    const doc = makeParsedDoc({
      rawText: 'The commission entered closed session to discuss litigation.',
      motions: {
        value: [{ title: 'Settlement', votes: [{ memberName: 'Smith', vote: 'yes' }] }],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({ parsedDoc: doc });
    const flags = detectClosedDoorVote(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('high');
  });

  it('does not flag normal open meetings', () => {
    const doc = makeParsedDoc({
      rawText: 'Regular commission meeting',
      agendaItems: { value: [{ itemNumber: 1, title: 'Approve minutes' }], confidence: 'high' },
      motions: {
        value: [{ title: 'Approve', votes: [{ memberName: 'A', vote: 'yes' }] }],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({ parsedDoc: doc });
    const flags = detectClosedDoorVote(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(0);
  });
});

describe('detectLastMinuteAgendaChange', () => {
  it('flags added items', () => {
    const doc = makeParsedDoc({
      agendaItems: {
        value: [
          { itemNumber: 1, title: 'Approve minutes' },
          { itemNumber: 2, title: 'New emergency item' },
        ],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({
      parsedDoc: doc,
      previousAgendaItems: ['Approve minutes'],
    });
    const flags = detectLastMinuteAgendaChange(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].description).toContain('1 agenda item(s) added');
  });

  it('flags removed items', () => {
    const doc = makeParsedDoc({
      agendaItems: {
        value: [{ itemNumber: 1, title: 'Approve minutes' }],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({
      parsedDoc: doc,
      previousAgendaItems: ['Approve minutes', 'Budget discussion', 'Rezoning vote'],
    });
    const flags = detectLastMinuteAgendaChange(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].description).toContain('2 agenda item(s) removed');
  });

  it('assigns high severity for 3+ changes', () => {
    const doc = makeParsedDoc({
      agendaItems: {
        value: [
          { itemNumber: 1, title: 'Item A' },
          { itemNumber: 2, title: 'Item B' },
          { itemNumber: 3, title: 'Item C' },
          { itemNumber: 4, title: 'Item D' },
        ],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({ parsedDoc: doc, previousAgendaItems: ['Item A'] });
    const flags = detectLastMinuteAgendaChange(ctx, BOZEMAN_CONFIG);
    expect(flags[0].severity).toBe('high');
  });

  it('returns empty when no previous items provided', () => {
    const ctx = makeCtx({});
    const flags = detectLastMinuteAgendaChange(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(0);
  });
});

describe('detectQuorumIssue', () => {
  it('flags when fewer than quorum members present', () => {
    const doc = makeParsedDoc({
      attendees: {
        value: [
          { name: 'Sample', present: true },
          { name: 'Placeholder', present: true },
          { name: 'Fixture', present: false },
          { name: 'Bode', present: false },
          { name: 'Testcase', present: false },
        ],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({ parsedDoc: doc });
    const flags = detectQuorumIssue(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('critical');
    expect(flags[0].description).toContain('2 of 5');
  });

  it('flags individual votes with insufficient participation', () => {
    const doc = makeParsedDoc({
      attendees: {
        value: [
          { name: 'Sample', present: true },
          { name: 'Placeholder', present: true },
          { name: 'Fixture', present: true },
          { name: 'Bode', present: true },
          { name: 'Testcase', present: true },
        ],
        confidence: 'high',
      },
      motions: {
        value: [
          {
            title: 'Late vote',
            votes: [
              { memberName: 'Sample', vote: 'yes' },
              { memberName: 'Placeholder', vote: 'yes' },
              { memberName: 'Fixture', vote: 'absent' },
              { memberName: 'Bode', vote: 'absent' },
              { memberName: 'Testcase', vote: 'absent' },
            ],
          },
        ],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({ parsedDoc: doc });
    const flags = detectQuorumIssue(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('high');
  });

  it('does not flag when quorum is met', () => {
    const doc = makeParsedDoc({
      attendees: {
        value: [
          { name: 'Sample', present: true },
          { name: 'Placeholder', present: true },
          { name: 'Fixture', present: true },
          { name: 'Bode', present: false },
          { name: 'Testcase', present: false },
        ],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({ parsedDoc: doc });
    const flags = detectQuorumIssue(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(0);
  });
});

describe('detectUnanimousControversial', () => {
  it('flags unanimous vote on annexation topic', () => {
    const doc = makeParsedDoc({
      motions: {
        value: [
          {
            title: 'Ordinance 2145: Annexation of 45 acres',
            votes: [
              { memberName: 'Sample', vote: 'yes' },
              { memberName: 'Placeholder', vote: 'yes' },
              { memberName: 'Fixture', vote: 'yes' },
              { memberName: 'Bode', vote: 'yes' },
              { memberName: 'Testcase', vote: 'yes' },
            ],
          },
        ],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({ parsedDoc: doc });
    const flags = detectUnanimousControversial(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].flagType).toBe('unanimous_controversial');
    expect(flags[0].severity).toBe('medium');
    expect(flags[0].metadata?.matchedTopic).toBe('annexation');
  });

  it('does not flag non-unanimous vote on controversial topic', () => {
    const doc = makeParsedDoc({
      motions: {
        value: [
          {
            title: 'Annexation ordinance',
            votes: [
              { memberName: 'Sample', vote: 'yes' },
              { memberName: 'Placeholder', vote: 'yes' },
              { memberName: 'Fixture', vote: 'no' },
              { memberName: 'Bode', vote: 'yes' },
              { memberName: 'Testcase', vote: 'yes' },
            ],
          },
        ],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({ parsedDoc: doc });
    const flags = detectUnanimousControversial(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(0);
  });

  it('does not flag unanimous vote on non-controversial topic', () => {
    const doc = makeParsedDoc({
      motions: {
        value: [
          {
            title: 'Approve meeting minutes',
            votes: [
              { memberName: 'Sample', vote: 'yes' },
              { memberName: 'Placeholder', vote: 'yes' },
              { memberName: 'Fixture', vote: 'yes' },
            ],
          },
        ],
        confidence: 'high',
      },
    });
    const ctx = makeCtx({ parsedDoc: doc });
    const flags = detectUnanimousControversial(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(0);
  });
});

describe('detectMissingMinutes', () => {
  it('flags meetings older than deadline without minutes', () => {
    const ctx = makeCtx({ minutesPublished: false, meetingAge: 20 });
    const flags = detectMissingMinutes(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('medium');
  });

  it('assigns high severity when far past deadline', () => {
    const ctx = makeCtx({ minutesPublished: false, meetingAge: 35 });
    const flags = detectMissingMinutes(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('high');
  });

  it('does not flag when minutes are published', () => {
    const ctx = makeCtx({ minutesPublished: true, meetingAge: 30 });
    const flags = detectMissingMinutes(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(0);
  });

  it('does not flag recent meetings', () => {
    const ctx = makeCtx({ minutesPublished: false, meetingAge: 7 });
    const flags = detectMissingMinutes(ctx, BOZEMAN_CONFIG);
    expect(flags).toHaveLength(0);
  });
});

describe('detectAnomalies (integration)', () => {
  it('detects unanimous controversial from Bozeman minutes fixture data', () => {
    const doc = makeParsedDoc({
      meetingDate: { value: '2025-01-07', confidence: 'high' },
      attendees: {
        value: [
          { name: 'Avery Sample', title: 'Mayor', present: true },
          { name: 'Jordan Placeholder', title: 'Deputy Mayor', present: true },
          { name: 'Riley Fixture', present: true },
          { name: 'Emma Bode', present: true },
          { name: 'Quinn Testcase', present: true },
        ],
        confidence: 'high',
      },
      motions: {
        value: [
          {
            title: 'Approve the Consent Agenda',
            votes: [
              { memberName: 'Sample', vote: 'yes' },
              { memberName: 'Placeholder', vote: 'yes' },
              { memberName: 'Fixture', vote: 'yes' },
              { memberName: 'Bode', vote: 'yes' },
              { memberName: 'Testcase', vote: 'yes' },
            ],
            result: 'passed',
          },
          {
            title: 'Approve Ordinance 2145: Annexation of 45 acres at Baxter and Davis',
            votes: [
              { memberName: 'Sample', vote: 'yes' },
              { memberName: 'Placeholder', vote: 'yes' },
              { memberName: 'Fixture', vote: 'yes' },
              { memberName: 'Bode', vote: 'yes' },
              { memberName: 'Testcase', vote: 'yes' },
            ],
            result: 'passed',
          },
        ],
        confidence: 'high',
      },
      rawText: 'Bozeman City Commission Regular Meeting January 7 2025',
      sourceType: 'html',
    });

    const flags = detectAnomalies(doc, '00000000-0000-0000-0000-000000000001');
    const controversialFlags = flags.filter((f) => f.flagType === 'unanimous_controversial');
    expect(controversialFlags.length).toBeGreaterThanOrEqual(1);
    expect(controversialFlags[0].metadata?.matchedTopic).toBe('annexation');
  });

  it('detects multiple anomaly types simultaneously', () => {
    const doc = makeParsedDoc({
      attendees: {
        value: [
          { name: 'A', present: true },
          { name: 'B', present: true },
          { name: 'C', present: false },
          { name: 'D', present: false },
          { name: 'E', present: false },
        ],
        confidence: 'high',
      },
      agendaItems: {
        value: [{ itemNumber: 1, title: 'Executive Session - Budget discussion' }],
        confidence: 'high',
      },
      motions: {
        value: [
          {
            agendaItemNumber: 1,
            title: 'Budget approval in executive session',
            votes: [
              { memberName: 'A', vote: 'yes' },
              { memberName: 'B', vote: 'yes' },
            ],
          },
        ],
        confidence: 'high',
      },
      rawText: 'Executive session budget',
    });

    const flags = detectAnomalies(doc, '00000000-0000-0000-0000-000000000001', {
      minutesPublished: false,
      meetingAge: 30,
    });

    const flagTypes = flags.map((f) => f.flagType);
    expect(flagTypes).toContain('quorum_issue');
    expect(flagTypes).toContain('closed_door_vote');
    expect(flagTypes).toContain('missing_minutes');
  });
});

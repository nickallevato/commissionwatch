import { describe, it, expect } from 'vitest';
import { ParsedDocument } from '../src/parser/types';
import { generateRundown } from '../src/rundown/generator';

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

const MEETING_ID = '00000000-0000-0000-0000-000000000001';

describe('generateRundown', () => {
  describe('attendance summary', () => {
    it('computes present/absent/quorum correctly', () => {
      const doc = makeParsedDoc({
        attendees: {
          value: [
            { name: 'Terry Cunningham', title: 'Mayor', present: true },
            { name: 'Jennifer Madgic', title: 'Deputy Mayor', present: true },
            { name: 'Christopher Coburn', present: true },
            { name: 'Emma Bode', present: false },
            { name: 'Joey Morrison', present: false },
          ],
          confidence: 'high',
        },
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.keyItems.attendance.present).toEqual([
        'Terry Cunningham',
        'Jennifer Madgic',
        'Christopher Coburn',
      ]);
      expect(rundown.keyItems.attendance.absent).toEqual(['Emma Bode', 'Joey Morrison']);
      expect(rundown.keyItems.attendance.totalMembers).toBe(5);
      expect(rundown.keyItems.attendance.quorumMet).toBe(true);
    });

    it('flags quorum not met when fewer than 3 present', () => {
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
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.keyItems.attendance.quorumMet).toBe(false);
    });
  });

  describe('agenda outcomes', () => {
    it('maps motions to agenda items with correct outcomes', () => {
      const doc = makeParsedDoc({
        agendaItems: {
          value: [
            { itemNumber: 1, title: 'Approve minutes' },
            { itemNumber: 2, title: 'Budget discussion' },
            { itemNumber: 3, title: 'Zoning request' },
          ],
          confidence: 'high',
        },
        motions: {
          value: [
            {
              agendaItemNumber: 1,
              title: 'Motion to approve minutes',
              result: 'passed',
              votes: [{ memberName: 'A', vote: 'yes' }],
            },
            {
              agendaItemNumber: 3,
              title: 'Table zoning request',
              result: 'tabled',
              votes: [{ memberName: 'A', vote: 'yes' }],
            },
          ],
          confidence: 'high',
        },
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.keyItems.agendaOutcomes).toHaveLength(3);
      expect(rundown.keyItems.agendaOutcomes[0].outcome).toBe('approved');
      expect(rundown.keyItems.agendaOutcomes[1].outcome).toBe('discussed');
      expect(rundown.keyItems.agendaOutcomes[2].outcome).toBe('tabled');
    });
  });

  describe('vote records', () => {
    it('produces correct tallies', () => {
      const doc = makeParsedDoc({
        motions: {
          value: [
            {
              title: 'Approve budget',
              mover: 'Cunningham',
              seconder: 'Madgic',
              result: 'passed',
              votes: [
                { memberName: 'Cunningham', vote: 'yes' },
                { memberName: 'Madgic', vote: 'yes' },
                { memberName: 'Coburn', vote: 'yes' },
                { memberName: 'Bode', vote: 'no' },
                { memberName: 'Morrison', vote: 'abstain' },
              ],
            },
          ],
          confidence: 'high',
        },
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.keyItems.votes).toHaveLength(1);
      const vote = rundown.keyItems.votes[0];
      expect(vote.motion).toBe('Approve budget');
      expect(vote.mover).toBe('Cunningham');
      expect(vote.seconder).toBe('Madgic');
      expect(vote.result).toBe('passed');
      expect(vote.tally).toEqual({ yes: 3, no: 1, abstain: 1, absent: 0 });
    });
  });

  describe('summary generation', () => {
    it('includes date, attendance, and vote counts', () => {
      const doc = makeParsedDoc({
        meetingDate: { value: '2025-03-15', confidence: 'high' },
        attendees: {
          value: [
            { name: 'A', present: true },
            { name: 'B', present: true },
            { name: 'C', present: true },
            { name: 'D', present: false },
            { name: 'E', present: false },
          ],
          confidence: 'high',
        },
        motions: {
          value: [
            { title: 'M1', result: 'passed', votes: [{ memberName: 'A', vote: 'yes' }] },
            { title: 'M2', result: 'failed', votes: [{ memberName: 'A', vote: 'no' }] },
          ],
          confidence: 'high',
        },
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.summary).toContain('2025-03-15');
      expect(rundown.summary).toContain('3 of 5 members present');
      expect(rundown.summary).toContain('quorum met');
      expect(rundown.summary).toContain('2 vote(s) recorded');
      expect(rundown.summary).toContain('1 passed');
      expect(rundown.summary).toContain('1 failed');
    });

    it('flags NO QUORUM in summary', () => {
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
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.summary).toContain('NO QUORUM');
    });

    it('mentions anomaly flags when present', () => {
      const doc = makeParsedDoc({
        attendees: {
          value: [
            { name: 'A', present: true },
            { name: 'B', present: false },
            { name: 'C', present: false },
            { name: 'D', present: false },
            { name: 'E', present: false },
          ],
          confidence: 'high',
        },
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.keyItems.anomalies.length).toBeGreaterThan(0);
      expect(rundown.summary).toContain('anomaly flag');
    });
  });

  describe('meeting format handling', () => {
    it('handles agenda-only meetings (no motions)', () => {
      const doc = makeParsedDoc({
        agendaItems: {
          value: [
            { itemNumber: 1, title: 'Call to order' },
            { itemNumber: 2, title: 'Public comment' },
            { itemNumber: 3, title: 'Adjournment' },
          ],
          confidence: 'high',
        },
        motions: { value: [], confidence: 'low' },
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.keyItems.agendaOutcomes).toHaveLength(3);
      expect(rundown.keyItems.agendaOutcomes.every((o) => o.outcome === 'discussed')).toBe(true);
      expect(rundown.keyItems.votes).toHaveLength(0);
    });

    it('handles minutes-only meetings (motions but no agenda items)', () => {
      const doc = makeParsedDoc({
        agendaItems: { value: [], confidence: 'low' },
        motions: {
          value: [
            {
              title: 'Approve consent agenda',
              result: 'passed',
              mover: 'Cunningham',
              seconder: 'Madgic',
              votes: [
                { memberName: 'Cunningham', vote: 'yes' },
                { memberName: 'Madgic', vote: 'yes' },
                { memberName: 'Coburn', vote: 'yes' },
              ],
            },
          ],
          confidence: 'high',
        },
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.keyItems.agendaOutcomes).toHaveLength(0);
      expect(rundown.keyItems.votes).toHaveLength(1);
      expect(rundown.keyItems.votes[0].tally).toEqual({ yes: 3, no: 0, abstain: 0, absent: 0 });
    });

    it('handles full meetings (agenda + minutes with motions)', () => {
      const doc = makeParsedDoc({
        attendees: {
          value: [
            { name: 'Terry Cunningham', title: 'Mayor', present: true },
            { name: 'Jennifer Madgic', title: 'Deputy Mayor', present: true },
            { name: 'Christopher Coburn', present: true },
            { name: 'Emma Bode', present: true },
            { name: 'Joey Morrison', present: true },
          ],
          confidence: 'high',
        },
        agendaItems: {
          value: [
            { itemNumber: 1, title: 'Consent agenda', category: 'consent' },
            { itemNumber: 2, title: 'Annexation ordinance', category: 'action' },
            { itemNumber: 3, title: 'Public hearing on zoning', category: 'hearing' },
          ],
          confidence: 'high',
        },
        motions: {
          value: [
            {
              agendaItemNumber: 1,
              title: 'Approve consent agenda',
              result: 'passed',
              mover: 'Madgic',
              seconder: 'Coburn',
              votes: [
                { memberName: 'Cunningham', vote: 'yes' },
                { memberName: 'Madgic', vote: 'yes' },
                { memberName: 'Coburn', vote: 'yes' },
                { memberName: 'Bode', vote: 'yes' },
                { memberName: 'Morrison', vote: 'yes' },
              ],
            },
            {
              agendaItemNumber: 2,
              title: 'Approve annexation ordinance 2145',
              result: 'passed',
              mover: 'Cunningham',
              seconder: 'Morrison',
              votes: [
                { memberName: 'Cunningham', vote: 'yes' },
                { memberName: 'Madgic', vote: 'yes' },
                { memberName: 'Coburn', vote: 'yes' },
                { memberName: 'Bode', vote: 'no' },
                { memberName: 'Morrison', vote: 'yes' },
              ],
            },
          ],
          confidence: 'high',
        },
        quotes: {
          value: [
            { speaker: 'Terry Cunningham', text: 'This annexation benefits the community.', context: 'Agenda item 2' },
          ],
          confidence: 'medium',
        },
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.keyItems.attendance.quorumMet).toBe(true);
      expect(rundown.keyItems.agendaOutcomes).toHaveLength(3);
      expect(rundown.keyItems.agendaOutcomes[0].outcome).toBe('approved');
      expect(rundown.keyItems.agendaOutcomes[1].outcome).toBe('approved');
      expect(rundown.keyItems.agendaOutcomes[2].outcome).toBe('discussed');
      expect(rundown.keyItems.votes).toHaveLength(2);
      expect(rundown.keyItems.keyQuotes).toHaveLength(1);
      expect(rundown.meetingId).toBe(MEETING_ID);
      expect(rundown.generatedAt).toBeTruthy();
    });
  });

  describe('anomaly integration', () => {
    it('uses provided anomaly flags instead of re-detecting', () => {
      const doc = makeParsedDoc();
      const customFlags = [
        { flagType: 'emergency_session' as const, severity: 'critical' as const, description: 'Test flag' },
      ];

      const rundown = generateRundown(doc, { meetingId: MEETING_ID, anomalyFlags: customFlags });
      expect(rundown.keyItems.anomalies).toEqual(customFlags);
    });

    it('auto-detects anomalies when none provided', () => {
      const doc = makeParsedDoc({
        attendees: {
          value: [
            { name: 'A', present: true },
            { name: 'B', present: false },
            { name: 'C', present: false },
            { name: 'D', present: false },
            { name: 'E', present: false },
          ],
          confidence: 'high',
        },
      });

      const rundown = generateRundown(doc, { meetingId: MEETING_ID });
      expect(rundown.keyItems.anomalies.some((a) => a.flagType === 'quorum_issue')).toBe(true);
    });
  });
});

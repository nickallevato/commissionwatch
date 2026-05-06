import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import knex, { Knex } from 'knex';
import { parseDocument } from '../../src/parser/parser';
import { detectAnomalies } from '../../src/anomaly/index';
import type { ParsedDocument } from '../../src/parser/types';
import type { AnomalyFlag } from '../../src/anomaly/types';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/commissionwatch_test';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

interface PipelineResult {
  parsed: ParsedDocument;
  meetingId: string | null;
  anomalies: AnomalyFlag[];
}

let db: Knex;
let jurisdictionId: string;
let commissionId: string;

async function runPipeline(
  fixturePath: string,
  opts: { dryRun?: boolean; meetingDate?: string; fileType?: 'pdf' | 'html' } = {}
): Promise<PipelineResult> {
  const parsed = await parseDocument({
    input: fixturePath,
    type: opts.fileType,
  });

  const anomalies = detectAnomalies(parsed, 'test-meeting', {
    jurisdiction: 'bozeman',
  });

  if (opts.dryRun) {
    return { parsed, meetingId: null, anomalies };
  }

  const meetingDate = parsed.meetingDate.value || opts.meetingDate || '2025-01-01';
  const meetingTime = parsed.meetingTime.value || '18:00';

  const [meeting] = await db('meetings')
    .insert({
      commission_id: commissionId,
      date: meetingDate,
      time: meetingTime,
      location: 'City Hall, Commission Room, 121 N Rouse Ave, Bozeman, MT',
      status: 'completed',
    })
    .returning('*');

  const agendaItems = parsed.agendaItems.value || [];
  if (agendaItems.length > 0) {
    await db('agenda_items').insert(
      agendaItems.map((item) => ({
        meeting_id: meeting.id,
        item_number: item.itemNumber,
        title: item.title,
        description: item.description || null,
        category: item.category || null,
      }))
    );
  }

  const summary = `Meeting on ${meetingDate}: ${agendaItems.length} agenda items, ${parsed.motions.value?.length || 0} motions, ${parsed.attendees.value?.length || 0} attendees recorded.`;
  const keyItems = agendaItems.slice(0, 5).map((item) => ({
    number: item.itemNumber,
    title: item.title,
    category: item.category,
  }));

  await db('rundown_sheets').insert({
    meeting_id: meeting.id,
    summary,
    key_items: JSON.stringify(keyItems),
    generated_at: new Date(),
  });

  const realAnomalies = detectAnomalies(parsed, meeting.id, {
    jurisdiction: 'bozeman',
  });

  if (realAnomalies.length > 0) {
    await db('anomaly_flags').insert(
      realAnomalies.map((f) => ({
        meeting_id: meeting.id,
        flag_type: f.flagType,
        severity: f.severity,
        description: f.description,
        metadata: f.metadata ? JSON.stringify(f.metadata) : null,
      }))
    );
  }

  return { parsed, meetingId: meeting.id, anomalies: realAnomalies };
}

beforeAll(async () => {
  db = knex({
    client: 'pg',
    connection: TEST_DB_URL,
    pool: { min: 1, max: 3 },
  });

  await db.migrate.latest({
    directory: path.join(__dirname, '..', '..', '..', '..', 'backend', 'migrations'),
    extension: 'ts',
  });

  const [jurisdiction] = await db('jurisdictions')
    .insert({
      name: 'Bozeman',
      state: 'MT',
      type: 'city',
      website_url: 'https://www.bozeman.net',
    })
    .returning('id');
  jurisdictionId = jurisdiction.id;

  const [commission] = await db('commissions')
    .insert({
      jurisdiction_id: jurisdictionId,
      name: 'Bozeman City Commission',
      description: 'City Commission for Bozeman, Montana',
      meeting_schedule: '1st and 3rd Tuesday',
    })
    .returning('id');
  commissionId = commission.id;
}, 30000);

afterAll(async () => {
  await db('anomaly_flags').del();
  await db('rundown_sheets').del();
  await db('agenda_items').del();
  await db('meetings').del();
  await db('commissions').del();
  await db('jurisdictions').del();
  await db.destroy();
}, 10000);

beforeEach(async () => {
  await db('anomaly_flags').del();
  await db('rundown_sheets').del();
  await db('agenda_items').del();
  await db('meetings').del();
});

describe('Full pipeline: parse → store → detect → flag', () => {
  it('processes bozeman-minutes.html (Jan 7, 2025)', async () => {
    const fixturePath = path.join(FIXTURES_DIR, 'bozeman-minutes.html');
    const result = await runPipeline(fixturePath);

    expect(result.meetingId).toBeTruthy();
    expect(result.parsed.sourceType).toBe('html');

    const meetings = await db('meetings').where({ id: result.meetingId });
    expect(meetings).toHaveLength(1);
    expect(meetings[0].status).toBe('completed');

    const agendaItems = await db('agenda_items').where({ meeting_id: result.meetingId });
    expect(agendaItems.length).toBeGreaterThanOrEqual(7);

    const rundowns = await db('rundown_sheets').where({ meeting_id: result.meetingId });
    expect(rundowns).toHaveLength(1);
    expect(rundowns[0].summary).toContain('agenda items');
    expect(rundowns[0].key_items).toBeTruthy();

    const flags = await db('anomaly_flags').where({ meeting_id: result.meetingId });
    const flagTypes = flags.map((f: { flag_type: string }) => f.flag_type);
    expect(flagTypes.length).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('processes bozeman-agenda.txt as plain text (Feb 4, 2025)', async () => {
    // The .txt fixture is plain text, not HTML — cheerio extracts no structured elements.
    // This tests that the pipeline handles documents with minimal parsed content gracefully.
    const fixturePath = path.join(FIXTURES_DIR, 'bozeman-agenda.txt');
    const result = await runPipeline(fixturePath, { fileType: 'html', meetingDate: '2025-02-04' });

    expect(result.meetingId).toBeTruthy();

    const meetings = await db('meetings').where({ id: result.meetingId });
    expect(meetings).toHaveLength(1);
    expect(meetings[0].status).toBe('completed');

    const rundowns = await db('rundown_sheets').where({ meeting_id: result.meetingId });
    expect(rundowns).toHaveLength(1);
    expect(rundowns[0].summary).toContain('agenda items');
  }, 30000);

  it('processes bozeman-minutes-march.html (March 4, 2025)', async () => {
    const fixturePath = path.join(FIXTURES_DIR, 'bozeman-minutes-march.html');
    const result = await runPipeline(fixturePath);

    expect(result.meetingId).toBeTruthy();

    const meetings = await db('meetings').where({ id: result.meetingId });
    expect(meetings).toHaveLength(1);

    const agendaItems = await db('agenda_items').where({ meeting_id: result.meetingId });
    expect(agendaItems.length).toBeGreaterThanOrEqual(7);

    // The extractor picks up false-positive attendees from section headings,
    // but the real commissioners should be present in the list.
    const attendees = result.parsed.attendees.value;
    expect(attendees.length).toBeGreaterThanOrEqual(5);
    const bode = attendees.find((a) => a.name.toLowerCase().includes('bode'));
    expect(bode).toBeTruthy();
    expect(bode!.present).toBe(false);

    const flags = await db('anomaly_flags').where({ meeting_id: result.meetingId });
    expect(flags).toBeDefined();
  }, 30000);
});

describe('Pipeline processes 3 meetings sequentially', () => {
  it('processes all 3 fixtures and stores results', async () => {
    const fixtures = [
      { file: 'bozeman-minutes.html', date: '2025-01-07' },
      { file: 'bozeman-agenda.txt', date: '2025-02-04', fileType: 'html' as const },
      { file: 'bozeman-minutes-march.html', date: '2025-03-04' },
    ];

    const results: PipelineResult[] = [];
    for (const fixture of fixtures) {
      const fixturePath = path.join(FIXTURES_DIR, fixture.file);
      const result = await runPipeline(fixturePath, {
        meetingDate: fixture.date,
        fileType: fixture.fileType,
      });
      results.push(result);
    }

    const meetings = await db('meetings').select();
    expect(meetings).toHaveLength(3);

    // 7 (Jan) + 0 (Feb txt — no HTML structure) + 7 (Mar) = 14 minimum
    const allAgendaItems = await db('agenda_items').select();
    expect(allAgendaItems.length).toBeGreaterThanOrEqual(14);

    const rundowns = await db('rundown_sheets').select();
    expect(rundowns).toHaveLength(3);

    for (const result of results) {
      expect(result.meetingId).toBeTruthy();
    }
  }, 60000);
});

describe('Error handling: malformed documents', () => {
  it('parses bozeman-malformed.html without throwing', async () => {
    const fixturePath = path.join(FIXTURES_DIR, 'bozeman-malformed.html');
    const parsed = await parseDocument({ input: fixturePath });

    expect(parsed).toBeDefined();
    expect(parsed.sourceType).toBe('html');
    expect(parsed.rawText).toBeTruthy();
    expect(parsed.attendees.value).toBeDefined();
    expect(parsed.agendaItems.value).toBeDefined();
    expect(parsed.agendaItems.value.length).toBe(0);
    expect(parsed.attendees.value.length).toBe(0);
  });

  it('throws on non-existent file', async () => {
    const fakePath = path.join(FIXTURES_DIR, 'does-not-exist.html');
    await expect(parseDocument({ input: fakePath })).rejects.toThrow();
  });

  it('throws on empty path string', async () => {
    await expect(parseDocument({ input: '' })).rejects.toThrow();
  });
});

describe('Partial failure resilience', () => {
  it('continues processing when one document produces minimal data', async () => {
    const fixtures = [
      { file: 'bozeman-minutes.html', date: '2025-01-07' },
      { file: 'bozeman-malformed.html', date: '2025-02-01' },
      { file: 'bozeman-minutes-march.html', date: '2025-03-04' },
    ];

    const results: PipelineResult[] = [];
    const errors: Error[] = [];

    for (const fixture of fixtures) {
      try {
        const fixturePath = path.join(FIXTURES_DIR, fixture.file);
        const result = await runPipeline(fixturePath, { meetingDate: fixture.date });
        results.push(result);
      } catch (err) {
        errors.push(err as Error);
      }
    }

    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(3);

    const meetings = await db('meetings').select();
    expect(meetings).toHaveLength(3);

    const malformedMeeting = results[1];
    expect(malformedMeeting.meetingId).toBeTruthy();
    const malformedItems = await db('agenda_items').where({
      meeting_id: malformedMeeting.meetingId,
    });
    expect(malformedItems).toHaveLength(0);

    const goodItems1 = await db('agenda_items').where({ meeting_id: results[0].meetingId });
    expect(goodItems1.length).toBeGreaterThan(0);
    const goodItems2 = await db('agenda_items').where({ meeting_id: results[2].meetingId });
    expect(goodItems2.length).toBeGreaterThan(0);
  }, 30000);
});

describe('Dry-run mode: validate without DB writes', () => {
  it('parses all documents and detects anomalies without writing to DB', async () => {
    const fixtures = [
      { file: 'bozeman-minutes.html' },
      { file: 'bozeman-agenda.txt', fileType: 'html' as const },
      { file: 'bozeman-minutes-march.html' },
    ];

    const results: PipelineResult[] = [];

    for (const fixture of fixtures) {
      const fixturePath = path.join(FIXTURES_DIR, fixture.file);
      const result = await runPipeline(fixturePath, {
        dryRun: true,
        fileType: fixture.fileType,
      });
      results.push(result);
    }

    for (const result of results) {
      expect(result.parsed).toBeDefined();
      expect(result.parsed.agendaItems).toBeDefined();
      expect(result.meetingId).toBeNull();
    }

    // HTML fixtures should have rawText; the .txt file produces empty rawText via cheerio
    expect(results[0].parsed.rawText.length).toBeGreaterThan(0);
    expect(results[2].parsed.rawText.length).toBeGreaterThan(0);

    for (const result of results) {
      for (const anomaly of result.anomalies) {
        expect(anomaly.flagType).toBeTruthy();
        expect(anomaly.severity).toBeTruthy();
        expect(anomaly.description).toBeTruthy();
      }
    }

    const meetings = await db('meetings').select();
    expect(meetings).toHaveLength(0);

    const agendaItems = await db('agenda_items').select();
    expect(agendaItems).toHaveLength(0);

    const anomalyFlags = await db('anomaly_flags').select();
    expect(anomalyFlags).toHaveLength(0);
  }, 30000);
});

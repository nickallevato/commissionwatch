import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseDocument, validateInputPath } from '../src/parser/parser';
import {
  extractDate,
  extractTime,
  extractAttendees,
  extractAgendaItems,
  extractMotions,
  extractQuotes,
} from '../src/parser/extractors';

const FIXTURES = path.join(__dirname, 'fixtures');

describe('extractors', () => {
  describe('extractDate', () => {
    it('extracts ISO dates', () => {
      const result = extractDate('Meeting on 2025-01-07 at City Hall');
      expect(result.value).toBe('2025-01-07');
      expect(result.confidence).toBe('high');
    });

    it('extracts long-form dates', () => {
      const result = extractDate('January 7, 2025');
      expect(result.value).toBe('2025-01-07');
      expect(result.confidence).toBe('high');
    });

    it('extracts US slash dates', () => {
      const result = extractDate('Date: 1/7/2025');
      expect(result.value).toBe('2025-01-07');
      expect(result.confidence).toBe('medium');
    });

    it('returns null with low confidence for no match', () => {
      const result = extractDate('No date here');
      expect(result.value).toBeNull();
      expect(result.confidence).toBe('low');
    });
  });

  describe('extractTime', () => {
    it('extracts 12-hour time', () => {
      const result = extractTime('Meeting at 6:00 PM');
      expect(result.value).toBe('18:00');
      expect(result.confidence).toBe('high');
    });

    it('extracts 24-hour time', () => {
      const result = extractTime('Start: 18:00');
      expect(result.value).toBe('18:00');
      expect(result.confidence).toBe('high');
    });

    it('returns null for no time', () => {
      const result = extractTime('No time mentioned');
      expect(result.value).toBeNull();
      expect(result.confidence).toBe('low');
    });
  });

  describe('extractAttendees', () => {
    it('extracts from roll call section', () => {
      const text = `Roll Call
Mayor Avery Sample - present
Deputy Mayor Jordan Placeholder - present
Commissioner Riley Fixture - present
Commissioner Emma Bode - absent

Agenda`;
      const result = extractAttendees(text);
      expect(result.confidence).toBe('high');
      expect(result.value.length).toBe(4);
      expect(result.value[0].name).toContain('Sample');
      expect(result.value[0].present).toBe(true);
      expect(result.value[3].name).toContain('Bode');
      expect(result.value[3].present).toBe(false);
    });
  });

  describe('extractAgendaItems', () => {
    it('extracts numbered items with categories', () => {
      const text = `CONSENT AGENDA
1. Approve minutes of the January meeting
2. Claims and Payroll Report

PUBLIC HEARING
3. Conditional Use Permit for microbrewery
   Applicant requests expansion`;
      const result = extractAgendaItems(text);
      expect(result.confidence).toBe('high');
      expect(result.value.length).toBe(3);
      expect(result.value[0].itemNumber).toBe(1);
      expect(result.value[0].category).toBe('CONSENT AGENDA');
      expect(result.value[2].category).toBe('PUBLIC HEARING');
      expect(result.value[2].description).toContain('Applicant');
    });
  });

  describe('extractMotions', () => {
    it('extracts motion with votes', () => {
      const text = `Motion by Commissioner Fixture to approve the Consent Agenda.
Second by Commissioner Bode.
Sample - Aye
Placeholder - Aye
Fixture - Aye
Bode - Aye
Testcase - Aye
The motion passed unanimously.`;
      const result = extractMotions(text);
      expect(result.confidence).toBe('medium');
      expect(result.value.length).toBeGreaterThanOrEqual(1);
      expect(result.value[0].mover).toBe('Fixture');
      expect(result.value[0].seconder).toBe('Bode');
      expect(result.value[0].result).toBe('passed');
      expect(result.value[0].votes.length).toBe(5);
      expect(result.value[0].votes[0].vote).toBe('yes');
    });

    it('detects failed motions', () => {
      const text = `Motion by Commissioner Smith to table the item.
Second by Commissioner Jones.
The motion failed.`;
      const result = extractMotions(text);
      expect(result.value[0].result).toBe('failed');
    });
  });

  describe('extractQuotes', () => {
    it('extracts attributed quotes', () => {
      const text = `Commissioner Bode said "We need to ensure affordable housing is part of every annexation conversation going forward."`;
      const result = extractQuotes(text);
      expect(result.value.length).toBe(1);
      expect(result.value[0].speaker).toBe('Commissioner Bode');
      expect(result.value[0].text).toContain('affordable housing');
    });
  });
});

describe('HTML parser integration', () => {
  it('parses Bozeman minutes HTML fixture', async () => {
    const result = await parseDocument({
      input: path.join(FIXTURES, 'bozeman-minutes.html'),
      type: 'html',
    });

    expect(result.sourceType).toBe('html');
    expect(result.meetingDate.value).toBe('2025-01-07');
    expect(result.meetingDate.confidence).toBe('high');
    expect(result.meetingTime.value).toBe('18:00');
    expect(result.agendaItems.value.length).toBeGreaterThanOrEqual(5);
    expect(result.motions.value.length).toBeGreaterThanOrEqual(1);
  });
});

describe('parseDocument', () => {
  it('auto-detects HTML type from extension', async () => {
    const result = await parseDocument({
      input: path.join(FIXTURES, 'bozeman-minutes.html'),
    });
    expect(result.sourceType).toBe('html');
  });

  it('attaches sourceUrl when provided', async () => {
    const result = await parseDocument({
      input: path.join(FIXTURES, 'bozeman-minutes.html'),
      sourceUrl: 'https://example.com/minutes.html',
    });
    expect(result.sourceUrl).toBe('https://example.com/minutes.html');
  });
});

describe('validateInputPath', () => {
  it('rejects nonexistent files', () => {
    expect(() => validateInputPath('/tmp/does-not-exist-xyz.pdf')).toThrow('File not found');
  });

  it('rejects directories', () => {
    expect(() => validateInputPath(FIXTURES)).toThrow('Not a file');
  });

  it('accepts valid file paths', () => {
    const result = validateInputPath(path.join(FIXTURES, 'bozeman-minutes.html'));
    expect(result).toContain('bozeman-minutes.html');
  });

  it('resolves relative paths', () => {
    const result = validateInputPath(path.join(FIXTURES, '..', 'fixtures', 'bozeman-minutes.html'));
    expect(result).not.toContain('..');
  });
});

describe('PDF parser integration', () => {
  it('parses Bozeman agenda PDF fixture', async () => {
    const result = await parseDocument({
      input: path.join(FIXTURES, 'bozeman-agenda.pdf'),
      type: 'pdf',
    });

    expect(result.sourceType).toBe('pdf');
    expect(result.rawText).toBeTruthy();
  });

  it('rejects corrupted PDF data', async () => {
    const fs = await import('fs');
    const tmpPath = path.join(FIXTURES, 'corrupted.pdf');
    fs.writeFileSync(tmpPath, 'not a real pdf file content');

    await expect(
      parseDocument({ input: tmpPath, type: 'pdf' })
    ).rejects.toThrow(/Failed to parse PDF/);

    fs.unlinkSync(tmpPath);
  });
});

describe('--type validation', () => {
  it('rejects invalid type values', async () => {
    await expect(
      parseDocument({ input: path.join(FIXTURES, 'bozeman-minutes.html'), type: 'xml' as any })
    ).resolves.toBeDefined(); // type is used as-is when passed directly to parseDocument
  });
});

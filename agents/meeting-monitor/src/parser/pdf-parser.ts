import * as fs from 'fs';
import type { ParsedDocument } from './types';
import {
  extractDate,
  extractTime,
  extractAttendees,
  extractAgendaItems,
  extractMotions,
  extractQuotes,
} from './extractors';

export async function parsePdf(input: string): Promise<ParsedDocument> {
  const data = new Uint8Array(fs.readFileSync(input));
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .filter(item => 'str' in item)
      .map(item => (item as { str: string }).str)
      .join(' ');
    pages.push(pageText);
  }

  const text = pages.join('\n\n');

  return {
    meetingDate: extractDate(text),
    meetingTime: extractTime(text),
    attendees: extractAttendees(text),
    agendaItems: extractAgendaItems(text),
    motions: extractMotions(text),
    quotes: extractQuotes(text),
    rawText: text,
    sourceType: 'pdf',
  };
}

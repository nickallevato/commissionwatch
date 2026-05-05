import * as fs from 'fs';
import * as cheerio from 'cheerio';
import type { ParsedDocument } from './types';
import {
  extractDate,
  extractTime,
  extractAttendees,
  extractAgendaItems,
  extractMotions,
  extractQuotes,
} from './extractors';

export async function parseHtml(input: string): Promise<ParsedDocument> {
  const html = fs.readFileSync(input, 'utf-8');
  const $ = cheerio.load(html);

  // Remove scripts, styles, nav, footer to reduce noise
  $('script, style, nav, footer, header').remove();

  // Extract text preserving some structure
  const text = extractStructuredText($);

  return {
    meetingDate: extractDate(text),
    meetingTime: extractTime(text),
    attendees: extractAttendees(text),
    agendaItems: extractAgendaItems(text),
    motions: extractMotions(text),
    quotes: extractQuotes(text),
    rawText: text,
    sourceType: 'html',
  };
}

function extractStructuredText($: cheerio.CheerioAPI): string {
  const lines: string[] = [];

  // Try to find the main content area
  const mainContent = $('main, article, .content, .field-items, #content, .view-content').first();
  const root = mainContent.length ? mainContent : $('body');

  root.find('h1, h2, h3, h4, h5, h6, p, li, td, th, div, span').each((_, el) => {
    const $el = $(el);
    // Skip if this element contains block children (avoid duplicates)
    if ($el.children('h1, h2, h3, h4, h5, h6, p, div').length > 0) return;

    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      lines.push(text);
    }
  });

  return lines.join('\n');
}

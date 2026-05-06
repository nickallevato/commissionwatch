import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { BOZEMAN_CONFIG, MeetingLink, resolveUrl, parseMeetingDate } from './bozeman-commission';
import { RateLimiter } from './rate-limiter';
import { getDb } from '../db';
import { config } from '../config';

export interface ScrapeOptions {
  target: string;
  limit?: number;
  dryRun?: boolean;
}

export interface ScrapeResult {
  discovered: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

export async function scrape(options: ScrapeOptions): Promise<ScrapeResult> {
  if (options.target !== 'bozeman') {
    throw new Error(`Unsupported target: ${options.target}. Supported: bozeman`);
  }
  return scrapeBozeman(options);
}

async function scrapeBozeman(options: ScrapeOptions): Promise<ScrapeResult> {
  const limiter = new RateLimiter({ requestsPerSecond: 1 });
  const result: ScrapeResult = { discovered: 0, inserted: 0, skipped: 0, errors: [] };

  const db = getDb();
  const commission = await db('commissions')
    .join('jurisdictions', 'commissions.jurisdiction_id', 'jurisdictions.id')
    .where('commissions.name', BOZEMAN_CONFIG.commissionName)
    .select('commissions.id')
    .first();

  if (!commission) {
    throw new Error(`Commission "${BOZEMAN_CONFIG.commissionName}" not found in database. Run seeds first.`);
  }
  const commissionId: string = commission.id;

  const meetings = await discoverMeetings(limiter, options.limit);
  result.discovered = meetings.length;
  console.log(`Discovered ${meetings.length} meetings`);

  for (const meeting of meetings) {
    try {
      const existing = await db('meetings')
        .where({ commission_id: commissionId, date: meeting.date })
        .first();

      if (existing) {
        result.skipped++;
        continue;
      }

      if (options.dryRun) {
        console.log(`[dry-run] Would insert meeting: ${meeting.date}`);
        result.inserted++;
        continue;
      }

      const [inserted] = await db('meetings')
        .insert({
          commission_id: commissionId,
          date: meeting.date,
          time: meeting.time ?? BOZEMAN_CONFIG.defaults.time,
          location: meeting.location ?? BOZEMAN_CONFIG.defaults.location,
          status: 'completed',
          agenda_url: meeting.agendaUrl ?? null,
          minutes_url: meeting.minutesUrl ?? null,
        })
        .returning('id');

      const meetingId = inserted.id;
      const docs: { meeting_id: string; title: string; document_type: string; url: string }[] = [];

      if (meeting.agendaUrl) {
        docs.push({
          meeting_id: meetingId,
          title: `Agenda - ${meeting.date}`,
          document_type: 'agenda',
          url: meeting.agendaUrl,
        });
      }

      if (meeting.minutesUrl) {
        docs.push({
          meeting_id: meetingId,
          title: `Minutes - ${meeting.date}`,
          document_type: 'minutes',
          url: meeting.minutesUrl,
        });
      }

      if (docs.length > 0) {
        await db('meeting_documents').insert(docs);
      }

      console.log(`Inserted meeting: ${meeting.date} (${docs.length} documents)`);
      result.inserted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Meeting ${meeting.date}: ${msg}`);
    }
  }

  return result;
}

async function discoverMeetings(limiter: RateLimiter, limit?: number): Promise<MeetingLink[]> {
  const meetings: MeetingLink[] = [];
  let url: string | null = BOZEMAN_CONFIG.archiveUrl;

  while (url) {
    const html = await limiter.withRetry(() => fetchPage(url!));
    const $ = cheerio.load(html);
    const { selectors } = BOZEMAN_CONFIG;

    $(selectors.meetingRows).each((_i, el) => {
      if (limit && meetings.length >= limit) return false;

      const $row = $(el);

      const dateEl = $row.find(selectors.dateCell).first();
      const dateText = dateEl.attr('datetime') || dateEl.text();
      const date = parseMeetingDate(dateText);
      if (!date) return;

      const agendaEl = findLinkByText($row, $, 'agenda');
      const minutesEl = findLinkByText($row, $, 'minutes');

      const agendaHref = agendaEl?.attr('href');
      const minutesHref = minutesEl?.attr('href');

      meetings.push({
        date,
        agendaUrl: agendaHref ? resolveUrl(agendaHref) : undefined,
        minutesUrl: minutesHref ? resolveUrl(minutesHref) : undefined,
      });
    });

    if (limit && meetings.length >= limit) break;

    const nextLink = $(selectors.paginationNext).attr('href');
    url = nextLink ? resolveUrl(nextLink) : null;
  }

  return meetings;
}

function findLinkByText(
  $row: cheerio.Cheerio<AnyNode>,
  $: cheerio.CheerioAPI,
  keyword: string,
): cheerio.Cheerio<AnyNode> | null {
  const lower = keyword.toLowerCase();
  const byHref = $row.find(`a[href*="${lower}"], a[href*="${keyword}"]`);
  if (byHref.length > 0) return byHref.first();

  let match: cheerio.Cheerio<AnyNode> | null = null;
  $row.find('a').each((_i, el) => {
    if ($(el).text().toLowerCase().includes(lower)) {
      match = $(el);
      return false;
    }
  });
  return match;
}

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.scraper.timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../config';
import { getDb } from '../db';
import { RateLimiter } from './rate-limiter';
import { BOZEMAN_CONFIG, MeetingLink, parseMeetingDate, resolveUrl } from './bozeman-commission';

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

  const rateLimiter = new RateLimiter();
  const result: ScrapeResult = { discovered: 0, inserted: 0, skipped: 0, errors: [] };

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      userAgent: config.userAgent,
    });
    page.setDefaultTimeout(config.scraper.timeoutMs);

    const meetings = await discoverMeetings(page, rateLimiter, options.limit);
    result.discovered = meetings.length;

    if (options.dryRun) {
      console.log('[dry-run] Discovered meetings:');
      for (const m of meetings) {
        console.log(`  ${m.date} | agenda: ${m.agendaUrl ?? 'none'} | minutes: ${m.minutesUrl ?? 'none'}`);
      }
      return result;
    }

    const db = getDb();
    const commissionId = await ensureCommission(db);

    for (const meeting of meetings) {
      try {
        const inserted = await storeMeeting(db, commissionId, meeting);
        if (inserted) {
          result.inserted++;
        } else {
          result.skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to store meeting ${meeting.date}: ${msg}`);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  return result;
}

async function discoverMeetings(
  page: Page,
  rateLimiter: RateLimiter,
  limit?: number
): Promise<MeetingLink[]> {
  const meetings: MeetingLink[] = [];
  let currentUrl: string | null = BOZEMAN_CONFIG.archiveUrl;

  while (currentUrl) {
    await rateLimiter.withRetry(async () => {
      await page.goto(currentUrl!, { waitUntil: 'domcontentloaded' });
    });

    const pageMeetings = await extractMeetingsFromPage(page);
    meetings.push(...pageMeetings);

    if (limit && meetings.length >= limit) {
      return meetings.slice(0, limit);
    }

    currentUrl = await getNextPageUrl(page);
  }

  return limit ? meetings.slice(0, limit) : meetings;
}

async function extractMeetingsFromPage(page: Page): Promise<MeetingLink[]> {
  const { selectors, defaults } = BOZEMAN_CONFIG;
  const meetings: MeetingLink[] = [];

  const rows = await page.$$(selectors.meetingRows);
  if (rows.length === 0) {
    console.warn(`No meeting rows found with selector: ${selectors.meetingRows}`);
    return meetings;
  }

  for (const row of rows) {
    try {
      const dateEl = await row.$(selectors.dateCell);
      if (!dateEl) continue;

      const dateText = await dateEl.textContent();
      if (!dateText) continue;

      const date = parseMeetingDate(dateText);
      if (!date) continue;

      const agendaEl = await row.$(selectors.agendaLink);
      const minutesEl = await row.$(selectors.minutesLink);

      const agendaHref = agendaEl ? await agendaEl.getAttribute('href') : null;
      const minutesHref = minutesEl ? await minutesEl.getAttribute('href') : null;

      meetings.push({
        date,
        time: defaults.time,
        location: defaults.location,
        agendaUrl: agendaHref ? resolveUrl(agendaHref) : undefined,
        minutesUrl: minutesHref ? resolveUrl(minutesHref) : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Error extracting meeting row: ${msg}`);
    }
  }

  return meetings;
}

async function getNextPageUrl(page: Page): Promise<string | null> {
  const nextLink = await page.$(BOZEMAN_CONFIG.selectors.paginationNext);
  if (!nextLink) return null;

  const href = await nextLink.getAttribute('href');
  if (!href) return null;

  return resolveUrl(href);
}

async function ensureCommission(db: ReturnType<typeof getDb>): Promise<string> {
  const existing = await db('commissions')
    .where({ name: BOZEMAN_CONFIG.commissionName })
    .first();

  if (existing) return existing.id;

  const jurisdiction = await db('jurisdictions')
    .where({ name: BOZEMAN_CONFIG.jurisdictionName })
    .first();

  let jurisdictionId: string;
  if (jurisdiction) {
    jurisdictionId = jurisdiction.id;
  } else {
    const [inserted] = await db('jurisdictions')
      .insert({ name: BOZEMAN_CONFIG.jurisdictionName, state: 'MT', type: 'city' })
      .returning('id');
    jurisdictionId = inserted.id;
  }

  const [commission] = await db('commissions')
    .insert({
      name: BOZEMAN_CONFIG.commissionName,
      jurisdiction_id: jurisdictionId,
      description: 'Bozeman, Montana City Commission',
    })
    .returning('id');

  return commission.id;
}

async function storeMeeting(
  db: ReturnType<typeof getDb>,
  commissionId: string,
  meeting: MeetingLink
): Promise<boolean> {
  const existing = await db('meetings')
    .where({ commission_id: commissionId, date: meeting.date })
    .first();

  if (existing) return false;

  await db('meetings').insert({
    commission_id: commissionId,
    date: meeting.date,
    time: meeting.time,
    location: meeting.location,
    agenda_url: meeting.agendaUrl,
    minutes_url: meeting.minutesUrl,
    status: 'scheduled',
  });

  return true;
}

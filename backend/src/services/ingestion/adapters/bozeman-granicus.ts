import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  isAbsoluteHttpUrl,
  sha256Hex,
  slugifyBodyName,
  type BodyDescriptor,
  type DocumentKind,
  type DocumentRef,
  type FetchedArtifact,
  type MeetingRef,
  type MeetingStatus,
  type SourceAdapter,
  type SourceDescriptor,
} from './types';
import {
  COMMISSIONWATCH_USER_AGENT,
  createMemoryDocumentCache,
  createPoliteTransport,
  HttpStatusError,
  isAllowedByRobots,
  OffSourceUrlError,
  parseRobotsTxt,
  type CachedDocument,
  type DocumentCache,
  type HttpTransport,
  type RobotsRule,
} from './http';

/**
 * Bozeman, MT — Granicus meeting portal.
 *
 * Every selector here was written against bytes captured on **2026-08-09** into
 * `backend/test/fixtures/bozeman-granicus/`. Read that PROVENANCE.md before changing
 * anything: it records what the capture proved and, more usefully, what it disproved
 * about `docs/exploration/bozeman-access-spike.md`.
 *
 * ## Where this source is, and where it is not
 *
 * **`bozemanmt.gov` is never fetched.** It is a blanket Akamai deny that answers 403 to
 * a real Chromium from a residential IP, `/robots.txt` included. Getting through would
 * need fingerprint or TLS manipulation, which this project does not do. The records were
 * found instead by following the host's DNS CNAME chain to Granicus, which serves the
 * whole archive to an honest client with no evasion of any kind.
 *
 * ## The robots.txt exception, stated out loud
 *
 * `bozeman.granicus.com/robots.txt` is `Disallow: /` for every agent except Googlebot,
 * Slurp, msnbot and `search-one-scgov`. That is a **vendor** file in front of records the
 * City of Bozeman is obliged to publish, and it is exactly the case the operator decision
 * of 2026-08-04 covers (see `.claude/skills/commissionwatch-development/SKILL.md`). We
 * fetch anyway, under conditions that are not negotiable:
 *
 *  - one request every **ten seconds** — the `Crawl-delay` the file publishes for the
 *    agents it does allow, which is the strictest rate the site states anywhere
 *  - never concurrent
 *  - the project's honest user agent, naming the project and a contact URL. Never a
 *    browser string
 *  - no re-fetch of an unchanged document
 *  - **disclosed publicly on the Methodology page.** If that disclosure ever comes down,
 *    this adapter must be disabled with it. A transparency project does not get to carry a
 *    published policy it knowingly breaks.
 *
 * The override is not silent: `robots.txt` is still fetched and still evaluated, and the
 * first URL it would have blocked is logged as an applied exception rather than skipped.
 *
 * ## What the page actually is
 *
 * One 5.9 MB server-rendered response holds the entire archive — 1,135 past meetings
 * across 16 bodies, 2013 to 2026, plus an Upcoming Events table. The year tabs are
 * client-side only; there is no per-year endpoint to walk, which makes discovery exactly
 * one request. No JavaScript is required, so `cheerio` is enough and Playwright stays
 * unused.
 */

export const BOZEMAN_ADAPTER_KEY = 'bozeman-granicus';
export const BOZEMAN_ORIGIN = 'https://bozeman.granicus.com';
export const BOZEMAN_VIEW_ID = 1;
export const BOZEMAN_ARCHIVE_URL = `${BOZEMAN_ORIGIN}/ViewPublisher.php?view_id=${BOZEMAN_VIEW_ID}`;
export const BOZEMAN_ROBOTS_URL = `${BOZEMAN_ORIGIN}/robots.txt`;

/**
 * `AgendaViewer.php` 302s here. The redirect is followed by the transport, so this origin
 * is genuinely touched and is therefore genuinely declared — a `baseUrls` list that omits
 * a host the adapter reaches is a declaration that lies.
 */
export const BOZEMAN_ATTACHMENT_ORIGIN =
  'https://granicus_production_attachments.s3.amazonaws.com';

/** Agenda packets. Only reached when `includePackets` is on, which it is not by default. */
export const BOZEMAN_PACKET_ORIGIN = 'https://d3n9y02raazwpg.cloudfront.net';

/** Montana is entirely Mountain Time. */
export const BOZEMAN_TIMEZONE = 'America/Denver';

/**
 * Ten seconds. `Crawl-delay: 10` is the only rate `robots.txt` publishes, and where we are
 * already setting the file's `Disallow` aside we honour the number it does state rather
 * than inventing a gentler-sounding one. Five times slower than Gallatin.
 */
export const BOZEMAN_MIN_DELAY_MS = 10_000;

export const BOZEMAN_USER_AGENT = COMMISSIONWATCH_USER_AGENT;

/** `meeting_documents.title` and `.url` are knex's default varchar(255). */
const VARCHAR_255 = 255;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * Every body this adapter covers.
 *
 * The first sixteen are the collapsible panels the archive rendered on 2026-08-09, in page
 * order. `bozeman-access-spike.md` said "20+ other public bodies" on 2026-08-04; there are
 * sixteen panels in total, City Commission included.
 *
 * The last three have **no archive panel at all** — they appear only in the Upcoming Events
 * table. That is a fact about how Granicus is configured for this city, not a statement that
 * these bodies are less real or that their meetings are less public, so they are configured
 * here and their upcoming meetings are discovered like anyone else's. They will simply have
 * no past rows until the city starts archiving them.
 *
 * The list is a default rather than a truth: an override goes through `options.bodies`, and
 * a name the list does not carry is skipped **loudly**, so a city standing up a new board
 * reads as a warning in the run rather than as a quiet month at City Hall.
 */
export const BOZEMAN_BODIES: readonly string[] = Object.freeze([
  'Board of Ethics',
  'Bozeman Downtown Business Improvement District Board',
  'Bozeman Historic Preservation Advisory Board',
  'Building Division Board of Appeals',
  'City Commission',
  'Community Development Board',
  'Downtown Area Urban Renewal District Board',
  'Economic Vitality Board',
  'Gallatin Valley Metropolitan Planning Organization',
  'Inter-Neighborhood Council',
  'Police Commission',
  'Study Commission',
  'Sustainability Board',
  'Tax Increment Financing Board',
  'Transportation Board',
  'Urban Parks & Forestry Board',
  // Upcoming-only: no archive panel exists for these three.
  'Gallatin Valley MPO - Transportation Policy Coordinating Committee',
  'Gallatin Valley MPO - Transportation Technical Advisory Committee',
  'Library Board of Trustees',
]);

/**
 * Upcoming-table spellings that name a body the archive spells differently.
 *
 * Each entry is a **deliberate human judgement** that two names are one body, made by
 * reading both listings, and nothing here is derived by similarity. Close enough to guess
 * is not close enough — guessing would file a real meeting under a body nobody configured,
 * or silently merge two bodies that a city genuinely keeps apart — which is why guessing is
 * exactly what this table exists instead of. Adding an alias is one line, and the cost of
 * that line is that somebody had to check.
 *
 * Keys and values are the names as each table prints them; matching is done on the
 * normalised form, so an alias does not have to reproduce punctuation exactly.
 */
export const BOZEMAN_BODY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['Tax Increment Finance Advisory Board', 'Tax Increment Financing Board'],
]);

/**
 * The key two spellings of one body are compared on. **Matching only — never stored.**
 *
 * `slugifyBodyName` is deliberately not changed to do this: its output is
 * `MeetingRef.bodyKey` and `describeSource().bodies[].key`, a stable identifier that has
 * already been written to the database, and changing it would silently re-key existing
 * meetings. So the extra normalisation lives here and stops here.
 *
 * On top of the shared slug it drops `and` as a standalone word, because the two tables
 * disagree on the ampersand: the archive panel is "Urban Parks & Forestry Board" and the
 * Upcoming table writes "Urban Parks and Forestry Board". `slugifyBodyName` turns `&` into
 * a separator, so the ampersand form loses the word entirely and the spelled-out form keeps
 * it; dropping it from both is what makes them meet.
 */
export function bozemanBodyMatchKey(name: string): string {
  return slugifyBodyName(name)
    .split('-')
    .filter((part) => part !== '' && part !== 'and')
    .join('-');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: ReadonlyMap<string, number> = new Map([
  ['january', 1],
  ['february', 2],
  ['march', 3],
  ['april', 4],
  ['may', 5],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['september', 9],
  ['october', 10],
  ['november', 11],
  ['december', 12],
]);

export interface GranicusDateTime {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`, 24-hour, or null when the cell states no time. */
  time: string | null;
}

function composeIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Rejects February 30, which Date would silently roll forward to March 2.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * `Tuesday, August  4, 2026 - 1:17 PM` -> `{ date: '2026-08-04', time: '13:17' }`.
 *
 * An explicit month table rather than `new Date(string)`: the built-in parser is locale-
 * and runtime-dependent and rolls overflow forward, which is how a scraper starts
 * reporting meetings on days they did not happen. The leading weekday is optional — the
 * Upcoming Events table prints one and the archive tables do not — and so is the time.
 */
export function parseGranicusDateTime(text: string): GranicusDateTime | null {
  const flat = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const withoutWeekday = flat.replace(
    /^(?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day,\s*/i,
    '',
  );
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*(?:-\s*(.+))?$/.exec(withoutWeekday);
  if (!match) return null;

  const month = MONTHS.get(match[1].toLowerCase());
  if (month === undefined) return null;
  const date = composeIsoDate(Number(match[3]), month, Number(match[2]));
  if (date === null) return null;

  return { date, time: parseClockTime(match[4] ?? '') };
}

/** `1:17 PM` -> `13:17`. Null for anything that is not a 12-hour clock time. */
export function parseClockTime(text: string): string | null {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text.replace(/\s+/g, ' ').trim());
  if (!match) return null;
  const minute = Number(match[2]);
  let hour = Number(match[1]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const meridiem = match[3].toUpperCase();
  if (meridiem === 'AM') hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface GranicusDocumentLink {
  kind: DocumentKind;
  title: string;
  url: string;
  expectedContentType?: string;
}

/**
 * The path decides, and only three paths are documents.
 *
 * `MediaPlayer.php` is opened from a `javascript:` handler and is a video player, not a
 * file. Emitting it would hand the parser an HTML page and put a row in
 * `meeting_documents` for something nobody can cite.
 */
export function classifyGranicusDocument(
  url: string,
): { kind: DocumentKind; expectedContentType: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname;
  // Verified 2026-08-09: AgendaViewer 302s to an S3-hosted HTML agenda, and it is the
  // best-structured input either jurisdiction has. Minutes are served as PDF.
  if (/\/AgendaViewer\.php$/i.test(path)) {
    return { kind: 'agenda', expectedContentType: 'text/html' };
  }
  if (/\/MinutesViewer\.php$/i.test(path)) {
    return { kind: 'minutes', expectedContentType: 'application/pdf' };
  }
  if (parsed.origin === BOZEMAN_PACKET_ORIGIN && /\.pdf$/i.test(path)) {
    return { kind: 'packet', expectedContentType: 'application/pdf' };
  }
  return null;
}

/**
 * The clip id in an archive row's video link, or null.
 *
 * **This exists because `classifyGranicusDocument` was never called with the
 * player URL at all.** The archive writes the link as
 * `<a href="javascript:void(0);" onClick="window.open('//bozeman.granicus.com/MediaPlayer.php?view_id=1&clip_id=2687', ...)">`,
 * and `parseRow` iterates `a[href]` and reads the `href` — which is
 * `javascript:void(0);`. `absolute()` builds a `javascript:` URL,
 * `isAbsoluteHttpUrl` rejects it, and the link is dropped before classification
 * ever runs. Fixing the classifier alone would have achieved exactly nothing;
 * the extraction path had to read the `onclick` attribute instead. (cheerio
 * lowercases attribute names, so the source's `onClick` is `onclick` here.)
 *
 * Counted over the stored fixture on 2026-08-14: 1,152 `tr.listingRow` rows,
 * **1,135 of them carry a clip id**. Every archived meeting has a recording.
 *
 * `classifyGranicusDocument` is deliberately left unchanged, and stays that way
 * even now that the player page is fetched. Classification answers "what kind of
 * file is at this href?", and the answer for `MediaPlayer.php` is still `null` —
 * it is a page, not a file, and a `javascript:` href is not an address. What the
 * adapter emits are two URLs *derived from the clip id*: the captions file, and
 * the player page itself as a `recording` document. Deriving them keeps the rule
 * that a link is classified by what it points at, and keeps the regression guard
 * on `classifyGranicusDocument` meaningful.
 */
export const GRANICUS_CLIP_LINK = /MediaPlayer\.php\?[^'"]*?\bclip_id=(\d+)/i;

export function extractGranicusClipId(row: cheerio.Cheerio<AnyNode>): string | null {
  let clipId: string | null = null;
  row.find('a[onclick]').each((_index, element) => {
    if (clipId !== null) return;
    const match = GRANICUS_CLIP_LINK.exec(
      // cheerio's typings allow undefined; a link with no handler is not an error.
      (element.type === 'tag' ? element.attribs.onclick : undefined) ?? '',
    );
    if (match !== null) clipId = match[1];
  });
  return clipId;
}

/** The captions file Granicus serves for a clip. `text/vtt`, or an empty stub. */
export function granicusCaptionsUrl(clipId: string): string {
  return `${BOZEMAN_ORIGIN}/videos/${clipId}/captions.vtt`;
}

/**
 * The custodian's own page for the recording.
 *
 * Fetched — the page, never the media. It 302s to `/player/clip/{id}` on the same
 * origin and states the recording's media id and its length, which is what
 * `meeting_recordings` holds. The media it points at is on
 * `archive-video.granicus.com`, which answered a browser string with `200` and
 * this project's honest user agent with `403` when probed on 2026-08-15, so that
 * host is not in `allowedOrigins` and never will be: reaching it means claiming to
 * be a browser.
 */
export function granicusPlayerUrl(clipId: string): string {
  return `${BOZEMAN_ORIGIN}/MediaPlayer.php?view_id=${BOZEMAN_VIEW_ID}&clip_id=${clipId}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface GranicusRow {
  /** The Name cell — a per-meeting title, not the body's name. */
  title: string;
  date: string;
  /**
   * Whatever the Date cell states, reported verbatim — and it does not mean the same
   * thing in both tables. In Upcoming Events it is the meeting's scheduled start. In the
   * archive it is the **video clip's** start: the 2026-08-04 City Commission row says
   * 1:17 PM while that meeting's own agenda states an early start of 2:00 PM.
   *
   * Discovery therefore publishes this only for an upcoming row. Putting a clip's start
   * time on a meeting would be a false claim about the record, and absent beats invented.
   */
  time: string | null;
  /**
   * The video clip's id, out of the row's `onclick` player link. Null when the row
   * has no recording — 17 of the fixture's 1,152 rows. That is a fact about the
   * archive, not an error.
   */
  clipId: string | null;
  documents: GranicusDocumentLink[];
}

export interface GranicusPanel {
  /** The collapsible panel's tab text, verbatim — the body's name. */
  name: string;
  rows: GranicusRow[];
}

export interface GranicusArchive {
  /** Rows from the Upcoming Events table. Their Name cell names the **body**. */
  upcoming: GranicusRow[];
  panels: GranicusPanel[];
}

function clamp(text: string, max: number): string {
  const trimmed = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function absolute(href: string): string | null {
  try {
    // Granicus writes its own links protocol-relative: `//bozeman.granicus.com/...`.
    const url = new URL(href, `${BOZEMAN_ORIGIN}/`).toString();
    return isAbsoluteHttpUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function parseRow($: cheerio.CheerioAPI, row: cheerio.Cheerio<AnyNode>): GranicusRow | null {
  const name = clamp(row.find('td[headers~="Name"]').first().text(), VARCHAR_255);
  const dateCell = row.find('td[headers~="Date"]').first().text();
  const when = parseGranicusDateTime(dateCell);
  if (when === null) return null;

  const documents: GranicusDocumentLink[] = [];
  const seen = new Set<string>();
  row.find('a[href]').each((_index, element) => {
    const link = $(element);
    const url = absolute(link.attr('href') ?? '');
    if (url === null || url.length > VARCHAR_255 || seen.has(url)) return;
    const classified = classifyGranicusDocument(url);
    if (classified === null) return;
    seen.add(url);
    const label = clamp(link.text(), VARCHAR_255);
    documents.push({
      kind: classified.kind,
      title: label === '' ? classified.kind : label,
      url,
      expectedContentType: classified.expectedContentType,
    });
  });

  return {
    title: name === '' ? `Meeting ${when.date}` : name,
    date: when.date,
    time: when.time,
    clipId: extractGranicusClipId(row),
    documents,
  };
}

/**
 * Reads `ViewPublisher.php?view_id=1` into its Upcoming table and its per-body panels.
 *
 * Rows are read **per panel** rather than by sweeping `tr.listingRow` across the page,
 * because the Name cell is a meeting title and not a body: the City Commission panel
 * alone carries "City Commission", "City Commission Special Meeting", "City Commission
 * Meeting pt 1" and 200-odd more. The panel's tab is the only place the body is stated.
 */
export function parseGranicusArchive(html: string): GranicusArchive {
  const $ = cheerio.load(html);

  const panels: GranicusPanel[] = [];
  $('div.CollapsiblePanel').each((_index, element) => {
    const panel = $(element);
    const name = clamp(panel.children('div.CollapsiblePanelTab').first().text(), VARCHAR_255);
    if (name === '') return;
    const rows: GranicusRow[] = [];
    panel.find('tr.listingRow').each((_rowIndex, rowElement) => {
      const row = parseRow($, $(rowElement));
      if (row) rows.push(row);
    });
    panels.push({ name, rows });
  });

  // Everything outside a panel is the Upcoming Events table.
  const upcoming: GranicusRow[] = [];
  $('tr.listingRow').each((_index, element) => {
    const rowElement = $(element);
    if (rowElement.closest('div.CollapsiblePanel').length > 0) return;
    const row = parseRow($, rowElement);
    if (row) upcoming.push(row);
  });

  return { upcoming, panels };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` for `instant` as it reads on a wall clock in `timeZone`. */
export function localCalendarDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * A row that says it was cancelled was cancelled; otherwise the table it sits in decides,
 * with the date as a backstop. Reporting a cancelled meeting as `completed` would be a
 * false statement about the public record, and a title containing "CANCELLED" is not
 * ambiguous.
 */
export function classifyGranicusStatus(
  title: string,
  meetingDate: string,
  today: string,
  fromUpcomingTable: boolean,
): MeetingStatus {
  if (/\bcancell?ed\b/i.test(title)) return 'cancelled';
  if (fromUpcomingTable) return 'scheduled';
  return meetingDate > today ? 'scheduled' : 'completed';
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface BozemanLogger {
  warn(message: string): void;
}

export interface BozemanAdapterOptions {
  /** Defaults to a polite `fetch` transport at {@link BOZEMAN_MIN_DELAY_MS}. */
  transport?: HttpTransport;
  /** Defaults to {@link BOZEMAN_BODIES}. */
  bodies?: readonly string[];
  /** Defaults to a per-instance in-memory cache, so a sweep fetches a URL at most once. */
  documentCache?: DocumentCache;
  /** Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Defaults to **false**, and that is the vendor-robots exception being applied.
   * Setting it true makes the adapter obey `Disallow: /` and discover nothing, which is
   * the correct behaviour the day the operator withdraws the exception.
   */
  respectRobotsTxt?: boolean;
  /**
   * Agenda packets. Off by default: one verified packet is **28.4 MB across 439 pages**
   * and 724 of the archive's rows carry one, so turning this on points several gigabytes
   * at a t4g.medium's disk to obtain a superset of an agenda we already fetch as 36 KB of
   * HTML. It is an operator's decision with a storage bill attached, not a default.
   */
  includePackets?: boolean;
  logger?: BozemanLogger;
}

const consoleLogger: BozemanLogger = {
  warn: (message) => console.warn(message),
};

/**
 * `City Commission` -> `Bozeman City Commission`, and `Bozeman Historic Preservation
 * Advisory Board` -> itself.
 *
 * `commissions` is keyed on `(jurisdiction_id, name)`, so the prefix is not needed to keep
 * two jurisdictions' Study Commissions apart — it is there so an operator reading a list of
 * commission names does not have to guess whose they are. Five of the sixteen panels
 * already say Bozeman, and "Bozeman Bozeman Historic Preservation Advisory Board" is the
 * kind of detail that makes a reader stop trusting the rest of the page.
 */
export function qualifiedBodyName(name: string): string {
  return /^bozeman\b/i.test(name) ? name : `Bozeman ${name}`;
}

interface ResolvedBody {
  key: string;
  name: string;
}

export function createBozemanGranicusAdapter(
  options: BozemanAdapterOptions = {},
): SourceAdapter {
  const transport =
    options.transport ??
    createPoliteTransport({
      userAgent: BOZEMAN_USER_AGENT,
      minDelayMs: BOZEMAN_MIN_DELAY_MS,
      // A retry that is only visible as slowness is a retry nobody can debug.
      onRetry: ({ url, attempt, waitMs, reason }) =>
        (options.logger ?? consoleLogger).warn(
          `bozeman-granicus: retry ${attempt} of ${url} in ${waitMs}ms after ${reason}`,
        ),
    });
  const documentCache = options.documentCache ?? createMemoryDocumentCache();
  const now = options.now ?? ((): Date => new Date());
  const respectRobotsTxt = options.respectRobotsTxt ?? false;
  const includePackets = options.includePackets ?? false;
  const logger = options.logger ?? consoleLogger;
  const decoder = new TextDecoder('utf-8');

  const bodies: ResolvedBody[] = (options.bodies ?? BOZEMAN_BODIES).map((name) => ({
    name,
    key: slugifyBodyName(name),
  }));
  // Keyed on the match form, not on `body.key`, so the two tables' spellings of one body
  // both land on it. The value still carries the stored `key` untouched.
  const bodyByMatchKey = new Map(bodies.map((body) => [bozemanBodyMatchKey(body.name), body]));

  const aliasTargetByMatchKey = new Map(
    [...BOZEMAN_BODY_ALIASES].map(([from, to]) => [
      bozemanBodyMatchKey(from),
      bozemanBodyMatchKey(to),
    ]),
  );

  /** The configured body a listing's name refers to, or undefined if none does. */
  const resolveBody = (name: string): ResolvedBody | undefined => {
    const key = bozemanBodyMatchKey(name);
    return bodyByMatchKey.get(aliasTargetByMatchKey.get(key) ?? key);
  };

  const allowedOrigins = [
    BOZEMAN_ORIGIN,
    BOZEMAN_ATTACHMENT_ORIGIN,
    ...(includePackets ? [BOZEMAN_PACKET_ORIGIN] : []),
  ];

  let robotsRules: RobotsRule[] | null = null;
  let exceptionLogged = false;

  async function loadRobots(): Promise<RobotsRule[]> {
    if (robotsRules !== null) return robotsRules;
    const response = await transport({ url: BOZEMAN_ROBOTS_URL, method: 'GET' });
    // A site that serves no robots.txt has not disallowed anything.
    robotsRules =
      response.status === 200
        ? parseRobotsTxt(decoder.decode(response.bytes), BOZEMAN_USER_AGENT)
        : [];
    return robotsRules;
  }

  /**
   * Refuses anything off the declared surface, then evaluates robots.txt.
   *
   * The evaluation happens whether or not we obey the answer. An override nobody can see
   * in a log is an override nobody can audit, and if Granicus ever adds a group naming
   * this project the log is where that becomes visible.
   */
  async function guard(url: string): Promise<void> {
    const parsed = new URL(url);
    if (!allowedOrigins.includes(parsed.origin)) {
      throw new OffSourceUrlError(url, allowedOrigins);
    }
    if (parsed.origin !== BOZEMAN_ORIGIN) return;

    const rules = await loadRobots();
    if (isAllowedByRobots(rules, `${parsed.pathname}${parsed.search}`)) return;
    if (respectRobotsTxt) {
      throw new RobotsExceptionWithdrawnError(url);
    }
    if (!exceptionLogged) {
      exceptionLogged = true;
      logger.warn(
        `[${BOZEMAN_ADAPTER_KEY}] bozeman.granicus.com/robots.txt disallows ${parsed.pathname} ` +
          'for this agent. Fetching anyway under the vendor-robots exception of 2026-08-04: ' +
          'a vendor blanket Disallow does not withdraw a custodian\'s public records. ' +
          'One request every 10s, honest user agent, disclosed on the Methodology page.',
      );
    }
  }

  async function getText(url: string): Promise<string> {
    await guard(url);
    const response = await transport({ url, method: 'GET' });
    if (response.status !== 200) {
      throw new HttpStatusError(url, response.status);
    }
    return decoder.decode(response.bytes);
  }

  function toDocumentRefs(
    row: GranicusRow,
    externalId: string,
  ): DocumentRef[] {
    const refs = row.documents
      .filter((document) => includePackets || document.kind !== 'packet')
      .map((document): DocumentRef => {
        const ref: DocumentRef = {
          sourceKey: BOZEMAN_ADAPTER_KEY,
          kind: document.kind,
          title: document.title,
          url: document.url,
          meetingExternalId: externalId,
        };
        if (document.expectedContentType !== undefined) {
          ref.expectedContentType = document.expectedContentType;
        }
        return ref;
      });

    // The captions file, derived from the row's clip id rather than found as a
    // link — Granicus publishes no anchor to it. Probed 2026-08-14 across thirty
    // clips: `videos/{clip_id}/captions.vtt` answers 200 `text/vtt` under the same
    // posture as an agenda, on an origin already in `allowedOrigins` and already
    // covered by the vendor-robots exception of 2026-08-04. **The Methodology page
    // must name captions among the fetched kinds** — that exception is valid only
    // while it is disclosed, and a disclosure listing agendas and minutes while we
    // also take transcripts is a disclosure that has gone stale.
    //
    // The ref's `url` is the captions file and not the player, because the fetch
    // stage locates the document row with `where({ meeting_id, url })` against a
    // table unique on `(meeting_id, url)`. Emitting the player URL and rewriting it
    // later would break that join. The player URL rides along in `metadata` so a
    // reader has the custodian's own address for the recording.
    if (row.clipId !== null) {
      refs.push({
        sourceKey: BOZEMAN_ADAPTER_KEY,
        kind: 'transcript',
        title: clamp(`Captions (clip ${row.clipId})`, VARCHAR_255),
        url: granicusCaptionsUrl(row.clipId),
        meetingExternalId: externalId,
        expectedContentType: 'text/vtt',
        metadata: { clipId: row.clipId, mediaPlayerUrl: granicusPlayerUrl(row.clipId) },
      });

      // The player page, as a document in its own right.
      //
      // This is what is left of the audio-transcription spec after its own open
      // question was probed on 2026-08-15. The recording is not fetchable by
      // acceptable means — `archive-video.granicus.com` answers a Chrome user
      // agent with `200 content-length: 6008707697` and answers this project's
      // honest one, and curl's default, with `403` — so nothing is transcribed
      // and the media host stays off `allowedOrigins`. The page, on the other
      // hand, is on the same origin and under the same disclosed exception as
      // the agenda beside it, and it states two facts nothing else in this
      // project knows: which recording this meeting has, and how long it is.
      //
      // That is what lets the site say a 2h 56m recording of the 2013-09-23
      // meeting exists and has no transcript — the sentence that makes a
      // records request worth making, rather than a silence that reads like a
      // meeting nobody recorded.
      refs.push({
        sourceKey: BOZEMAN_ADAPTER_KEY,
        kind: 'recording',
        title: clamp(`Recording index (clip ${row.clipId})`, VARCHAR_255),
        url: granicusPlayerUrl(row.clipId),
        meetingExternalId: externalId,
        expectedContentType: 'text/html',
        metadata: { clipId: row.clipId },
      });
    }
    return refs;
  }

  return {
    key: BOZEMAN_ADAPTER_KEY,

    describeSource(): SourceDescriptor {
      return {
        key: BOZEMAN_ADAPTER_KEY,
        jurisdiction: {
          name: 'City of Bozeman',
          state: 'MT',
          type: 'city',
          // Deliberately the portal, not bozemanmt.gov: a link nobody — including this
          // adapter — can fetch is not this jurisdiction's usable address.
          websiteUrl: BOZEMAN_ORIGIN,
        },
        bodies: bodies.map(
          (body): BodyDescriptor => ({
            key: body.key,
            name: qualifiedBodyName(body.name),
            listingUrl: BOZEMAN_ARCHIVE_URL,
          }),
        ),
        baseUrls: [...allowedOrigins],
        politeness: {
          minDelayMs: BOZEMAN_MIN_DELAY_MS,
          maxConcurrency: 1,
          userAgent: BOZEMAN_USER_AGENT,
          // False on purpose, and the descriptor says so rather than hiding it: this is
          // the vendor-robots exception, and an operator reading the source row is
          // entitled to see that it is in force.
          respectRobotsTxt,
          maxRetries: 3,
        },
        supportsLiveFetch: true,
        notes:
          'Granicus meeting portal, ViewPublisher.php?view_id=1 — one 5.9 MB page holds ' +
          'the whole 2013-2026 archive. bozemanmt.gov is a blanket Akamai deny and is ' +
          'never fetched. robots.txt is Disallow: / for this agent; we fetch under the ' +
          'operator vendor-robots exception of 2026-08-04 at the published Crawl-delay ' +
          'of 10s, disclosed on the Methodology page. Agenda packets (28 MB, 439 pages) ' +
          'are not fetched unless includePackets is set.',
      };
    },

    async discoverMeetings(since: Date): Promise<MeetingRef[]> {
      const sinceDay = since.toISOString().slice(0, 10);
      const today = localCalendarDate(now(), BOZEMAN_TIMEZONE);

      const archive = parseGranicusArchive(await getText(BOZEMAN_ARCHIVE_URL));

      // `${bodyKey}-${date}`, with an ordinal for a second meeting of the same body on the
      // same day. Not Granicus's clip_id/event_id: a meeting is listed under an event_id
      // while it is upcoming and under a clip_id once it has happened, so keying on those
      // turns one real meeting into two rows in `meetings`, one of them stuck at
      // `scheduled` for ever. Keyed this way the upcoming row is revised into the
      // completed one by the existing upsert, which is what actually happened.
      const used = new Map<string, number>();
      const assignExternalId = (bodyKey: string, date: string): string => {
        const base = `${bodyKey}-${date}`;
        const seen = (used.get(base) ?? 0) + 1;
        used.set(base, seen);
        return seen === 1 ? base : `${base}-${seen}`;
      };

      const refs: MeetingRef[] = [];
      const emit = (
        body: ResolvedBody,
        row: GranicusRow,
        fromUpcomingTable: boolean,
      ): void => {
        if (row.date < sinceDay) return;
        const externalId = assignExternalId(body.key, row.date);
        const ref: MeetingRef = {
          sourceKey: BOZEMAN_ADAPTER_KEY,
          bodyKey: body.key,
          date: row.date,
          timezone: BOZEMAN_TIMEZONE,
          status: classifyGranicusStatus(row.title, row.date, today, fromUpcomingTable),
          title: row.title,
          externalId,
          sourceUrl: BOZEMAN_ARCHIVE_URL,
          documents: toDocumentRefs(row, externalId),
        };
        if (!fromUpcomingTable && row.clipId === null) {
          // No recording, so no captions to seek. Logged rather than counted as a
          // gap: a row without a clip is a fact about the archive. 17 of the
          // fixture's 1,152 rows are like this.
          logger.warn(
            `[${BOZEMAN_ADAPTER_KEY}] archive row '${row.title}' on ${row.date} carries no ` +
              'clip id; no transcript is sought for it.',
          );
        }
        // Only the Upcoming table states a scheduled start; the archive prints the video
        // clip's start, which is not the same fact. Absent beats invented.
        if (fromUpcomingTable && row.time !== null) ref.time = row.time;
        refs.push(ref);
      };

      // Upcoming first, so a meeting listed in both tables keeps the id it was given while
      // it was still scheduled.
      for (const row of archive.upcoming) {
        const body = resolveBody(row.title);
        if (!body) {
          // The Upcoming table names bodies its own way. The two disagreements this source
          // is known to have are handled deliberately — the ampersand by
          // `bozemanBodyMatchKey`, "Tax Increment Finance Advisory Board" by an entry in
          // `BOZEMAN_BODY_ALIASES` — and anything left over is a name nobody has checked.
          // Guessing at it would file a meeting under a body nobody configured.
          logger.warn(
            `[${BOZEMAN_ADAPTER_KEY}] upcoming meeting '${row.title}' on ${row.date} names no ` +
              'configured body; skipped. Add it to ingestion_sources.config.bodies.',
          );
          continue;
        }
        emit(body, row, true);
      }

      for (const panel of archive.panels) {
        const body = resolveBody(panel.name);
        if (!body) {
          logger.warn(
            `[${BOZEMAN_ADAPTER_KEY}] archive panel '${panel.name}' is not in the configured ` +
              `body list; ${panel.rows.length} row(s) skipped. Add it to ` +
              'ingestion_sources.config.bodies.',
          );
          continue;
        }
        for (const row of panel.rows) {
          emit(body, row, false);
        }
      }

      // Newest first, then a total order so a sweep is byte-for-byte reproducible.
      return refs.sort((left, right) => {
        if (left.date !== right.date) return left.date < right.date ? 1 : -1;
        if (left.bodyKey !== right.bodyKey) return left.bodyKey < right.bodyKey ? -1 : 1;
        const leftId = left.externalId ?? '';
        const rightId = right.externalId ?? '';
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
    },

    async fetchDocument(ref: DocumentRef): Promise<FetchedArtifact> {
      await guard(ref.url);

      const cached = documentCache.get(ref.url);
      const headers: Record<string, string> = {};
      if (cached?.etag !== undefined) headers['If-None-Match'] = cached.etag;
      if (cached?.lastModified !== undefined) headers['If-Modified-Since'] = cached.lastModified;

      const conditional = Object.keys(headers).length > 0;
      if (cached !== undefined && !conditional) {
        return artifactFrom(cached, ref);
      }

      const response = await transport({
        url: ref.url,
        method: 'GET',
        headers: conditional ? headers : undefined,
      });

      if (response.status === 304) {
        if (cached === undefined) {
          throw new HttpStatusError(ref.url, 304);
        }
        return artifactFrom(cached, ref);
      }
      if (response.status !== 200) {
        throw new HttpStatusError(ref.url, response.status);
      }

      const entry: CachedDocument = {
        bytes: response.bytes,
        contentType: response.headers['content-type'] ?? null,
        // The URL after redirects: `AgendaViewer.php` lands on S3 and `MinutesViewer.php`
        // on `DocumentViewer.php`. `artifacts.source_url` records what was actually read.
        sourceUrl: response.finalUrl,
        etag: response.headers['etag'],
        lastModified: response.headers['last-modified'],
      };
      documentCache.set(ref.url, entry);
      return artifactFrom(entry, ref);
    },
  };

  function artifactFrom(entry: CachedDocument, ref: DocumentRef): FetchedArtifact {
    // A copy, so a caller mutating the artifact cannot corrupt the cache — or the hash.
    const bytes = Uint8Array.from(entry.bytes);
    return {
      bytes,
      contentType: entry.contentType,
      sourceUrl: entry.sourceUrl,
      sha256: sha256Hex(bytes),
      byteSize: bytes.length,
      fetchedAt: now().toISOString(),
      ref,
    };
  }
}

/**
 * Raised when `respectRobotsTxt` is on and robots.txt disallows the URL.
 *
 * Distinct from Gallatin's `RobotsDisallowedError` in what it means operationally: for
 * this source it is not a surprise, it is the exception having been switched off, and the
 * message says so rather than reading as a site that changed.
 */
export class RobotsExceptionWithdrawnError extends Error {
  constructor(readonly url: string) {
    super(
      `robots.txt disallows ${url} and the vendor-robots exception is switched off for ` +
        'bozeman-granicus, so nothing is fetched. This is the correct behaviour once the ' +
        'exception is withdrawn; re-enable it only alongside the Methodology disclosure.',
    );
    this.name = 'RobotsExceptionWithdrawnError';
  }
}

export const bozemanGranicusAdapter: SourceAdapter = createBozemanGranicusAdapter();

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  isAbsoluteHttpUrl,
  sha256Hex,
  type BodyDescriptor,
  type DocumentKind,
  type DocumentRef,
  type FetchedArtifact,
  type MeetingRef,
  type MeetingStatus,
  type SourceAdapter,
  type SourceDescriptor,
} from './types';

/**
 * Gallatin County, MT — CivicPlus AgendaCenter.
 *
 * Every selector below was written against bytes captured on 2026-08-04 into
 * `tests/fixtures/gallatin/`; see the PROVENANCE.md there for the exact requests and
 * for what the capture disproved. Three things it disproved are load-bearing:
 *
 *  1. `/AgendaCenter` renders **one year per category**. The other years are links that
 *     re-request the category through `POST /AgendaCenter/UpdateCategoryList`. Discovery
 *     therefore walks years; reading the index alone loses everything older.
 *  2. `/AgendaCenter/Search/?startDate=&endDate=` does **not** flatten years. A two-year
 *     range returned exactly the index's rows. It is not a discovery mechanism.
 *  3. `UpdateCategoryList` for a category with no agendas answers with a **whole page**
 *     rather than the `span#section{catId}` fragment every other category returns. Row
 *     parsing is scoped to that span, so an unexpected page reads as zero meetings for the
 *     category asked about instead of as whatever rows the page happens to contain.
 *
 * The County Commission (category 14) is empty in AgendaCenter: its agendas live behind an
 * AV Capture All embed and need a separate adapter. This one covers the twelve boards,
 * committees and commissions AgendaCenter does serve.
 */

export const GALLATIN_ADAPTER_KEY = 'gallatin-civicplus';
export const GALLATIN_ORIGIN = 'https://www.gallatinmt.gov';
export const GALLATIN_AGENDA_CENTER_URL = `${GALLATIN_ORIGIN}/AgendaCenter`;
export const GALLATIN_UPDATE_CATEGORY_URL = `${GALLATIN_ORIGIN}/AgendaCenter/UpdateCategoryList`;
export const GALLATIN_ROBOTS_URL = `${GALLATIN_ORIGIN}/robots.txt`;

/** Montana is entirely Mountain Time. */
export const GALLATIN_TIMEZONE = 'America/Denver';

/** One request every two seconds. Four times slower than the contract's floor. */
export const GALLATIN_MIN_DELAY_MS = 2000;

/**
 * Honest and contactable: names the project and links a page an operator being crawled
 * can read. No browser string, no spoofing.
 */
export const GALLATIN_USER_AGENT =
  'CommissionWatch/0.1 (civic transparency project; +https://commissionwatch.bmux.sh)';

/** `meeting_documents.title` and `.url` are knex's default varchar(255). */
const VARCHAR_255 = 255;

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  /** Form-encoded body, for the one endpoint that takes a POST. */
  body?: string;
  /** Extra request headers. The transport supplies the user agent. */
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  /** Header names lowercased. */
  headers: Record<string, string>;
  bytes: Uint8Array;
  /** The URL after redirects. */
  finalUrl: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export class HttpStatusError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} fetching ${url}`);
    this.name = 'HttpStatusError';
  }
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

export class OffSourceUrlError extends Error {
  constructor(
    readonly url: string,
    readonly allowedOrigins: string[],
  ) {
    super(`${url} is outside the declared surface (${allowedOrigins.join(', ')})`);
    this.name = 'OffSourceUrlError';
  }
}

/**
 * Exactly the slice of `fetch` this transport uses. Narrower than `typeof fetch` so a test
 * double is an ordinary function rather than something cast into shape.
 */
export interface FetchLikeInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: RequestRedirect;
  signal: AbortSignal;
}

export type FetchLike = (input: string, init: FetchLikeInit) => Promise<Response>;

export interface PoliteTransportOptions {
  userAgent?: string;
  /** Floor on the gap between two requests. */
  minDelayMs?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The politeness lives here rather than in the adapter so that a fixture-backed transport
 * runs at test speed without the adapter having a "skip the delay" switch that could ever
 * be flipped in production. One request in flight at a time, `minDelayMs` between them.
 */
export function createPoliteTransport(options: PoliteTransportOptions = {}): HttpTransport {
  const userAgent = options.userAgent ?? GALLATIN_USER_AGENT;
  const minDelayMs = options.minDelayMs ?? GALLATIN_MIN_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? realSleep;
  const doFetch: FetchLike = options.fetchImpl ?? fetch;

  let lastRequestAt = Number.NEGATIVE_INFINITY;
  // Serializes requests: maxConcurrency is 1, and it is 1 because the queue is a chain.
  let queue: Promise<unknown> = Promise.resolve();

  async function perform(request: HttpRequest): Promise<HttpResponse> {
    const waitMs = lastRequestAt === Number.NEGATIVE_INFINITY ? 0 : lastRequestAt + minDelayMs - now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestAt = now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'User-Agent': userAgent,
        ...(request.headers ?? {}),
      };
      if (request.method === 'POST' && request.body !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const init: FetchLikeInit = {
        method: request.method,
        headers,
        redirect: 'follow',
        signal: controller.signal,
      };
      if (request.method === 'POST' && request.body !== undefined) {
        init.body = request.body;
      }
      const response = await doFetch(request.url, init);

      const flat: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        flat[name.toLowerCase()] = value;
      });

      // 304 carries no body; asking for one is not an error, it is just empty.
      const bytes =
        response.status === 304
          ? new Uint8Array(0)
          : new Uint8Array(await response.arrayBuffer());

      return {
        status: response.status,
        headers: flat,
        bytes,
        finalUrl: response.url === '' ? request.url : response.url,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return (request: HttpRequest): Promise<HttpResponse> => {
    const result = queue.then(() => perform(request));
    // The chain itself must never reject, or one failed request poisons every later one.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsRule {
  allow: boolean;
  path: string;
}

/**
 * The `User-agent: *` group of a robots.txt, plus any group naming us. Deliberately
 * small: prefix rules with `*` and `$`, longest match wins, `Allow` wins a tie — which is
 * what the REP says and all Gallatin's file needs.
 */
export function parseRobotsTxt(text: string, userAgentToken: string): RobotsRule[] {
  const token = userAgentToken.toLowerCase();
  const groups = new Map<string, RobotsRule[]>();
  let currentAgents: string[] = [];
  let expectingAgents = true;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!expectingAgents) {
        currentAgents = [];
        expectingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    expectingAgents = false;
    if (value === '') continue;
    for (const agent of currentAgents) {
      const rules = groups.get(agent) ?? [];
      rules.push({ allow: field === 'allow', path: value });
      groups.set(agent, rules);
    }
  }

  // A group naming us beats the wildcard group; that is the REP's precedence.
  for (const [agent, rules] of groups) {
    if (agent !== '*' && token.includes(agent)) {
      return rules;
    }
  }
  return groups.get('*') ?? [];
}

function robotsPatternToRegExp(pattern: string): RegExp {
  let source = '';
  for (const character of pattern) {
    if (character === '*') {
      source += '.*';
    } else if (character === '$') {
      source += '$';
    } else {
      source += character.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}`);
}

/** True when `pathname` (with query) is fetchable under `rules`. */
export function isAllowedByRobots(rules: RobotsRule[], pathname: string): boolean {
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of rules) {
    if (!robotsPatternToRegExp(rule.path).test(pathname)) continue;
    const length = rule.path.length;
    if (best === null || length > best.length || (length === best.length && rule.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best === null ? true : best.allow;
}

// ---------------------------------------------------------------------------
// Document cache
// ---------------------------------------------------------------------------

export interface CachedDocument {
  bytes: Uint8Array;
  contentType: string | null;
  sourceUrl: string;
  etag?: string;
  lastModified?: string;
}

export interface DocumentCache {
  get(url: string): CachedDocument | undefined;
  set(url: string, entry: CachedDocument): void;
}

export function createMemoryDocumentCache(): DocumentCache {
  const entries = new Map<string, CachedDocument>();
  return {
    get: (url) => entries.get(url),
    set: (url, entry) => {
      entries.set(url, entry);
    },
  };
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** An AgendaCenter category: a meeting body plus the numeric id its rows hang off. */
export interface GallatinBody {
  /** `catID` in the site's own markup and AJAX. */
  catId: number;
  /** The category heading, verbatim. */
  name: string;
}

/**
 * The twelve categories AgendaCenter listed on 2026-08-04, in the order the site shows
 * them. `Commission` (14) is included because the site declares it, even though it
 * currently carries no agendas — omitting it would hide the gap rather than report it.
 */
export const GALLATIN_BODIES: readonly GallatinBody[] = Object.freeze([
  { catId: 3, name: 'Big Sky Meadow Trails, Recreation & Parks Special District' },
  { catId: 7, name: 'Big Sky Zoning Advisory Committee' },
  { catId: 14, name: 'Commission' },
  { catId: 8, name: 'Consolidated Board of Adjustment' },
  { catId: 5, name: 'County Planning Board' },
  { catId: 10, name: 'Hebgen Lake Zoning Advisory Committee' },
  { catId: 11, name: 'Open Lands Board' },
  { catId: 12, name: 'Planning & Zoning Commission' },
  { catId: 13, name: 'Planning Coordination Committee' },
  { catId: 2, name: 'Study Commission' },
  { catId: 15, name: 'Superintendent of Schools' },
  { catId: 4, name: 'Weed Board' },
]);

/** Lowercase kebab-case, the shape `BodyDescriptor.key` is contracted to. */
export function slugifyBodyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface AgendaCenterDocumentLink {
  kind: DocumentKind;
  title: string;
  url: string;
  /**
   * `application/pdf` only when the row's Download drop-down marks the link `class="pdf"`,
   * and undefined otherwise. A `ViewFile` URL is not necessarily a PDF: the August 6 2026
   * Weed Board agenda is classed `html` and serves a Word document. Guessing PDF for every
   * document would hand the PDF parser a `.docx`.
   */
  expectedContentType?: string;
}

export interface AgendaCenterRow {
  /** The site's own identifier, e.g. `12042025-101`. Unique across the whole page. */
  externalId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** The agenda link's visible text, e.g. `Weed Board Agendas Regular Meeting Agenda`. */
  title: string;
  documents: AgendaCenterDocumentLink[];
}

export interface AgendaCenterSection {
  catId: number;
  /** The year the section is currently rendering, from `li.current`. */
  currentYear: number | null;
  /** Every year the category offers, newest first. */
  years: number[];
  rows: AgendaCenterRow[];
}

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

/**
 * `December 4, 2025` -> `2025-12-04`. An explicit month table, not `new Date(string)`:
 * the built-in parser is locale- and runtime-dependent and silently rolls overflow
 * forward, which is how a scraper starts reporting meetings on days they did not happen.
 */
export function parseLongDate(text: string): string | null {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(text.replace(/\s+/g, ' ').trim());
  if (!match) return null;
  const month = MONTHS.get(match[1].toLowerCase());
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  return composeIsoDate(year, month, day);
}

/** `12042025-101` -> `2025-12-04`. The id's own `MMDDYYYY` prefix. */
export function parseDateFromExternalId(externalId: string): string | null {
  const match = /^_?(\d{2})(\d{2})(\d{4})-/.exec(externalId);
  if (!match) return null;
  return composeIsoDate(Number(match[3]), Number(match[1]), Number(match[2]));
}

function composeIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Rejects February 30, which Date would roll forward to March 2.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function clamp(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/**
 * The path segment decides. `/AgendaCenter/ViewFile/Minutes/_04022026-104` is minutes no
 * matter what its label says; the label only distinguishes an agenda from a packet, which
 * the path cannot.
 */
export function classifyDocumentKind(url: string, label: string): DocumentKind {
  const path = (() => {
    try {
      return new URL(url, GALLATIN_ORIGIN).pathname;
    } catch {
      return url;
    }
  })();
  if (/\/ViewFile\/Minutes\//i.test(path)) return 'minutes';
  if (/\/ViewFile\/Agenda\//i.test(path)) {
    return /packet/i.test(label) ? 'packet' : 'agenda';
  }
  if (/minutes/i.test(label)) return 'minutes';
  if (/packet/i.test(label)) return 'packet';
  if (/agenda/i.test(label)) return 'agenda';
  return 'other';
}

/**
 * Only `/AgendaCenter/ViewFile/...` is a document. The Download drop-down also carries a
 * `Previous Versions` link, which is an HTML revision index, not a file — emitting it as a
 * `meeting_documents` row would send the PDF parser an HTML page.
 */
export function isViewFileUrl(url: string): boolean {
  try {
    return /^\/AgendaCenter\/ViewFile\//i.test(new URL(url, GALLATIN_ORIGIN).pathname);
  } catch {
    return false;
  }
}

function absolute(href: string): string | null {
  try {
    const url = new URL(href, `${GALLATIN_ORIGIN}/`).toString();
    return isAbsoluteHttpUrl(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Reads one `<span id="section{catId}">`. Scoped on purpose: `UpdateCategoryList` answers
 * an empty category with a whole page containing other categories' rows, and an unscoped
 * `tr.catAgendaRow` sweep would file those rows under the wrong body.
 *
 * Returns null when the document carries no section for `catId` — which is exactly how
 * that empty-category response is recognised.
 */
export function parseCategorySection(html: string, catId: number): AgendaCenterSection | null {
  const $ = cheerio.load(html);
  const section = $(`span#section${catId}`);
  if (section.length === 0) return null;

  const years: number[] = [];
  section.find('a[href^="javascript:changeYear("]').each((_index, element) => {
    const href = $(element).attr('href') ?? '';
    const match = /changeYear\(\s*(\d{4})\s*,/.exec(href);
    if (match) {
      const year = Number(match[1]);
      if (!years.includes(year)) years.push(year);
    }
  });
  years.sort((left, right) => right - left);

  const currentText = section.find('ul.years li.current').first().text().trim();
  const currentMatch = /^(\d{4})$/.exec(currentText);
  const currentYear = currentMatch ? Number(currentMatch[1]) : (years[0] ?? null);

  const rows: AgendaCenterRow[] = [];
  section.find('tr.catAgendaRow').each((_index, element) => {
    const row = parseAgendaRow($, $(element));
    if (row) rows.push(row);
  });

  return { catId, currentYear, years, rows };
}

function parseAgendaRow(
  $: cheerio.CheerioAPI,
  row: cheerio.Cheerio<AnyNode>,
): AgendaCenterRow | null {
  const anchorId = row.find('h3 a[id]').first().attr('id') ?? '';
  const externalId = anchorId.replace(/^_/, '');
  if (externalId === '') return null;

  const heading = row.find('h3 strong[aria-label]').first();
  const ariaLabel = heading.attr('aria-label') ?? '';
  const ariaDate = /^Agenda for\s+(.+)$/i.exec(ariaLabel);
  const date =
    (ariaDate ? parseLongDate(ariaDate[1]) : null) ?? parseDateFromExternalId(externalId);
  if (date === null) return null;

  const agendaLink = row.find('td p a[href]').first();
  const title = clamp(agendaLink.text(), VARCHAR_255);

  const documents: AgendaCenterDocumentLink[] = [];
  const seenUrls = new Set<string>();

  // The Download drop-down is the only place the source states a file format, as a class
  // on the link. Collected first, because the agenda link outside the drop-down carries no
  // class of its own and still needs the answer.
  const pdfUrls = new Set<string>();
  row.find('td.downloads a.pdf[href]').each((_index, element) => {
    const url = absolute($(element).attr('href') ?? '');
    if (url !== null) pdfUrls.add(url);
  });

  const push = (href: string | undefined, label: string): void => {
    if (!href) return;
    const url = absolute(href);
    if (url === null || !isViewFileUrl(url)) return;
    if (url.length > VARCHAR_255 || seenUrls.has(url)) return;
    seenUrls.add(url);
    const document: AgendaCenterDocumentLink = {
      kind: classifyDocumentKind(url, label),
      title: clamp(label, VARCHAR_255),
      url,
    };
    if (pdfUrls.has(url)) document.expectedContentType = 'application/pdf';
    documents.push(document);
  };

  push(agendaLink.attr('href'), title === '' ? 'Agenda' : title);

  const minutesLink = row.find('td.minutes a[href]').first();
  push(
    minutesLink.attr('href'),
    clamp(minutesLink.attr('aria-label') ?? `Minutes - ${title}`, VARCHAR_255),
  );

  // The Download drop-down repeats the agenda and, on some rows, adds packets. Repeats
  // collapse on URL, so this only ever contributes documents the row did not already show.
  row.find('td.downloads a[href]').each((_index, element) => {
    const link = $(element);
    push(link.attr('href'), clamp(link.text() || link.attr('aria-label') || 'Document', VARCHAR_255));
  });

  return {
    externalId,
    date,
    title: title === '' ? `Meeting ${date}` : title,
    documents,
  };
}

export interface AgendaCenterIndex {
  /** Categories the index declares, in page order. */
  categories: GallatinBody[];
  sections: AgendaCenterSection[];
}

/** Reads `/AgendaCenter`: the category headings plus each one's rendered section. */
export function parseAgendaCenterIndex(html: string): AgendaCenterIndex {
  const $ = cheerio.load(html);
  const categories: GallatinBody[] = [];
  const sections: AgendaCenterSection[] = [];

  $('div.listing[id^="cat"]').each((_index, element) => {
    const listing = $(element);
    const idMatch = /^cat(\d+)$/.exec(listing.attr('id') ?? '');
    if (!idMatch) return;
    const catId = Number(idMatch[1]);
    const name = clamp(listing.children('h2').first().text(), VARCHAR_255);
    if (name === '') return;
    categories.push({ catId, name });

    const section = parseCategorySection($.html(listing), catId);
    if (section) sections.push(section);
  });

  return { categories, sections };
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
 * AgendaCenter states no status, so it is derived: a meeting later than today is
 * scheduled, otherwise it has happened.
 *
 * The cancellation check is a title heuristic. No cancelled row appeared in the
 * 2026-08-04 capture, so it is unverified against live data — but reporting a cancelled
 * meeting as `completed` would be a false claim about the public record, and a row that
 * says "CANCELLED" is not ambiguous.
 */
export function classifyMeetingStatus(
  title: string,
  meetingDate: string,
  today: string,
): MeetingStatus {
  if (/\bcancell?ed\b/i.test(title)) return 'cancelled';
  return meetingDate > today ? 'scheduled' : 'completed';
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface GallatinAdapterOptions {
  /** Defaults to a polite, robots-respecting `fetch` transport. */
  transport?: HttpTransport;
  /** Defaults to {@link GALLATIN_BODIES}. */
  bodies?: readonly GallatinBody[];
  /** Defaults to a per-instance in-memory cache, so a sweep fetches a URL at most once. */
  documentCache?: DocumentCache;
  /** Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Defaults to true. Turning it off is a deliberate, visible act. */
  respectRobotsTxt?: boolean;
}

interface ResolvedBody extends GallatinBody {
  key: string;
}

export function createGallatinCivicPlusAdapter(
  options: GallatinAdapterOptions = {},
): SourceAdapter {
  const transport = options.transport ?? createPoliteTransport();
  const documentCache = options.documentCache ?? createMemoryDocumentCache();
  const now = options.now ?? (() => new Date());
  const respectRobotsTxt = options.respectRobotsTxt ?? true;
  const decoder = new TextDecoder('utf-8');

  const bodies: ResolvedBody[] = (options.bodies ?? GALLATIN_BODIES).map((body) => ({
    ...body,
    key: slugifyBodyName(body.name),
  }));
  const bodyByCatId = new Map(bodies.map((body) => [body.catId, body]));

  let robotsRules: RobotsRule[] | null = null;

  async function loadRobots(): Promise<RobotsRule[]> {
    if (robotsRules !== null) return robotsRules;
    const response = await transport({ url: GALLATIN_ROBOTS_URL, method: 'GET' });
    // A site that serves no robots.txt has not disallowed anything.
    robotsRules =
      response.status === 200
        ? parseRobotsTxt(decoder.decode(response.bytes), GALLATIN_USER_AGENT)
        : [];
    return robotsRules;
  }

  async function guard(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.origin !== GALLATIN_ORIGIN) {
      throw new OffSourceUrlError(url, [GALLATIN_ORIGIN]);
    }
    if (!respectRobotsTxt) return;
    const rules = await loadRobots();
    if (!isAllowedByRobots(rules, `${parsed.pathname}${parsed.search}`)) {
      throw new RobotsDisallowedError(url);
    }
  }

  async function getText(request: HttpRequest): Promise<string> {
    await guard(request.url);
    const response = await transport(request);
    if (response.status !== 200) {
      throw new HttpStatusError(request.url, response.status);
    }
    return decoder.decode(response.bytes);
  }

  function toMeetingRef(
    body: ResolvedBody,
    row: AgendaCenterRow,
    sourceUrl: string,
    today: string,
  ): MeetingRef {
    return {
      sourceKey: GALLATIN_ADAPTER_KEY,
      bodyKey: body.key,
      date: row.date,
      // AgendaCenter states neither a start time nor a room. Inventing either would
      // manufacture a fact the record does not contain, so both stay absent.
      timezone: GALLATIN_TIMEZONE,
      status: classifyMeetingStatus(row.title, row.date, today),
      title: row.title,
      externalId: row.externalId,
      sourceUrl,
      documents: row.documents.map((document): DocumentRef => {
        const ref: DocumentRef = {
          sourceKey: GALLATIN_ADAPTER_KEY,
          kind: document.kind,
          title: document.title,
          url: document.url,
          meetingExternalId: row.externalId,
        };
        if (document.expectedContentType !== undefined) {
          ref.expectedContentType = document.expectedContentType;
        }
        return ref;
      }),
    };
  }

  return {
    key: GALLATIN_ADAPTER_KEY,

    describeSource(): SourceDescriptor {
      return {
        key: GALLATIN_ADAPTER_KEY,
        jurisdiction: {
          name: 'Gallatin County',
          state: 'MT',
          type: 'county',
          websiteUrl: GALLATIN_ORIGIN,
        },
        bodies: bodies.map(
          (body): BodyDescriptor => ({
            key: body.key,
            name: body.name,
            listingUrl: GALLATIN_AGENDA_CENTER_URL,
          }),
        ),
        baseUrls: [GALLATIN_ORIGIN],
        politeness: {
          minDelayMs: GALLATIN_MIN_DELAY_MS,
          maxConcurrency: 1,
          userAgent: GALLATIN_USER_AGENT,
          respectRobotsTxt,
          maxRetries: 3,
        },
        supportsLiveFetch: true,
        notes:
          'CivicPlus AgendaCenter. The index renders one year per category; older years ' +
          'are re-requested through POST /AgendaCenter/UpdateCategoryList. Category 14 ' +
          '("Commission") is declared by the site but carries no agendas — Gallatin ' +
          'County Commission material is served from an AV Capture All embed and needs a ' +
          'separate adapter.',
      };
    },

    async discoverMeetings(since: Date): Promise<MeetingRef[]> {
      const sinceDay = since.toISOString().slice(0, 10);
      const sinceYear = Number(sinceDay.slice(0, 4));
      const today = localCalendarDate(now(), GALLATIN_TIMEZONE);

      const indexHtml = await getText({ url: GALLATIN_AGENDA_CENTER_URL, method: 'GET' });
      const index = parseAgendaCenterIndex(indexHtml);

      const byExternalId = new Map<string, MeetingRef>();
      const collect = (section: AgendaCenterSection, sourceUrl: string): void => {
        const body = bodyByCatId.get(section.catId);
        // A category the descriptor does not declare cannot be attributed to a body, and
        // inventing one would file meetings under a name no operator configured. It is
        // skipped — but loudly: a county that stands up a new committee is a config
        // change an operator has to make, not something to discover from missing data.
        if (!body) {
          console.warn(
            `[${GALLATIN_ADAPTER_KEY}] AgendaCenter category ${section.catId} is not in the ` +
              `configured body list; ${section.rows.length} row(s) skipped. Add it to ` +
              'ingestion_sources.config.bodies.',
          );
          return;
        }
        for (const row of section.rows) {
          if (row.date < sinceDay) continue;
          if (byExternalId.has(row.externalId)) continue;
          byExternalId.set(row.externalId, toMeetingRef(body, row, sourceUrl, today));
        }
      };

      for (const section of index.sections) {
        collect(section, GALLATIN_AGENDA_CENTER_URL);
      }

      const renderedYearByCatId = new Map(
        index.sections.map((section) => [section.catId, section.currentYear]),
      );

      for (const section of index.sections) {
        const rendered = renderedYearByCatId.get(section.catId) ?? null;
        const wanted = section.years.filter((year) => year >= sinceYear && year !== rendered);
        for (const year of wanted) {
          const html = await getText({
            url: GALLATIN_UPDATE_CATEGORY_URL,
            method: 'POST',
            body: new URLSearchParams({ year: String(year), catID: String(section.catId) }).toString(),
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });
          const fragment = parseCategorySection(html, section.catId);
          if (fragment) collect(fragment, GALLATIN_AGENDA_CENTER_URL);
        }
      }

      // Newest first, then a total order so a sweep is byte-for-byte reproducible.
      return [...byExternalId.values()].sort((left, right) => {
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

      // Gallatin sends no ETag or Last-Modified, so the second fetch of a URL inside one
      // sweep is answered here rather than on the wire. Conditional headers are still
      // sent when a validator is known, in case the source starts supplying them.
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

export const gallatinCivicPlusAdapter: SourceAdapter = createGallatinCivicPlusAdapter();

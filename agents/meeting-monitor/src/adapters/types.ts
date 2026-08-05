import { createHash } from 'node:crypto';

/**
 * The source adapter contract.
 *
 * Ingestion used to be a Bozeman-shaped function. It is now an interface: one
 * module per source (`gallatin-civicplus`, `bozeman-akamai`, `mt-cers`), each
 * implementing {@link SourceAdapter} and each passing the single shared suite in
 * `contract.test.ts`. Adding a jurisdiction never touches core code.
 *
 * Field names and value domains here are pinned to the database schema, which is
 * the source of truth:
 *  - `SourceAdapter.key`      -> `ingestion_sources.adapter_key` (varchar(100))
 *  - `SourceHealth`           -> `ingestion_source_health` enum (016)
 *  - `Jurisdiction.type`      -> `jurisdiction_type` enum (001)
 *  - `MeetingRef.status`      -> `meeting_status` enum (003)
 *  - `MeetingRef.date`/`time` -> `meetings.date` (date) / `meetings.time` (time)
 *  - `FetchedArtifact.*`      -> `artifacts` columns (019)
 */

/** Lowercase hex SHA-256, exactly as `artifacts.sha256` is constrained in 019. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** `YYYY-MM-DD`, the shape `meetings.date` accepts. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 24-hour `HH:MM`, the shape `meetings.time` accepts. */
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Adapter keys are lowercase kebab-case and fit `ingestion_sources.adapter_key`. */
export const ADAPTER_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ADAPTER_KEY_MAX_LENGTH = 100;

/**
 * Floor on the delay every adapter must declare between requests: 500ms, i.e. no
 * more than two requests per second, matching `config.scraper.requestsPerSecond`.
 * All targeted material is public record; fetching it is still done politely.
 */
export const MIN_POLITENESS_DELAY_MS = 500;

/** Mirrors the `ingestion_source_health` enum. */
export type SourceHealth = 'healthy' | 'degraded' | 'blocked';

/** Mirrors the `meeting_status` enum. */
export type MeetingStatus = 'scheduled' | 'completed' | 'cancelled';

/** `meeting_documents.document_type` is a free string; adapters emit these. */
export type DocumentKind =
  | 'agenda'
  | 'minutes'
  | 'packet'
  | 'resolution'
  | 'ordinance'
  | 'attachment'
  | 'other';

/** Mirrors the `jurisdiction_type` enum. */
export type JurisdictionType = 'city' | 'county';

export interface JurisdictionDescriptor {
  /** `jurisdictions.name`, e.g. 'Gallatin County'. */
  name: string;
  /** `jurisdictions.state`, two-letter USPS code, e.g. 'MT'. */
  state: string;
  type: JurisdictionType;
  /** `jurisdictions.website_url`. */
  websiteUrl?: string;
}

/** A meeting body the adapter covers, e.g. the county commission. */
export interface BodyDescriptor {
  /** Stable slug used in {@link MeetingRef.bodyKey}, e.g. 'county-commission'. */
  key: string;
  /** `commissions.name`, e.g. 'Gallatin County Commission'. */
  name: string;
  /** Absolute URL of the listing page meetings are discovered from. */
  listingUrl: string;
}

/**
 * How hard the adapter is allowed to press the source. Declared, not implied, so
 * the contract suite can assert it and so an operator can read it off the source
 * row without reading the adapter.
 */
export interface PolitenessPolicy {
  /** Minimum milliseconds between two requests. At least {@link MIN_POLITENESS_DELAY_MS}. */
  minDelayMs: number;
  /** Simultaneous in-flight requests. Effectively always 1. */
  maxConcurrency: number;
  /** Honest UA naming the project and carrying a contact address. */
  userAgent: string;
  respectRobotsTxt: boolean;
  /** Attempts after the first before the job is failed and the source degraded. */
  maxRetries: number;
}

/**
 * Everything core needs to know about a source without knowing the source: which
 * jurisdiction and bodies it covers, which hosts it touches, how politely.
 */
export interface SourceDescriptor {
  /** Must equal {@link SourceAdapter.key}. */
  key: string;
  jurisdiction: JurisdictionDescriptor;
  /** At least one. */
  bodies: BodyDescriptor[];
  /**
   * Every origin the adapter will ever request. A declared surface: an adapter
   * that fetches outside this list is out of contract.
   */
  baseUrls: string[];
  politeness: PolitenessPolicy;
  /**
   * False when live fetching is unavailable for reasons retrying will not fix —
   * the source sits in `blocked` health while every stage downstream of `fetch`
   * keeps running against stored artifacts. Bozeman is expected to sit here.
   */
  supportsLiveFetch: boolean;
  /** Operator-facing note, e.g. why a source is blocked. */
  notes?: string;
}

/** A document the adapter can fetch. Serialized into `ingestion_jobs.target`. */
export interface DocumentRef {
  /** Owning adapter's key. */
  sourceKey: string;
  /** Maps to `meeting_documents.document_type`. */
  kind: DocumentKind;
  /** Maps to `meeting_documents.title`. */
  title: string;
  /** Absolute URL. Maps to `meeting_documents.url`. */
  url: string;
  /** Links the document back to its meeting when the source assigns ids. */
  meetingExternalId?: string;
  /** Best guess ahead of the fetch, e.g. 'application/pdf'. */
  expectedContentType?: string;
}

/** A meeting the adapter discovered. Serialized into `ingestion_jobs.target`. */
export interface MeetingRef {
  /** Owning adapter's key. */
  sourceKey: string;
  /** One of {@link SourceDescriptor.bodies}' keys. */
  bodyKey: string;
  /** Calendar date in {@link MeetingRef.timezone}, `YYYY-MM-DD`. */
  date: string;
  /** Local start time `HH:MM`, when the source states one. */
  time?: string;
  /** IANA zone the date and time are expressed in, e.g. 'America/Denver'. */
  timezone: string;
  status: MeetingStatus;
  title?: string;
  /** `meetings.location`. */
  location?: string;
  /** Identifier assigned by the source, when it has one. Unique within a sweep. */
  externalId?: string;
  /** Page this meeting was discovered on. Every ref carries its provenance. */
  sourceUrl: string;
  documents: DocumentRef[];
}

/**
 * The bytes of a fetched document plus its content address.
 *
 * The sha256 is what makes re-fetching an unchanged document a no-op: it collides
 * with the existing `artifacts.sha256` unique index and the pipeline stops there.
 * It is computed from `bytes` and nothing else — not the URL, not the fetch time.
 */
export interface FetchedArtifact {
  /** The document, verbatim. */
  bytes: Uint8Array;
  /** Server-reported type; null when the source sent none. `artifacts.content_type`. */
  contentType: string | null;
  /** The URL actually fetched, after redirects. `artifacts.source_url`. */
  sourceUrl: string;
  /** Lowercase hex SHA-256 of `bytes`. `artifacts.sha256`. */
  sha256: string;
  /** `bytes.length`. Mirrors `artifacts.byte_size`. */
  byteSize: number;
  /** ISO 8601 instant. `artifacts.fetched_at`. */
  fetchedAt: string;
  /** The ref this artifact answers. */
  ref: DocumentRef;
}

/**
 * One module per source. Core calls only these three methods; everything
 * jurisdiction-specific lives behind them.
 */
export interface SourceAdapter {
  /** e.g. 'gallatin-civicplus'. Matches `ingestion_sources.adapter_key`. */
  readonly key: string;
  /** Pure and stable: same descriptor every call, no network. */
  describeSource(): SourceDescriptor;
  /** Meetings on or after `since`. Discovery only — no documents are fetched. */
  discoverMeetings(since: Date): Promise<MeetingRef[]>;
  /** Fetches one document and content-addresses it. */
  fetchDocument(ref: DocumentRef): Promise<FetchedArtifact>;
}

/** The one canonical hash. Adapters must use it so their addresses agree. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** True when `value` is a `YYYY-MM-DD` string naming a real calendar date. */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Rejects overflow like 2025-02-30, which Date silently rolls forward.
  return parsed.toISOString().slice(0, 10) === value;
}

/** True when `value` is an IANA zone this runtime recognizes. */
export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** True when `value` is an absolute http(s) URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

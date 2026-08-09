import { createHash } from 'node:crypto';
import type { CacheStore } from './http-cache';

const DEFAULT_BASE_URL = 'https://api.open.fec.gov/v1';
// The API declares cache-control: max-age=3600. Six hours is deliberately
// more conservative: campaign finance filings do not change hourly.
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// 1,000 requests/hour is the registered-key allowance, i.e. one per 3.6s.
// DEMO_KEY is limited to 10 per window and must never be used in CI.
const DEFAULT_MIN_INTERVAL_MS = 3_600;

type Primitive = string | number | boolean;

export interface OpenFecResponse<T> {
  api_version?: string;
  pagination?: {
    page?: number;
    pages?: number;
    per_page?: number;
    count?: number;
  };
  results: T[];
}

export interface OpenFecContributionRecord {
  committee_name?: string | null;
  candidate_name?: string | null;
  contributor_name?: string | null;
  contributor_city?: string | null;
  contributor_state?: string | null;
  contribution_receipt_amount?: number | null;
  contribution_receipt_date?: string | null;
  two_year_transaction_period?: number | null;
  image_number?: string | null;
  sub_id?: string | number | null;
}

export interface OpenFecExpenditureRecord {
  committee_name?: string | null;
  recipient_name?: string | null;
  disbursement_amount?: number | null;
  disbursement_date?: string | null;
  disbursement_description?: string | null;
  two_year_transaction_period?: number | null;
  image_number?: string | null;
  sub_id?: string | number | null;
}

export interface OpenFecQueryOptions {
  path: string;
  params?: Record<string, Primitive | null | undefined>;
  cacheTtlMs?: number;
}

export interface OpenFecClientOptions {
  apiKey?: string;
  baseUrl?: string;
  cacheTtlMs?: number;
  minIntervalMs?: number;
  cacheStore?: CacheStore | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SearchContributionsInput {
  candidateName?: string;
  committeeName?: string;
  contributorName?: string;
  cycle?: number;
  minAmount?: number;
  perPage?: number;
}

export interface SearchExpendituresInput {
  committeeName?: string;
  recipientName?: string;
  cycle?: number;
  minAmount?: number;
  perPage?: number;
}

export class OpenFecClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly minIntervalMs: number;
  private readonly cacheStore: CacheStore | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private rateLimitChain: Promise<void> = Promise.resolve();
  private nextAllowedAt = 0;

  constructor(options: OpenFecClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENFEC_API_KEY;
    if (!apiKey) {
      throw new Error('OPENFEC_API_KEY is required to query campaign finance data');
    }

    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.cacheStore = options.cacheStore ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async searchContributions(
    input: SearchContributionsInput,
  ): Promise<OpenFecResponse<OpenFecContributionRecord>> {
    return this.query<OpenFecContributionRecord>({
      path: '/schedules/schedule_a/',
      params: {
        sort_hide_null: false,
        sort: '-contribution_receipt_date',
        per_page: input.perPage ?? 20,
        candidate_name: input.candidateName,
        committee_name: input.committeeName,
        contributor_name: input.contributorName,
        min_amount: input.minAmount,
        two_year_transaction_period: input.cycle,
      },
    });
  }

  async searchExpenditures(
    input: SearchExpendituresInput,
  ): Promise<OpenFecResponse<OpenFecExpenditureRecord>> {
    return this.query<OpenFecExpenditureRecord>({
      path: '/schedules/schedule_b/by_recipient/',
      params: {
        sort_hide_null: false,
        sort: '-disbursement_date',
        per_page: input.perPage ?? 20,
        committee_name: input.committeeName,
        recipient_name: input.recipientName,
        min_amount: input.minAmount,
        two_year_transaction_period: input.cycle,
      },
    });
  }

  async query<T>(options: OpenFecQueryOptions): Promise<OpenFecResponse<T>> {
    const queryParams = sanitizeParams(options.params ?? {});

    // The cache key covers the query only. Including api_key would mean a key
    // rotation silently discards every cached response and produces a burst of
    // traffic against a rate-limited API for no gain.
    const cacheKey = buildCacheKey(
      `${this.baseUrl}${options.path}?${toSearchParams(queryParams).toString()}`,
    );

    const cached = await this.cacheStore?.get<OpenFecResponse<T>>(cacheKey);
    if (cached) {
      return cached;
    }

    const search = toSearchParams({ ...queryParams, api_key: this.apiKey });
    const requestUrl = `${this.baseUrl}${options.path}?${search.toString()}`;

    await this.waitForTurn();

    const response = await this.fetchImpl(requestUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      // Deliberately not cached. A cached failure would be served for the
      // whole TTL and read as an empty result set rather than an outage.
      throw new Error(`OpenFEC request failed with ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as OpenFecResponse<T>;
    await this.cacheStore?.set(cacheKey, body, options.cacheTtlMs ?? this.cacheTtlMs);
    return body;
  }

  /**
   * Serialises requests and spaces them by `minIntervalMs`. Callers may run
   * concurrently; the chain guarantees the API still sees one request at a
   * time at the configured rate.
   */
  private async waitForTurn(): Promise<void> {
    const previous = this.rateLimitChain;
    let release: (() => void) | undefined;
    this.rateLimitChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    const waitMs = Math.max(0, this.nextAllowedAt - this.now());
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
    this.nextAllowedAt = this.now() + this.minIntervalMs;
    release?.();
  }
}

function sanitizeParams(
  params: Record<string, Primitive | null | undefined>,
): Record<string, Primitive> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, Primitive>;
}

function toSearchParams(params: Record<string, Primitive>): URLSearchParams {
  return new URLSearchParams(
    Object.entries(params)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)]),
  );
}

function buildCacheKey(requestUrl: string): string {
  return `openfec:${createHash('sha256').update(requestUrl).digest('hex')}`;
}

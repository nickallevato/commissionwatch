import type { Knex } from "knex";
import {
  CONTRIBUTIONS_PATH,
  EXPENDITURES_PATH,
  contributionParams,
  expenditureParams,
  publicRequestUrl,
  type OpenFecClient,
  type OpenFecContributionRecord,
  type OpenFecExpenditureRecord,
} from "../openfec-client";

/**
 * Federal campaign finance ingestion.
 *
 * A plain service. It takes a database handle and an `OpenFecClient` and
 * returns counts; it holds no lock, registers no agent, creates no task and
 * emits no event. Concurrency, if it is ever needed, is the Postgres advisory
 * lock the ingestion scheduler already takes per source — the archive's
 * `acquireLock` / `HeartbeatExecutor` / `createTask` triad is deliberately not
 * reproduced here, per the salvage spec's Tier C.
 *
 * The client is **injected**, never constructed from the environment inside a
 * loop. That is what keeps this module testable without a key and off the
 * network, and it is why nothing here reads `process.env`.
 *
 * ## Caching
 *
 * The client is handed a `CacheStore` by its caller — in production the
 * `http_cache`-backed `HttpCache`. A repeated sweep inside the six-hour TTL
 * makes no request at all. That matters more here than elsewhere: a registered
 * OpenFEC key allows a thousand requests an hour, and a roster of twelve
 * officials swept hourly would otherwise spend a quarter of that on answers
 * that had not changed.
 *
 * ## What it will usually find
 *
 * Nothing. See `coverage.ts`. A county commissioner has no federal filings, so
 * a sweep that returns zero rows is the ordinary outcome and is reported as a
 * count, not as an error.
 */

export const OPENFEC_SOURCE_SYSTEM = "openfec";

export interface OfficialRef {
  id: string;
  name: string;
  jurisdiction_id: string;
}

export interface FinanceIngestOptions {
  client: OpenFecClient;
  /** Filing period. Defaults to the current two-year federal cycle. */
  cycle?: number;
  perPage?: number;
  now?: () => Date;
}

export interface FinanceIngestCounts {
  officialsQueried: number;
  contributionsSeen: number;
  contributionsInserted: number;
  expendituresSeen: number;
  expendituresInserted: number;
  /** Records the filing system returned that were unusable — see `normalize*`. */
  recordsRejected: number;
}

const EMPTY: FinanceIngestCounts = {
  officialsQueried: 0,
  contributionsSeen: 0,
  contributionsInserted: 0,
  expendituresSeen: 0,
  expendituresInserted: 0,
  recordsRejected: 0,
};

/** The two-year federal transaction period containing `date`. */
export function federalCycle(date: Date = new Date()): number {
  const year = date.getUTCFullYear();
  return year % 2 === 0 ? year : year + 1;
}

export async function ingestFederalFinanceForOfficial(
  db: Knex,
  official: OfficialRef,
  options: FinanceIngestOptions,
): Promise<FinanceIngestCounts> {
  const now = options.now ?? (() => new Date());
  const cycle = options.cycle ?? federalCycle(now());
  const perPage = options.perPage ?? 25;

  const contributionInput = { candidateName: official.name, cycle, perPage };
  const expenditureInput = { recipientName: official.name, cycle, perPage };

  const contributionUrl = publicRequestUrl(
    CONTRIBUTIONS_PATH,
    contributionParams(contributionInput),
    options.client.requestBaseUrl,
  );
  const expenditureUrl = publicRequestUrl(
    EXPENDITURES_PATH,
    expenditureParams(expenditureInput),
    options.client.requestBaseUrl,
  );

  const [contributionResponse, expenditureResponse] = await Promise.all([
    options.client.searchContributions(contributionInput),
    options.client.searchExpenditures(expenditureInput),
  ]);

  const counts: FinanceIngestCounts = { ...EMPTY, officialsQueried: 1 };
  const retrievedAt = now();

  for (const record of contributionResponse.results ?? []) {
    counts.contributionsSeen += 1;
    const row = normalizeContribution(record, {
      fallbackRecipient: official.name,
      jurisdictionId: official.jurisdiction_id,
      cycle,
      sourceUrl: contributionUrl,
      retrievedAt,
    });
    if (!row) {
      counts.recordsRejected += 1;
      continue;
    }
    if (await insertContributionIfNew(db, row)) counts.contributionsInserted += 1;
  }

  for (const record of expenditureResponse.results ?? []) {
    counts.expendituresSeen += 1;
    const row = normalizeExpenditure(record, {
      jurisdictionId: official.jurisdiction_id,
      cycle,
      sourceUrl: expenditureUrl,
      retrievedAt,
    });
    if (!row) {
      counts.recordsRejected += 1;
      continue;
    }
    if (await insertExpenditureIfNew(db, row)) counts.expendituresInserted += 1;
  }

  return counts;
}

/**
 * Sweep every official on a jurisdiction's roster, or on every roster.
 *
 * Serial rather than parallel, on purpose: the client serialises and spaces its
 * own requests anyway, so a `Promise.all` over the roster would buy nothing but
 * a burst of open sockets against a rate-limited public API.
 */
export async function ingestFederalFinance(
  db: Knex,
  options: FinanceIngestOptions & { jurisdictionId?: string },
): Promise<FinanceIngestCounts> {
  const query = db("members").select("id", "name", "jurisdiction_id").orderBy("name", "asc");
  if (options.jurisdictionId) query.where({ jurisdiction_id: options.jurisdictionId });
  const officials = (await query) as OfficialRef[];

  const total: FinanceIngestCounts = { ...EMPTY };
  for (const official of officials) {
    const counts = await ingestFederalFinanceForOfficial(db, official, options);
    total.officialsQueried += counts.officialsQueried;
    total.contributionsSeen += counts.contributionsSeen;
    total.contributionsInserted += counts.contributionsInserted;
    total.expendituresSeen += counts.expendituresSeen;
    total.expendituresInserted += counts.expendituresInserted;
    total.recordsRejected += counts.recordsRejected;
  }
  return total;
}

/* ------------------------------------------------------------------------- */

export interface ContributionRow {
  source_system: string;
  jurisdiction_id: string | null;
  recipient_name: string;
  committee_name: string | null;
  donor_name: string;
  donor_employer: string | null;
  donor_occupation: string | null;
  donor_city: string | null;
  donor_state: string | null;
  amount: number;
  contribution_date: string;
  cycle: number | null;
  external_id: string | null;
  image_number: string | null;
  source_url: string;
  retrieved_at: Date;
  raw: string;
}

export interface ExpenditureRow {
  source_system: string;
  jurisdiction_id: string | null;
  committee_name: string | null;
  recipient_name: string;
  purpose: string | null;
  amount: number;
  disbursement_date: string;
  cycle: number | null;
  external_id: string | null;
  image_number: string | null;
  source_url: string;
  retrieved_at: Date;
  raw: string;
}

interface NormalizeContext {
  jurisdictionId: string | null;
  cycle: number;
  sourceUrl: string;
  retrievedAt: Date;
}

/**
 * A filed record becomes a row, or it becomes nothing.
 *
 * There is no partial acceptance. A record missing a donor, a date or a
 * positive amount cannot be described to a reader without inventing the missing
 * part, so it is counted as rejected and dropped. The count is reported rather
 * than swallowed — "the FEC returned 25 records and we kept 24" is a fact an
 * operator is entitled to see.
 */
export function normalizeContribution(
  record: OpenFecContributionRecord,
  context: NormalizeContext & { fallbackRecipient: string },
): ContributionRow | null {
  const donorName = trimmed(record.contributor_name);
  const recipientName =
    trimmed(record.candidate_name) ??
    trimmed(record.committee_name) ??
    trimmed(context.fallbackRecipient);
  const amount = Number(record.contribution_receipt_amount ?? 0);
  const date = isoDate(record.contribution_receipt_date);

  if (!donorName || !recipientName || !date || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return {
    source_system: OPENFEC_SOURCE_SYSTEM,
    jurisdiction_id: context.jurisdictionId,
    recipient_name: recipientName,
    committee_name: trimmed(record.committee_name),
    donor_name: donorName,
    donor_employer: null,
    donor_occupation: null,
    donor_city: trimmed(record.contributor_city),
    donor_state: trimmed(record.contributor_state),
    amount: round2(amount),
    contribution_date: date,
    cycle: record.two_year_transaction_period ?? context.cycle,
    external_id: identifier(record.sub_id),
    image_number: trimmed(record.image_number),
    source_url: context.sourceUrl,
    retrieved_at: context.retrievedAt,
    raw: JSON.stringify(record),
  };
}

export function normalizeExpenditure(
  record: OpenFecExpenditureRecord,
  context: NormalizeContext,
): ExpenditureRow | null {
  const recipientName = trimmed(record.recipient_name);
  const amount = Number(record.disbursement_amount ?? 0);
  const date = isoDate(record.disbursement_date);

  if (!recipientName || !date || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return {
    source_system: OPENFEC_SOURCE_SYSTEM,
    jurisdiction_id: context.jurisdictionId,
    committee_name: trimmed(record.committee_name),
    recipient_name: recipientName,
    purpose: trimmed(record.disbursement_description),
    amount: round2(amount),
    disbursement_date: date,
    cycle: record.two_year_transaction_period ?? context.cycle,
    external_id: identifier(record.sub_id),
    image_number: trimmed(record.image_number),
    source_url: context.sourceUrl,
    retrieved_at: context.retrievedAt,
    raw: JSON.stringify(record),
  };
}

/**
 * Insert unless the filing is already held.
 *
 * Two identity rules, and the second one exists because the first one is not
 * always available. A filing that carries `sub_id` is identified by it, full
 * stop. A filing that carries none falls back to the tuple a human would use —
 * same system, same recipient, same donor, same amount, same day — which can in
 * principle collide with a genuinely distinct second gift on the same day. That
 * is the safer error: an under-count of a donor's total is a smaller
 * misstatement than a double-count, and it is the one that cannot inflate a
 * figure printed beside somebody's name.
 */
async function insertContributionIfNew(db: Knex, row: ContributionRow): Promise<boolean> {
  const existing = row.external_id
    ? await db("campaign_contributions")
        .where({ source_system: row.source_system, external_id: row.external_id })
        .first("id")
    : await db("campaign_contributions")
        .where({
          source_system: row.source_system,
          recipient_name: row.recipient_name,
          donor_name: row.donor_name,
          amount: row.amount,
          contribution_date: row.contribution_date,
        })
        .first("id");

  if (existing) return false;
  await db("campaign_contributions").insert(row);
  return true;
}

async function insertExpenditureIfNew(db: Knex, row: ExpenditureRow): Promise<boolean> {
  const existing = row.external_id
    ? await db("campaign_expenditures")
        .where({ source_system: row.source_system, external_id: row.external_id })
        .first("id")
    : await db("campaign_expenditures")
        .where({
          source_system: row.source_system,
          recipient_name: row.recipient_name,
          committee_name: row.committee_name,
          amount: row.amount,
          disbursement_date: row.disbursement_date,
        })
        .first("id");

  if (existing) return false;
  await db("campaign_expenditures").insert(row);
  return true;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function identifier(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function isoDate(value: string | null | undefined): string | null {
  const match = value?.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

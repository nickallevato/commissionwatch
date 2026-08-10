import type { Knex } from "knex";
import {
  CONTRIBUTION_SCHEDULES,
  RECORD_KIND_CANDIDATE_ROSTER,
  RECORD_KIND_REPORT_INDEX,
  RECORD_KIND_REPORT_SCHEDULE,
  expectJson,
  parseEnvelope,
  parseLineItems,
  toCandidate,
  toReport,
  type CersCandidate,
  type CersLineItem,
  type CersReport,
} from "./adapters/mt-cers";

/**
 * Persists a stored CERS artifact into the campaign-finance tables.
 *
 * This runs in the `parse` stage, which means it never touches the network: it
 * receives bytes the fetch stage already captured and recorded, and it writes
 * rows that cite the artifact those bytes are stored under. Schema of record:
 * `backend/migrations/041_create_campaign_finance.ts`.
 *
 * Everything here is idempotent, and the idempotency is a database constraint
 * rather than a check-then-insert: `cf_filers` on `(source, type, cers id)`,
 * `cf_reports` on `(filer, cers report id)`, `cf_transactions` on
 * `(artifact, row index)`. Re-parsing an artifact rewrites exactly its own rows
 * and nothing else, so the Pressroom's "re-parse without re-fetching" action is
 * safe on this path for the same reason it is safe on the agenda path.
 */

export type CampaignFinanceRecordKind =
  | typeof RECORD_KIND_CANDIDATE_ROSTER
  | typeof RECORD_KIND_REPORT_INDEX
  | typeof RECORD_KIND_REPORT_SCHEDULE;

const RECORD_KINDS: readonly string[] = Object.freeze([
  RECORD_KIND_CANDIDATE_ROSTER,
  RECORD_KIND_REPORT_INDEX,
  RECORD_KIND_REPORT_SCHEDULE,
]);

/** True when this parse target names a CERS record rather than a document. */
export function isCampaignFinanceKind(value: unknown): value is CampaignFinanceRecordKind {
  return typeof value === "string" && RECORD_KINDS.includes(value);
}

const CONTRIBUTION_SET: ReadonlySet<string> = new Set(CONTRIBUTION_SCHEDULES);

/**
 * Which side of the ledger a schedule is.
 *
 * Decided by the schedule that was *requested*, never by the row. CERS returns
 * contributions and expenditures through one endpoint with one row shape, and a
 * row's own `lineItemCompositeDescr` is display text from an open set — reading
 * direction out of it would make a label change upstream silently reclassify
 * money.
 */
export function directionForSchedule(schedule: string): "contribution" | "expenditure" {
  return CONTRIBUTION_SET.has(schedule) ? "contribution" : "expenditure";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireId(row: unknown, table: string): string {
  if (!isRecord(row) || typeof row.id !== "string" || row.id === "") {
    throw new Error(`${table}: insert or lookup returned no id`);
  }
  return row.id;
}

function metadataString(metadata: unknown, field: string): string | null {
  if (!isRecord(metadata)) return null;
  const value = metadata[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function requireMetadata(metadata: unknown, field: string): string {
  const value = metadataString(metadata, field);
  if (value === null) {
    throw new TypeError(`campaign finance: parse target metadata is missing '${field}'`);
  }
  return value;
}

/**
 * Splits `'109 Sunset Blvd., Bozeman, MT 59715'` into its city.
 *
 * Returns null rather than a guess whenever the shape is not the expected
 * `..., City, ST ZIP`. This is the only place a jurisdiction is ever inferred,
 * and what it produces lands in `derived_jurisdiction`, which is a separate
 * column from the address it was read out of precisely so the inference cannot
 * be mistaken for the filing.
 */
export function cityFromAddress(address: string | null): string | null {
  if (address === null) return null;
  const parts = address.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1] ?? "";
  // The last part must look like `MT 59715` — a state and a ZIP — or we are not
  // reading the shape we think we are reading.
  if (!/^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/.test(tail)) return null;
  const city = parts[parts.length - 2] ?? "";
  return city === "" ? null : city;
}

/**
 * `MM/DD/YYYY` as CERS renders it, to `YYYY-MM-DD`. Null on anything else.
 *
 * Deliberately strict. A date this cannot read is stored as NULL, because a
 * campaign-finance record with a plausible wrong date is worse than one with an
 * absent date — the first is publishable and false.
 */
export function toIsoDate(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (match === null) return null;
  const [, month, day, year] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects 02/30/2024, which Date rolls forward silently.
  return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * A CERS epoch-milliseconds field to `YYYY-MM-DD`.
 *
 * CERS stamps `datePaid` at local midnight in Mountain time, so the instant is
 * the previous day in UTC and reading it with `toISOString()` would move every
 * contribution one day earlier. The zone is applied rather than assumed away.
 */
export function toIsoDateFromEpoch(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : null;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export interface CampaignFinanceContext {
  db: Knex;
  sourceId: string;
  artifactId: string;
  /** `ingestion_jobs.target.metadata`, carried from the adapter's DocumentRef. */
  metadata: unknown;
}

/** Inserts or refreshes one candidacy. Idempotent on `(source, type, cers id)`. */
export async function upsertCandidateFiler(
  db: Knex,
  sourceId: string,
  candidate: CersCandidate,
): Promise<string> {
  const values = {
    source_id: sourceId,
    filer_type: "candidate",
    cers_filer_id: candidate.candidateId,
    cers_ent_id: candidate.entId,
    name: candidate.candidateName.slice(0, 300),
    office_title: candidate.officeTitle,
    campaign_type_code: candidate.candidateTypeCode,
    election_year: candidate.electionYear,
    party: candidate.partyDescr,
    residence_city: cityFromAddress(candidate.candidateAddress),
    residence_county: candidate.resCountyDescr,
    // Left NULL here on purpose. A roster row states a residence, not a
    // jurisdiction of office, and this writer does not conclude anything from
    // it. Populating it is a separate, evidenced decision.
    derived_jurisdiction: null,
    updated_at: db.fn.now(),
  };
  const rows: unknown = await db("cf_filers")
    .insert({ ...values, created_at: db.fn.now() })
    .onConflict(["source_id", "filer_type", "cers_filer_id"])
    .merge(values)
    .returning("id");
  return requireId(Array.isArray(rows) ? rows[0] : undefined, "cf_filers");
}

/** Inserts or refreshes one filed report. Idempotent on `(filer, cers id)`. */
export async function upsertReport(
  db: Knex,
  filerId: string,
  report: CersReport,
): Promise<string> {
  const values = {
    filer_id: filerId,
    cers_report_id: report.reportId,
    form_type: report.formTypeCode,
    report_type: report.reportTypeDescr,
    filing_type: report.filingTypeDescr,
    status: report.statusDescr,
    period_start: toIsoDate(report.fromDateStr),
    period_end: toIsoDate(report.toDateStr),
    updated_at: db.fn.now(),
  };
  const rows: unknown = await db("cf_reports")
    .insert({ ...values, created_at: db.fn.now() })
    .onConflict(["filer_id", "cers_report_id"])
    .merge(values)
    .returning("id");
  return requireId(Array.isArray(rows) ? rows[0] : undefined, "cf_reports");
}

/**
 * Finds the filer a chain's `candidateId` refers to.
 *
 * Returns null rather than creating one. A schedule artifact carries the
 * candidate's name in its metadata, and inventing a filer row from that would
 * make a filer whose existence rests on a job target instead of on a roster
 * CERS served. The correct outcome for a schedule whose roster has not been
 * parsed is a counted, reported gap.
 */
export async function findFilerByCersId(
  db: Knex,
  sourceId: string,
  cersFilerId: string,
): Promise<string | null> {
  const row: unknown = await db("cf_filers")
    .where({ source_id: sourceId, filer_type: "candidate", cers_filer_id: cersFilerId })
    .first("id");
  return isRecord(row) ? requireId(row, "cf_filers") : null;
}

/**
 * Replaces this artifact's transaction rows.
 *
 * Scoped to the artifact, so a re-parse rewrites what these bytes say and
 * touches nothing another document contributed. A schedule that has become
 * empty deletes its old rows and writes none, which is the correct reading of
 * "these bytes now contain no line items".
 */
export async function replaceTransactions(
  db: Knex,
  reportId: string,
  artifactId: string,
  schedule: string,
  items: readonly CersLineItem[],
): Promise<number> {
  const direction = directionForSchedule(schedule);
  return db.transaction(async (trx) => {
    await trx("cf_transactions").where({ artifact_id: artifactId }).del();
    if (items.length === 0) return 0;
    await trx("cf_transactions").insert(
      items.map((item, index) => ({
        report_id: reportId,
        artifact_id: artifactId,
        direction,
        schedule,
        row_index: index,
        entity_name: item.entityName === null ? null : item.entityName.slice(0, 300),
        entity_address: item.entityAddress,
        occupation: item.occupationDescr === null ? null : item.occupationDescr.slice(0, 200),
        employer: item.employerDescr === null ? null : item.employerDescr.slice(0, 300),
        election_type: item.amountTypeDescr,
        transaction_date: toIsoDateFromEpoch(item.datePaid),
        cash_amount: item.cashAmt,
        in_kind_amount: item.inKindAmt,
        total_amount: item.totalAmt,
        purpose: item.purposeDescr ?? item.descriptionDescr,
        line_item_label: item.lineItemCompositeDescr,
        created_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      })),
    );
    return items.length;
  });
}

/**
 * Reads one stored CERS artifact into the campaign-finance tables.
 *
 * Returns the tallies the run row records. A gap — a schedule whose roster has
 * not been parsed — is counted and named, never repaired by guessing, because
 * "Failures are disclosed, not swallowed" and a fabricated filer is a worse
 * outcome than a visible hole.
 */
export async function recordCampaignFinance(
  context: CampaignFinanceContext,
  content: Uint8Array,
): Promise<Record<string, number>> {
  const { db, sourceId, artifactId, metadata } = context;
  const kind = requireMetadata(metadata, "recordKind");
  const url = metadataString(metadata, "sourceUrl") ?? kind;
  const payload = expectJson(content, url);

  if (kind === RECORD_KIND_CANDIDATE_ROSTER) {
    const envelope = parseEnvelope(payload, url, toCandidate);
    for (const candidate of envelope.aaData) {
      await upsertCandidateFiler(db, sourceId, candidate);
    }
    return { cf_filers_written: envelope.aaData.length };
  }

  if (kind === RECORD_KIND_REPORT_INDEX) {
    const candidateId = requireMetadata(metadata, "candidateId");
    const filerId = await findFilerByCersId(db, sourceId, candidateId);
    if (filerId === null) {
      return { cf_reports_unattributed: 1 };
    }
    const envelope = parseEnvelope(payload, url, toReport);
    for (const report of envelope.aaData) {
      await upsertReport(db, filerId, report);
    }
    return { cf_reports_written: envelope.aaData.length };
  }

  const candidateId = requireMetadata(metadata, "candidateId");
  const reportId = requireMetadata(metadata, "reportId");
  const schedule = requireMetadata(metadata, "schedule");
  const filerId = await findFilerByCersId(db, sourceId, candidateId);
  if (filerId === null) {
    return { cf_transactions_unattributed: 1 };
  }
  const reportRow: unknown = await db("cf_reports")
    .where({ filer_id: filerId, cers_report_id: reportId })
    .first("id");
  if (!isRecord(reportRow)) {
    return { cf_transactions_unattributed: 1 };
  }

  const items = parseLineItems(payload, url);
  const written = await replaceTransactions(
    db,
    requireId(reportRow, "cf_reports"),
    artifactId,
    schedule,
    items,
  );
  return directionForSchedule(schedule) === "contribution"
    ? { cf_contributions_written: written }
    : { cf_expenditures_written: written };
}

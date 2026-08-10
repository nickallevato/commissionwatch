import type { Knex } from "knex";
import { findGap, type GapScope, type RecordGap } from "./gaps";
import {
  isoDate,
  lawWarnings,
  renderLetter,
  daysBetween,
  VERIFICATION_MAX_AGE_DAYS,
  type JurisdictionRecordsLaw,
  type Requester,
} from "./letter";
import { RecordsError, type RecordsRequestRow } from "./requests";

/**
 * P7 — the public-records request generator.
 *
 * It **drafts. It never sends.** There is no email path, no dispatcher call and
 * no queue write anywhere in this module or in the two it imports, and
 * `records-generator.test.ts` asserts that twice over: once by reading these
 * files and checking they import nothing from the delivery layer, and once by
 * counting `deliveries` and `notifications` either side of a generation.
 *
 * Transmitting legal correspondence on somebody's behalf is not a feature this
 * application is going to grow by accident. The operator copies the text into
 * their own mail client and sends it under their own name, which is also the
 * only arrangement under which the letter is honestly *theirs*.
 *
 * ## The refusal
 *
 * With no `jurisdiction_records_law` row for the jurisdiction, this throws
 * {@link RecordsLawMissingError} and produces nothing. It does not fall back to
 * a generic Montana citation, a national template, or the deadlines quoted in
 * migration 036's comment — those are stated for executive-branch agencies, and
 * every jurisdiction this project watches is a local government. A confidently
 * wrong statute in a letter somebody sends is a real harm. No letter is the
 * correct output, and the refusal names exactly which columns a person has to
 * fill in.
 */

export class RecordsLawMissingError extends RecordsError {
  readonly jurisdictionId: string;
  readonly jurisdictionName: string;
  /** The columns that must be supplied. Named so the message can be acted on. */
  readonly missing: readonly string[];

  constructor(jurisdictionId: string, jurisdictionName: string) {
    const missing = ["statute_citation", "statute_url", "verified_on"] as const;
    super(
      `No public-records law is on file for ${jurisdictionName}, so no letter was drafted. ` +
        `The table jurisdiction_records_law has no row for jurisdiction_id ${jurisdictionId}. ` +
        `Required before a request can cite anything: ${missing.join(", ")}. ` +
        `Supplying them means a person reading the subsection of the Montana Code Annotated ` +
        `that governs local governments — the deadlines published for executive branch ` +
        `agencies do not apply to a city or a county — and recording the date they read it. ` +
        `No fallback citation is used, because a confidently wrong statute is worse than no letter.`,
      409,
    );
    this.name = "RecordsLawMissingError";
    this.jurisdictionId = jurisdictionId;
    this.jurisdictionName = jurisdictionName;
    this.missing = missing;
  }
}

/** `YYYY-MM-DD` is read out of Postgres as text: a `date` column otherwise
 * arrives as a `Date` at local midnight, which is a different calendar day
 * either side of the zone. The letter prints these verbatim. */
const LAW_COLUMNS = [
  "statute_citation",
  "statute_url",
  "acknowledge_days",
  "respond_days",
  "custodian_name",
  "custodian_email",
  "custodian_address",
  "verified_by",
  "notes",
] as const;

/**
 * `jurisdiction_id` is deliberately **not** in this list.
 *
 * `listJurisdictionLaw` left-joins these columns onto `jurisdictions`, and a
 * second output column also called `jurisdiction_id` would shadow the
 * jurisdiction's own — leaving every row without a law entry looking like a
 * jurisdiction with a null id. The caller already knows which jurisdiction it
 * asked about, so the column is supplied from there.
 */
function lawSelect(db: Knex, alias = "law") {
  return [
    ...LAW_COLUMNS.map((column) => `${alias}.${column}`),
    db.raw(`to_char(${alias}.verified_on, 'YYYY-MM-DD') as verified_on`),
  ];
}

export async function findRecordsLaw(
  db: Knex,
  jurisdictionId: string,
): Promise<JurisdictionRecordsLaw | null> {
  const row = await db("jurisdiction_records_law as law")
    .where("law.jurisdiction_id", jurisdictionId)
    .first<Omit<JurisdictionRecordsLaw, "jurisdiction_id"> | undefined>(lawSelect(db));
  return row ? { ...row, jurisdiction_id: jurisdictionId } : null;
}

export interface JurisdictionLawStatus {
  jurisdiction_id: string;
  jurisdiction_name: string;
  law: JurisdictionRecordsLaw | null;
  /** Days since `verified_on`, or null when there is no row to have verified. */
  verification_age_days: number | null;
  stale: boolean;
  /** What an operator has to do about this jurisdiction, in one sentence. */
  advisory: string;
}

/**
 * Every jurisdiction and the state of its records law — the console's warning
 * surface. A jurisdiction with no row is listed, loudly, rather than omitted:
 * the missing row is the thing an operator most needs to see.
 */
export async function listJurisdictionLaw(
  db: Knex,
  today = isoDate(new Date()),
): Promise<JurisdictionLawStatus[]> {
  const rows = await db("jurisdictions as j")
    .leftJoin("jurisdiction_records_law as law", "law.jurisdiction_id", "j.id")
    .orderBy("j.name", "asc")
    .select<Array<Record<string, unknown>>>([
      "j.id as jurisdiction_id",
      "j.name as jurisdiction_name",
      ...lawSelect(db),
    ]);

  return rows.map((row) => {
    const jurisdictionId = String(row.jurisdiction_id);
    const jurisdictionName = String(row.jurisdiction_name);
    // The left join produces a row either way; `statute_citation` is NOT NULL in
    // the table, so its nullity here is exactly "no law row exists".
    const hasLaw = row.statute_citation !== null && row.statute_citation !== undefined;

    if (!hasLaw) {
      return {
        jurisdiction_id: jurisdictionId,
        jurisdiction_name: jurisdictionName,
        law: null,
        verification_age_days: null,
        stale: false,
        advisory:
          "No row in jurisdiction_records_law. No request can be drafted for this " +
          "jurisdiction until a person reads the applicable subsection of the Montana " +
          "Code Annotated for local governments and records the citation, its URL and " +
          "the date it was read.",
      };
    }

    const law: JurisdictionRecordsLaw = {
      jurisdiction_id: jurisdictionId,
      statute_citation: String(row.statute_citation),
      statute_url: String(row.statute_url),
      acknowledge_days: row.acknowledge_days === null ? null : Number(row.acknowledge_days),
      respond_days: row.respond_days === null ? null : Number(row.respond_days),
      custodian_name: row.custodian_name === null ? null : String(row.custodian_name),
      custodian_email: row.custodian_email === null ? null : String(row.custodian_email),
      custodian_address: row.custodian_address === null ? null : String(row.custodian_address),
      verified_on: String(row.verified_on),
      verified_by: row.verified_by === null ? null : String(row.verified_by),
      notes: row.notes === null ? null : String(row.notes),
    };

    const age = daysBetween(law.verified_on, today);
    const stale = age !== null && age > VERIFICATION_MAX_AGE_DAYS;

    return {
      jurisdiction_id: jurisdictionId,
      jurisdiction_name: jurisdictionName,
      law,
      verification_age_days: age,
      stale,
      advisory: stale
        ? `Last verified ${law.verified_on}, ${age} days ago. Montana's public information ` +
          `sections are marked Temporary and carry termination dates — re-read ` +
          `${law.statute_url} and update verified_on.`
        : `Verified ${law.verified_on}.`,
    };
  });
}

// ---- requester input --------------------------------------------------------

/** A conservative shape check. Deliverability is not ours to assert. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Validate the requester block.
 *
 * Name and email are required because the letter is signed and a reply has to
 * reach somebody. Everything else is optional and simply omitted when absent —
 * a letter with an empty address line reads as a form, and a form reads as
 * something a machine sent.
 */
export function normaliseRequester(input: unknown): Requester {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  const name = optionalText(body.name);
  if (name === null) throw new RecordsError("A requester name is required", 400);

  const email = optionalText(body.email);
  if (email === null) throw new RecordsError("A requester email address is required", 400);
  if (!EMAIL_RE.test(email)) {
    throw new RecordsError(`"${email}" is not a usable email address`, 400);
  }

  return {
    name,
    email,
    organization: optionalText(body.organization),
    address: optionalText(body.address),
    phone: optionalText(body.phone),
  };
}

// ---- generation -------------------------------------------------------------

export interface GenerateInput {
  scope: GapScope;
  gapId: string;
  requester: Requester;
  /** `YYYY-MM-DD`. Injectable so the rendered text is deterministic in tests. */
  today?: string;
}

export interface GeneratedRequest {
  gap: RecordGap;
  law: JurisdictionRecordsLaw;
  letter: string;
  warnings: string[];
  /**
   * The persisted draft, or `null` on the public surface — which writes no row
   * at all. A reader producing their own letter is not a record this project
   * keeps.
   */
  request: RecordsRequestRow | null;
}

async function draftFor(
  db: Knex,
  input: GenerateInput,
): Promise<Omit<GeneratedRequest, "request">> {
  const today = input.today ?? isoDate(new Date());

  const gap = await findGap(db, input.scope, input.gapId);
  if (!gap) {
    // One message for "no such gap", "not in this scope" and "already filled".
    // Distinguishing them on the public surface would let a caller probe which
    // meetings exist but are unpublished, which is the state the wall protects.
    throw new RecordsError("No such gap in the record", 404);
  }

  const law = await findRecordsLaw(db, gap.jurisdiction_id);
  if (!law) throw new RecordsLawMissingError(gap.jurisdiction_id, gap.jurisdiction_name);

  return {
    gap,
    law,
    letter: renderLetter({ gap, law, requester: input.requester, today }),
    warnings: lawWarnings(law, today),
  };
}

/**
 * The public surface: letter text, and nothing persisted.
 *
 * Identical text to {@link generateOperatorRequest} for the same gap, requester
 * and date — asserted by string equality, because "the same generator" is a
 * claim that decays the moment the two have separate code paths.
 */
export async function generatePublicLetter(
  db: Knex,
  input: Omit<GenerateInput, "scope">,
): Promise<GeneratedRequest> {
  const drafted = await draftFor(db, { ...input, scope: "public" });
  return { ...drafted, request: null };
}

/**
 * The operator surface: the same letter, plus a `records_requests` row in
 * `draft`.
 *
 * `response_due_at` is set **only** when the jurisdiction's law records a
 * response period. This is the spec's correction to mockup screen 06, whose
 * "statutory guide" figure was invented: an unknown deadline renders as no
 * deadline, never as a plausible number.
 *
 * The letter is stored in `notes`, because a draft whose text lives only in a
 * browser tab is not a draft, it is a preview.
 */
export async function generateOperatorRequest(
  db: Knex,
  input: Omit<GenerateInput, "scope">,
): Promise<GeneratedRequest> {
  const drafted = await draftFor(db, { ...input, scope: "operator" });
  const today = input.today ?? isoDate(new Date());

  let responseDueAt: Date | null = null;
  if (drafted.law.respond_days !== null) {
    const parsed = Date.parse(`${today}T00:00:00Z`);
    if (!Number.isNaN(parsed)) {
      responseDueAt = new Date(parsed + drafted.law.respond_days * 86_400_000);
    }
  }

  const [request] = await db("records_requests")
    .insert({
      jurisdiction_id: drafted.gap.jurisdiction_id,
      subject: `Public records request — ${drafted.gap.requested_record}`,
      // Draft, always. Nothing in this codebase moves a request past this state
      // without a person doing it.
      status: "draft",
      submitted_at: null,
      response_due_at: responseDueAt,
      notes: drafted.letter,
    })
    .returning<RecordsRequestRow[]>("*");

  return { ...drafted, request };
}

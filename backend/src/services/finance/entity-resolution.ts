import type { Knex } from "knex";
import { appendCorrectionRow } from "../pressroom/corrections";
import type { VoteDonorEvidence } from "./evidence";
import { splitTerms } from "./name-match";

/**
 * Remembering what an operator decided about two names.
 *
 * ## Why this exists
 *
 * `name-match.ts` is honest that it cannot resolve identity, and
 * `correlation.ts` is honest that a `vote_donor_conflict` is a name overlap
 * rather than a fact about who anybody is. Between them they leave one question
 * open that only a person can close: *is the donor filed as this the same entity
 * as the thing the agenda item names?*
 *
 * Before this module an operator answered that question in their head, acted on
 * it, and the answer went nowhere. The next sweep raised the same pair, and two
 * operators — or the same operator on two days — could answer it differently
 * with nothing recording that it had been asked before.
 *
 * ## The pair, and why it is not the finding
 *
 * See migration 070. Neither the finding id nor the agenda item id is stable
 * across sweeps, so keying on either would mean the judgement expired exactly
 * when it became useful. The key is instead:
 *
 *  - `donor_terms` — the donor's **distinctive** terms, through the same
 *    `splitTerms` the matcher uses, sorted;
 *  - `subject_terms` — the distinctive terms that were found in the agenda item,
 *    sorted.
 *
 * Both halves are sorted because `matchedTerms` follows the order of the filed
 * name, and the same pair reached through a differently-worded agenda item must
 * produce the same key.
 *
 * **The donor half is distinctive terms, not the normalised name, and that is
 * load-bearing rather than tidy.** The first draft of this module keyed on
 * `normalizeName(donorName)`, and it was wrong twice over. "Ridgeline Aggregate
 * LLC" and "RIDGELINE AGGREGATE, L.L.C." are one company filed by two clerks and
 * produced two keys, so a judgement had to be made twice. Worse, "Ridgeline
 * Aggregate LLC" and "Ridgeline Aggregate Union" also produced two keys — which
 * means the stored judgement would have depended on what class of organisation
 * the donor is, on a code path whose governing invariant is that detection
 * applies identically to every entity class. `name-match.ts` makes that hold by
 * discarding the class word before any decision is taken; this module holds it
 * the same way, by calling the same function. The test that swaps `LLC` for
 * `Union`, `PAC`, `Foundation` and `Association` and requires one key passes
 * because there is no branch it could fail on.
 *
 * ## What each decision does
 *
 * `different_entity` suppresses the finding on subsequent sweeps.
 * `same_entity` does not publish anything — it annotates the finding, which is
 * still held and still needs an explicit approval. `correlation.ts` is where
 * both are applied, and it applies them without looking at what kind of entity
 * either side is, because there is nothing here that says.
 *
 * ## Changing your mind
 *
 * Permitted, and the whole reason the table is updatable rather than
 * append-only. The row holds the current answer; every write — first or fifth —
 * appends to `record_corrections`, so the sequence is recoverable from the one
 * audit log rather than from a second one that could disagree with it. The
 * correction's `old_value` is the previous decision or `null` on the first,
 * which is the same distinction migration 031 preserves everywhere else: "was
 * decided the other way" and "was never decided" are different facts.
 */

export class EntityResolutionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "EntityResolutionError";
  }
}

export const ENTITY_DECISIONS = ["same_entity", "different_entity"] as const;

export type EntityDecision = (typeof ENTITY_DECISIONS)[number];

export function isEntityDecision(value: unknown): value is EntityDecision {
  return typeof value === "string" && (ENTITY_DECISIONS as readonly string[]).includes(value);
}

/**
 * How each answer reads on an operator surface. Neither word is "confirmed" or
 * "verified": deciding that two names denote the same entity is a person's
 * judgement about a record, and saying so is not the same as proving it.
 */
export const ENTITY_DECISION_LABEL: Record<EntityDecision, string> = {
  same_entity: "Operator judged: same entity",
  different_entity: "Operator judged: different entities",
};

/** The pair an operator judges. Both halves are derived, never supplied. */
export interface EntityPair {
  /** The donor's distinctive terms, sorted. See the header. */
  donorTerms: string;
  /** The distinctive terms found in the agenda item, sorted. */
  subjectTerms: string;
  /** As filed, for the console. Never part of the key. */
  donorNameFiled: string;
}

/** The stored answer, as it travels to the console and into a finding. */
export interface StoredEntityDecision {
  decision: EntityDecision;
  donorNameFiled: string;
  subjectTerms: string;
  reason: string;
  operatorEmail: string | null;
  decidedAt: string;
}

/**
 * The pair for a finding, from its stored evidence.
 *
 * Pure, and exported, because it is the one place the key is constructed: a
 * second construction that sorted differently would silently create a parallel
 * set of decisions that never matched the first.
 */
export function pairForEvidence(evidence: VoteDonorEvidence): EntityPair | null {
  return pairFor(evidence.donorName, evidence.donorMatch.matchedTerms);
}

export function pairFor(
  donorNameFiled: string,
  matchedTerms: readonly string[],
): EntityPair | null {
  const donorTerms = sortedTerms(splitTerms(donorNameFiled).distinctive);
  const subjectTerms = sortedTerms(matchedTerms);
  if (donorTerms === "" || subjectTerms === "") return null;
  return { donorTerms, subjectTerms, donorNameFiled };
}

function sortedTerms(terms: readonly string[]): string {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))].sort().join(" ");
}

/** The map key. One function, so the writer and the reader cannot disagree. */
export function pairKey(pair: Pick<EntityPair, "donorTerms" | "subjectTerms">): string {
  // The separator has to be a character a term cannot contain. Both halves
  // are space-joined term lists, so joined with a space the pairs
  // `{"ridge line", "aggregate"}` and `{"ridge", "line aggregate"}` would
  // collide into one judgement answering two different questions.
  // `normalizeName` leaves only `[a-z0-9 ]`, so a colon cannot occur in
  // either half.
  return `${pair.donorTerms}:${pair.subjectTerms}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function toStoredDecision(row: Record<string, unknown>): StoredEntityDecision | null {
  const decision = row.decision;
  if (!isEntityDecision(decision)) return null;
  return {
    decision,
    donorNameFiled: textOrNull(row.donor_name_filed) ?? "",
    subjectTerms: textOrNull(row.subject_terms) ?? "",
    reason: textOrNull(row.reason) ?? "",
    operatorEmail: textOrNull(row.operator_email),
    decidedAt: asIso(row.updated_at ?? row.created_at),
  };
}

export interface EntityDecisionRow extends StoredEntityDecision {
  id: string;
  donorTerms: string;
}

/**
 * Every decision, keyed for `correlation.ts`.
 *
 * Loaded whole rather than queried per candidate pair. The table holds one row
 * per judgement an operator has actually made, which is bounded by how many
 * ambiguous pairs a human has looked at — a number in the dozens, not the
 * millions — and a sweep compares thousands of candidate pairs. One read beats
 * thousands.
 */
export async function loadEntityDecisions(
  db: Knex,
): Promise<Map<string, StoredEntityDecision>> {
  const rows: unknown = await db("entity_resolution_decisions").select("*");
  const map = new Map<string, StoredEntityDecision>();
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!isRecord(raw)) continue;
    const stored = toStoredDecision(raw);
    if (stored === null) continue;
    map.set(
      pairKey({
        donorTerms: textOrNull(raw.donor_terms) ?? "",
        subjectTerms: stored.subjectTerms,
      }),
      stored,
    );
  }
  return map;
}

export async function listEntityDecisions(db: Knex): Promise<EntityDecisionRow[]> {
  const rows: unknown = await db("entity_resolution_decisions")
    .orderBy("updated_at", "desc")
    .limit(500)
    .select("*");
  const out: EntityDecisionRow[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!isRecord(raw)) continue;
    const stored = toStoredDecision(raw);
    if (stored === null) continue;
    out.push({
      ...stored,
      id: textOrNull(raw.id) ?? "",
      donorTerms: textOrNull(raw.donor_terms) ?? "",
    });
  }
  return out;
}

export interface RecordEntityDecisionInput {
  pair: EntityPair;
  decision: EntityDecision;
  reason: string;
  actor: { id: string | null; email: string | null };
}

/**
 * Record — or revise — the judgement on one pair.
 *
 * The read of the previous answer, the write of the new one and the audit row
 * are one transaction, so there is no window in which the table says one thing
 * and the log says it always did.
 *
 * The reason goes through `appendCorrectionRow`, which scans it for motive. That
 * is not incidental here: "these are the same company" describes the record and
 * is the kind of sentence this feature wants, while "the donor was buying the
 * vote" is a claim about intent that this project does not make anywhere, and
 * least of all in an audit log it publishes.
 */
export async function recordEntityDecision(
  db: Knex,
  input: RecordEntityDecisionInput,
): Promise<StoredEntityDecision> {
  if (input.reason.trim() === "") {
    throw new EntityResolutionError(
      "reason is required: an entity-resolution judgement without one cannot be reviewed",
      400,
    );
  }
  if (!isEntityDecision(input.decision)) {
    throw new EntityResolutionError(
      `decision must be one of ${ENTITY_DECISIONS.join(", ")}`,
      400,
    );
  }

  const { pair } = input;

  return db.transaction(async (trx) => {
    const existing: unknown = await trx("entity_resolution_decisions")
      .where({
        donor_terms: pair.donorTerms,
        subject_terms: pair.subjectTerms,
      })
      .forUpdate()
      .first();

    const previous = isRecord(existing) ? toStoredDecision(existing) : null;

    // The pair's own row is the audit target, so its id has to exist before the
    // log row names it. On a first judgement there is no row yet, so the id is
    // generated here and used for **both** the log and the insert — a log entry
    // whose `target_id` matched no row would be unfollowable, and the first
    // entry for every pair is exactly the one a reader would want to follow.
    const rowId = isRecord(existing) ? (textOrNull(existing.id) ?? "") : await newId(trx);

    // `old_value` is `null` on a first judgement and the previous answer on a
    // revision. "Was decided the other way" and "was never decided" are
    // different facts, and the log keeps them apart.
    await appendCorrectionRow(trx, {
      targetTable: "entity_resolution_decisions",
      targetId: rowId,
      field: "decision",
      oldValue: previous?.decision ?? null,
      newValue: input.decision,
      reason: input.reason,
      actor: input.actor,
    });

    if (isRecord(existing)) {
      await trx("entity_resolution_decisions")
        .where({ id: rowId })
        .update({
          decision: input.decision,
          donor_name_filed: pair.donorNameFiled,
          reason: input.reason,
          operator_id: input.actor.id,
          operator_email: input.actor.email,
          updated_at: trx.fn.now(),
        });
    } else {
      await trx("entity_resolution_decisions").insert({
        id: rowId,
        donor_terms: pair.donorTerms,
        subject_terms: pair.subjectTerms,
        donor_name_filed: pair.donorNameFiled,
        decision: input.decision,
        reason: input.reason,
        operator_id: input.actor.id,
        operator_email: input.actor.email,
      });
    }

    const written: unknown = await trx("entity_resolution_decisions")
      .where({
        donor_terms: pair.donorTerms,
        subject_terms: pair.subjectTerms,
      })
      .first();
    const stored = isRecord(written) ? toStoredDecision(written) : null;
    if (stored === null) {
      throw new EntityResolutionError("The judgement could not be stored", 500);
    }
    return stored;
  });
}

/**
 * A uuid from the database rather than from the application.
 *
 * The log row for a first judgement has to name a target that does not exist
 * yet, and pointing it at the all-zero uuid — or at nothing — would make the
 * audit trail's first entry for every pair unfollowable. Generating here rather
 * than inserting first keeps the log write ahead of the state write, which is
 * the order every other audited path in this project uses.
 */
async function newId(trx: Knex.Transaction): Promise<string> {
  const row: unknown = await trx.raw("SELECT gen_random_uuid() AS id");
  const rows = isRecord(row) ? row.rows : null;
  const first = Array.isArray(rows) ? rows[0] : null;
  const id = isRecord(first) ? textOrNull(first.id) : null;
  if (id === null) throw new EntityResolutionError("Could not generate an id", 500);
  return id;
}

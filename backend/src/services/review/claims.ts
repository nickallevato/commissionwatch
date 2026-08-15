import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { emitEvent, retractSubject, subjectIsPublic } from "../events";
import { appendCorrectionRow } from "../pressroom/corrections";
import { whereClaimPublic } from "../publication";
import { CLAIM_ACTIONS, locateQuote, type ClaimAction } from "../extraction/verify";
import { governorBacklog, toClaimVerdict, type ClaimVerdict } from "../governor/store";
import { motiveTerms } from "./language";
import { loadPolicy } from "./policy";
import { ReviewError, type ReviewActor } from "./queue";

/**
 * The claims review path — the thing that makes `minute_claims` publishable.
 *
 * Migration 072 shipped a table with a `status`, a `reviewed_by` and a
 * `reviewed_at` that **nothing wrote**. Every extracted claim sat `held`
 * forever, so the LLM extraction pipeline produced nothing a reader could ever
 * see. This module is the missing half, and migration 087 is its schema.
 *
 * Five things it does, and each of them is a rule from
 * `docs/superpowers/specs/2026-08-14-published-claim-design.md`:
 *
 *  1. **No generated prose reaches a reader.** The published sentence is a
 *     template fill over `ACTION_LABEL`, a frozen map of eight strings in this
 *     file, changed only by a commit. A model's words are input to a review,
 *     never output to a reader, and there is no channel here through which they
 *     could become the headline.
 *  2. **The operator approves exact bytes, and the bytes are pinned.** Approval
 *     stores the rendered string, its sha256 and the render version. The public
 *     path recomputes and compares; on mismatch the claim does not render and
 *     does not fall back to the stored text. See `renderApprovedClaim`.
 *  3. **No citation, no approval.** 072's NOT NULL on `quote_offset` means an
 *     uncited claim cannot exist, and the check below stays anyway — the review
 *     path must not depend on another table's constraint to be safe. It also
 *     asks the stronger question the constraint cannot: are the bytes we cite
 *     actually stored, so a reader can check them.
 *  4. **Describe the record, never the motive.** The *assembled sentence* runs
 *     through `motiveTerms` before approval can succeed. Not the quote: a quote
 *     is the record as printed and the project does not get to redact the
 *     minutes. The sentence is ours.
 *  5. **Every decision appends to `record_corrections`**, in the same
 *     transaction as the write it describes, and approval emits `claim.approved`
 *     in that transaction too. Two logs can disagree about what happened, and an
 *     event committed while its approval rolled back announces a sentence no
 *     reader can see.
 *
 * **There is no bulk approve, and there must not be one.** A screen that
 * approves forty claims in one click publishes forty unread sentences about
 * named people. If throughput ever becomes the binding constraint, the answer
 * is a better single-claim screen.
 *
 * ## Why this is not `approval_requests`
 *
 * The spec says claims join B-a's queue "as a second target kind", and reads
 * `approval_requests` (migration 038) as already generalising over a target. It
 * does not: `anomaly_flag_id` is NOT NULL with a foreign key to `anomaly_flags`
 * and a unique index, so a claim cannot be represented in that table without a
 * schema change that every existing queue query would have to be rewritten
 * around. What the spec is actually asking for is that claims reuse the *rules*
 * rather than invent a second approval concept, and they do — the same audit
 * log, the same motive guard, the same "no citation, no approval" refusal, the
 * same derived-never-written overdue from the same `review_policy` window, and
 * the same rule that a decision without a stated reason is not a decision. The
 * queue state itself lives on `minute_claims.status`, which 072 already
 * provided and defaults correctly to `held`, exactly as the findings queue
 * derives its contents from `anomaly_flags.review_state` rather than from
 * anyone having remembered to enqueue.
 */

/**
 * Template plus label map. Bump this and every claim pinned to the old version
 * goes back to the queue rather than silently re-rendering.
 */
export const RENDER_VERSION = "claim-render@1";

/**
 * The eight strings a reader may see, and the only ones.
 *
 * Frozen, exhaustive over `CLAIM_ACTIONS`, and asserted by a test that iterates
 * that constant — so adding a ninth action to migration 072 fails the suite
 * until someone gives it words. That failure is the feature: an unlabelled
 * action would otherwise reach a reader as a raw column value or as whatever a
 * fallback invented.
 *
 * Third person and past tense throughout, because the sentence is about what
 * the minutes record a named person as having done. "recused themselves" rather
 * than "recused" so the line reads as English on its own; "was absent" rather
 * than "absent" for the same reason.
 */
export const ACTION_LABEL: Readonly<Record<ClaimAction, string>> = Object.freeze({
  voted_yes: "voted yes",
  voted_no: "voted no",
  abstained: "abstained",
  absent: "was absent",
  moved: "moved",
  seconded: "seconded",
  spoke: "spoke",
  recused: "recused themselves",
});

export function isClaimAction(value: unknown): value is ClaimAction {
  return typeof value === "string" && (CLAIM_ACTIONS as readonly string[]).includes(value);
}

/** The three fields the sentence is assembled from. Nothing else is used. */
export interface RenderableClaim {
  subject_name: string;
  action: ClaimAction;
  matter: string | null;
}

/**
 * The published sentence. A template fill, not a generation.
 *
 * `{subject} — {label}` and, when the minutes say what it was about,
 * `on {matter}`. No adjective on the action, no connective that implies a
 * reason, nothing the extractor wrote except the two spans of the record it
 * copied.
 */
export function renderClaim(claim: RenderableClaim): string {
  const subject = claim.subject_name.trim();
  const head = `${subject} — ${ACTION_LABEL[claim.action]}`;
  const matter = (claim.matter ?? "").trim();
  return matter === "" ? head : `${head} on ${matter}`;
}

export function renderSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** What a stored claim looks like to the renderer. Column names, not a view. */
export interface PinnedClaimRow {
  subject_name: unknown;
  action: unknown;
  matter: unknown;
  rendered_text: unknown;
  render_sha256: unknown;
  render_version: unknown;
}

export type ClaimRender =
  | { state: "renderable"; text: string }
  /**
   * The pin broke. The claim does **not** render — not from `rendered_text`
   * either — and the meeting page says one claim is awaiting re-review.
   */
  | { state: "awaiting_re_review"; reason: string };

/**
 * The pin, and what it does when it breaks.
 *
 * Recomputes the sentence from current code and compares it to what the
 * operator approved. On any disagreement the claim does not render:
 *
 *  - it does **not** fall back to the stored `rendered_text`, because that
 *    would publish a sentence whose meaning the current code no longer agrees
 *    with — the exact failure the pin exists to catch;
 *  - it does **not** silently re-approve, because the whole value of the
 *    approval is that a person read those bytes.
 *
 * Four ways it can break, reported separately because they are four different
 * problems: the render version was bumped (a deliberate batch re-review), the
 * action no longer has a label, the recomputed string hashes differently, or
 * the stored text and the stored hash disagree with each other — which means
 * something rewrote a column that only this module should ever write.
 */
export function renderApprovedClaim(row: PinnedClaimRow): ClaimRender {
  const pinnedVersion = typeof row.render_version === "string" ? row.render_version : null;
  if (pinnedVersion !== RENDER_VERSION) {
    return {
      state: "awaiting_re_review",
      reason:
        `approved under render version ${pinnedVersion ?? "none"}; ` +
        `this build renders ${RENDER_VERSION}`,
    };
  }

  const action = row.action;
  if (!isClaimAction(action)) {
    return {
      state: "awaiting_re_review",
      reason: `action ${JSON.stringify(action)} has no published wording`,
    };
  }

  const recomputed = renderClaim({
    subject_name: typeof row.subject_name === "string" ? row.subject_name : "",
    action,
    matter: typeof row.matter === "string" ? row.matter : null,
  });
  const pinnedSha = typeof row.render_sha256 === "string" ? row.render_sha256 : null;
  if (pinnedSha === null || renderSha256(recomputed) !== pinnedSha) {
    return {
      state: "awaiting_re_review",
      reason: "the sentence this build renders is not the sentence that was approved",
    };
  }
  if (row.rendered_text !== recomputed) {
    return {
      state: "awaiting_re_review",
      reason: "the approved text and the approved hash disagree",
    };
  }

  return { state: "renderable", text: recomputed };
}

/* ---------------------------------------------------------------------------
   Reading claims — the console's side
   --------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function asIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value);
}

/**
 * How much of the document the review screen shows around the quote.
 *
 * ±500 characters, from the published-claim spec §5. An operator approving a
 * sentence they cannot see in situ is rubber-stamping, and this is the single
 * most important element on the screen.
 */
export const QUOTE_CONTEXT_CHARS = 500;

export interface QuoteContext {
  /** The window of artifact text, already sliced. */
  text: string;
  /** Where the quote starts and ends *within `text`*, for the highlight. */
  quote_start: number;
  quote_end: number;
  /** Where the window starts within the whole document. */
  window_offset: number;
  /**
   * Whether the quote was found where `quote_offset` says it is.
   *
   * The claim's offset indexes the text the extractor read out of the PDF;
   * `artifact_texts` is written by the parse stage from the same bytes but not
   * necessarily by the same code path. False means the highlight below was
   * located by searching rather than by trusting the stored offset, and the
   * screen should say so rather than imply a precision it does not have.
   */
  offset_matches_stored: boolean;
}

export interface ClaimCitation {
  artifact_sha256: string;
  quote_offset: number;
  quote: string;
  /** Where we got the bytes. Null when no `artifacts` row holds this address. */
  source_url: string | null;
  /** Whether the cited bytes are actually stored. False blocks approval. */
  artifact_stored: boolean;
  /** The content-addressed viewer path the claim card links to. */
  viewer_path: string;
  context: QuoteContext | null;
}

export interface ClaimReviewItem {
  claim: {
    id: string;
    meeting_id: string;
    subject_name: string;
    member_id: string | null;
    action: string;
    matter: string | null;
    status: string;
    model: string;
    prompt_version: string;
    reviewed_by: string | null;
    review_reason: string | null;
    reviewed_at: string | null;
    approved_by: string | null;
    approved_at: string | null;
    rendered_text: string | null;
    render_sha256: string | null;
    render_version: string | null;
    retracted_at: string | null;
    retracted_reason: string | null;
    created_at: string;
    /** Derived from `review_policy.review_window_hours`. Never written. */
    overdue: boolean;
  };
  /**
   * The exact sentence that would publish, rendered by the same code the public
   * page uses — not a paraphrase, not the triple. This is what approval pins.
   */
  render: {
    text: string | null;
    sha256: string | null;
    version: string;
    /** Motive terms in the assembled sentence. Non-empty blocks approval. */
    motive_terms: string[];
    /** Whether `POST /:id/approve` would succeed right now. */
    approvable: boolean;
    /** Why not, in the operator's words. Null when approvable. */
    blocked_reason: string | null;
    /** For an approved claim: whether the pin still holds. Null otherwise. */
    pin: ClaimRender | null;
  };
  /**
   * The second model's opinion, or the absence of one.
   *
   * `null` means *not checked by the governor* and the screen must say so. It is
   * not a pass: a claim nobody could check labelled as though it had been is the
   * failure the whole governor design is arranged against. Nothing here changes
   * what is publishable — `render.approvable` does not consult it, and there is
   * no path from a verdict to `status = 'approved'`.
   */
  governor: ClaimVerdict | null;
  citation: ClaimCitation;
  context: {
    meeting_date: string | null;
    meeting_published_at: string | null;
    commission_name: string | null;
    jurisdiction_name: string | null;
  };
}

const CLAIM_COLUMNS = [
  "minute_claims.id as id",
  "minute_claims.meeting_id as meeting_id",
  "minute_claims.artifact_sha256 as artifact_sha256",
  "minute_claims.subject_name as subject_name",
  "minute_claims.member_id as member_id",
  "minute_claims.action as action",
  "minute_claims.matter as matter",
  "minute_claims.quote as quote",
  "minute_claims.quote_offset as quote_offset",
  "minute_claims.model as model",
  "minute_claims.prompt_version as prompt_version",
  "minute_claims.status as status",
  "minute_claims.reviewed_by as reviewed_by",
  "minute_claims.review_reason as review_reason",
  "minute_claims.reviewed_at as reviewed_at",
  "minute_claims.approved_by as approved_by",
  "minute_claims.approved_at as approved_at",
  "minute_claims.rendered_text as rendered_text",
  "minute_claims.render_sha256 as render_sha256",
  "minute_claims.render_version as render_version",
  "minute_claims.retracted_at as retracted_at",
  "minute_claims.retracted_reason as retracted_reason",
  "minute_claims.created_at as created_at",
  // The newest verdict, or nulls. See `claimQuery`.
  "verdict.supported as governor_supported",
  "verdict.unsupported_fragments as governor_unsupported_fragments",
  "verdict.relied_on as governor_relied_on",
  "verdict.confidence as governor_confidence",
  "verdict.model as governor_model",
  "verdict.prompt_version as governor_prompt_version",
  "verdict.window_sha256 as governor_window_sha256",
  "verdict.created_at as governor_created_at",
  "meetings.date as meeting_date",
  "meetings.published_at as meeting_published_at",
  "commissions.name as commission_name",
  "jurisdictions.name as jurisdiction_name",
];

/**
 * The claim, its meeting, and the governor's newest verdict about it.
 *
 * A lateral join rather than a second query per row: the queue lists fifty
 * claims at a time and a per-row lookup would be fifty round trips to annotate a
 * page. Newest wins because a claim is re-judged when the model or the prompt
 * changes and the current answer is the one an operator is being shown — the
 * older rows stay in `claim_verdicts`, which is why they are rows and not
 * columns.
 *
 * A claim with no verdict joins to nulls, and that is a state of its own: *not
 * checked by the governor*. It is neither a pass nor a fail.
 */
function claimQuery(db: Knex): Knex.QueryBuilder {
  return db("minute_claims")
    .join("meetings", "meetings.id", "minute_claims.meeting_id")
    .leftJoin("commissions", "commissions.id", "meetings.commission_id")
    .leftJoin("jurisdictions", "jurisdictions.id", "commissions.jurisdiction_id")
    .joinRaw(`
      left join lateral (
        select v.supported, v.unsupported_fragments, v.relied_on, v.confidence,
               v.model, v.prompt_version, v.window_sha256, v.created_at
        from claim_verdicts v
        where v.claim_id = minute_claims.id
        order by v.created_at desc, v.id desc
        limit 1
      ) verdict on true
    `);
}


/**
 * The address of a quote in the artifact viewer.
 *
 * `?offset=`, **not** `#offset-`. This built a fragment until 2026-08-15, and a
 * fragment never leaves the browser — the server is what picks the window, so
 * every one of these links would have opened a three-hundred-page packet at
 * character zero regardless of what it cited. The frontend's
 * `components/ui/citation-source.ts` builds the same query form; the two agree
 * because a citation that opens the wrong page is worse than one that does not
 * open at all, since the reader has no way to tell.
 *
 * `len` carries the quote's length so the viewer can mark where it *ends*. The
 * API returns no quote length, and without this the page can find the start and
 * nothing else.
 *
 * Exported so the place-link review path links to the same address rather than
 * building a second one — that is how the two would drift back into the
 * fragment form, one file at a time.
 */
export function viewerPath(sha256: string, offset: number, quoteLength: number): string {
  const params = new URLSearchParams({ offset: String(offset), len: String(quoteLength) });
  return `/source/${sha256}?${params.toString()}`;
}

/**
 * The bytes behind the citation, and the window an operator reads it in.
 *
 * Two questions, and the second depends on the first: is there an `artifacts`
 * row at this content address, and do we hold text for it. A claim whose bytes
 * are not stored cites nothing a reader could check, and that is what makes it
 * unapprovable rather than merely awkward to review.
 */
async function loadCitation(
  db: Knex,
  claim: { artifact_sha256: string; quote: string; quote_offset: number },
): Promise<ClaimCitation> {
  const base: ClaimCitation = {
    artifact_sha256: claim.artifact_sha256,
    quote_offset: claim.quote_offset,
    quote: claim.quote,
    source_url: null,
    artifact_stored: false,
    viewer_path: viewerPath(claim.artifact_sha256, claim.quote_offset, claim.quote.length),
    context: null,
  };

  const artifact: unknown = await db("artifacts")
    .where({ sha256: claim.artifact_sha256 })
    .first("id", "source_url");
  if (!isRecord(artifact)) return base;

  const stored: ClaimCitation = {
    ...base,
    source_url: textOrNull(artifact.source_url),
    artifact_stored: true,
  };

  const row: unknown = await db("artifact_texts")
    .where({ artifact_id: artifact.id })
    .first("text");
  if (!isRecord(row) || typeof row.text !== "string") return stored;

  return { ...stored, context: sliceContext(row.text, claim.quote, claim.quote_offset) };
}

/**
 * Where the quote ends in the document, walked rather than added.
 *
 * `at + quote.length` is wrong whenever the document's whitespace differs from
 * the quote's, which for PDF-extracted text is most of the time — a line break
 * where the quote has a space makes the highlight drift by a character per
 * line. Walking both strings and skipping whitespace on either side gives the
 * span the reader actually sees.
 */
function spanEnd(documentText: string, at: number, quote: string): number {
  let index = at;
  let cursor = 0;
  while (index < documentText.length && cursor < quote.length) {
    if (/\s/.test(quote[cursor])) {
      cursor += 1;
      continue;
    }
    if (/\s/.test(documentText[index])) {
      index += 1;
      continue;
    }
    index += 1;
    cursor += 1;
  }
  return index;
}

/**
 * The ±500-character window, with the quote span located rather than assumed.
 *
 * `locateQuote` decides where the quote is, whitespace-insensitively, for the
 * reason `verify.ts` gives: PDF text extraction is not stable about line breaks,
 * so an exact index search fails on a quote that is plainly there. The stored
 * offset is the fallback, used only when it lands on the quote exactly, and a
 * disagreement between the two is reported rather than hidden — an operator
 * told "here is the quote in context" deserves to know when the context was
 * found by searching.
 */
export function sliceContext(
  documentText: string,
  quote: string,
  storedOffset: number,
): QuoteContext | null {
  const located = locateQuote(documentText, quote);
  const fallback =
    documentText.slice(storedOffset, storedOffset + quote.length) === quote ? storedOffset : null;
  const at = located ?? fallback;
  if (at === null) return null;

  const quoteEnd = spanEnd(documentText, at, quote);
  const start = Math.max(0, at - QUOTE_CONTEXT_CHARS);
  const end = Math.min(documentText.length, quoteEnd + QUOTE_CONTEXT_CHARS);
  return {
    text: documentText.slice(start, end),
    quote_start: at - start,
    quote_end: quoteEnd - start,
    window_offset: start,
    offset_matches_stored: at === storedOffset,
  };
}

/** The refusals `approveClaim` will make, computed for display. */
function approvalBlock(
  row: Record<string, unknown>,
  citation: ClaimCitation,
  rendered: string | null,
  motive: string[],
): string | null {
  if (row.status !== "held") return `this claim is ${text(row.status)}, not held`;
  if (!isClaimAction(row.action)) {
    return `action ${JSON.stringify(row.action)} has no published wording`;
  }
  if (text(row.quote).trim() === "" || Number(row.quote_offset) < 0) {
    return "this claim cites nothing";
  }
  if (!citation.artifact_stored) {
    return "the bytes this claim cites are not stored, so a reader could not check it";
  }
  if (rendered === null || rendered.trim() === "") return "this claim renders no sentence";
  if (motive.length > 0) {
    return `the sentence asserts motive. Remove: ${motive.join(", ")}`;
  }
  return null;
}

async function toReviewItem(
  db: Knex,
  row: Record<string, unknown>,
  overdueBefore: Date,
): Promise<ClaimReviewItem> {
  const citation = await loadCitation(db, {
    artifact_sha256: text(row.artifact_sha256),
    quote: text(row.quote),
    quote_offset: Number(row.quote_offset) || 0,
  });

  const action = row.action;
  const rendered = isClaimAction(action)
    ? renderClaim({
        subject_name: text(row.subject_name),
        action,
        matter: textOrNull(row.matter),
      })
    : null;
  const motive = rendered === null ? [] : motiveTerms(rendered);
  const blocked = approvalBlock(row, citation, rendered, motive);

  return {
    claim: {
      id: text(row.id),
      meeting_id: text(row.meeting_id),
      subject_name: text(row.subject_name),
      member_id: textOrNull(row.member_id),
      action: text(row.action),
      matter: textOrNull(row.matter),
      status: text(row.status),
      model: text(row.model),
      prompt_version: text(row.prompt_version),
      reviewed_by: textOrNull(row.reviewed_by),
      review_reason: textOrNull(row.review_reason),
      reviewed_at: asIsoOrNull(row.reviewed_at),
      approved_by: textOrNull(row.approved_by),
      approved_at: asIsoOrNull(row.approved_at),
      rendered_text: textOrNull(row.rendered_text),
      render_sha256: textOrNull(row.render_sha256),
      render_version: textOrNull(row.render_version),
      retracted_at: asIsoOrNull(row.retracted_at),
      retracted_reason: textOrNull(row.retracted_reason),
      created_at: asIso(row.created_at),
      overdue:
        row.status === "held" && new Date(asIso(row.created_at)).getTime() < overdueBefore.getTime(),
    },
    render: {
      text: rendered,
      sha256: rendered === null ? null : renderSha256(rendered),
      version: RENDER_VERSION,
      motive_terms: motive,
      approvable: blocked === null,
      blocked_reason: blocked,
      pin:
        row.status === "approved"
          ? renderApprovedClaim({
              subject_name: row.subject_name,
              action: row.action,
              matter: row.matter,
              rendered_text: row.rendered_text,
              render_sha256: row.render_sha256,
              render_version: row.render_version,
            })
          : null,
    },
    governor: toClaimVerdict(row),
    citation,
    context: {
      meeting_date: asIsoOrNull(row.meeting_date),
      meeting_published_at: asIsoOrNull(row.meeting_published_at),
      commission_name: textOrNull(row.commission_name),
      jurisdiction_name: textOrNull(row.jurisdiction_name),
    },
  };
}

export const CLAIM_QUEUE_STATUSES = ["held", "approved", "rejected"] as const;

export type ClaimQueueStatus = (typeof CLAIM_QUEUE_STATUSES)[number];

export function isClaimQueueStatus(value: unknown): value is ClaimQueueStatus {
  return typeof value === "string" && (CLAIM_QUEUE_STATUSES as readonly string[]).includes(value);
}

export interface ClaimQueueFilters {
  status?: ClaimQueueStatus;
  meeting_id?: string;
  limit?: number;
  offset?: number;
}

export interface ClaimQueueListing {
  data: ClaimReviewItem[];
  total: number;
  counts: {
    held: number;
    approved: number;
    rejected: number;
    retracted: number;
    overdue: number;
    /**
     * Held claims the governor has not judged.
     *
     * Visible as a count because a silently growing backlog of unjudged claims
     * looks identical to a system with nothing to judge. A governor that has
     * stopped running produces no error and no missing page — it produces this
     * number climbing.
     */
    governor_unjudged: number;
  };
}

/**
 * The claims queue. Oldest first, and no severity anywhere.
 *
 * A claim has no severity and should not acquire one: every row here is one
 * sentence about one named person, and a ranking would invite an operator to
 * work the top of it and leave the rest. Within a meeting the order is
 * `quote_offset`, which is the order the sentences appear in the minutes — the
 * order someone reading the document would meet them in, and stable across
 * re-renders because the offset is a property of the bytes.
 */
export async function listClaimQueue(
  db: Knex,
  filters: ClaimQueueFilters = {},
): Promise<ClaimQueueListing> {
  const policy = await loadPolicy(db);
  const overdueBefore = new Date(Date.now() - policy.review_window_hours * 3_600_000);

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const base = claimQuery(db);
  if (filters.status !== undefined) base.where("minute_claims.status", filters.status);
  if (filters.meeting_id !== undefined) base.where("minute_claims.meeting_id", filters.meeting_id);

  const countRow = await base.clone().count("* as total").first<{ total?: string } | undefined>();
  const total = Number(countRow?.total ?? 0);

  const rows = await base
    .clone()
    .select<Array<Record<string, unknown>>>(CLAIM_COLUMNS)
    // A claim the governor refused drops to the bottom. It is **not** hidden and
    // **not** deleted: a judge with a 5% error rate that auto-discards silently
    // loses one true claim in twenty, and a filter that hides these by default
    // would make the governor an auto-discarder with extra steps. An unjudged
    // claim sorts with the supported ones, because not-checked is not doubt.
    .orderByRaw("coalesce(verdict.supported = false, false) asc")
    .orderBy([
      { column: "minute_claims.created_at", order: "asc" },
      { column: "minute_claims.meeting_id", order: "asc" },
      { column: "minute_claims.quote_offset", order: "asc" },
    ])
    .limit(limit)
    .offset(offset);

  const data: ClaimReviewItem[] = [];
  for (const row of rows) data.push(await toReviewItem(db, row, overdueBefore));

  const tallies = await db("minute_claims")
    .select<Array<{ status: string; retracted: boolean; overdue: boolean; count: string }>>([
      "status",
      db.raw("(retracted_at IS NOT NULL) as retracted"),
      db.raw("(status = 'held' AND created_at < ?) as overdue", [overdueBefore]),
      db.raw("count(*) as count"),
    ])
    .groupByRaw("status, retracted, overdue");

  const counts = {
    held: 0,
    approved: 0,
    rejected: 0,
    retracted: 0,
    overdue: 0,
    governor_unjudged: await governorBacklog(db),
  };
  for (const row of tallies) {
    const n = Number(row.count);
    if (row.status === "held") counts.held += n;
    else if (row.status === "approved") counts.approved += n;
    else if (row.status === "rejected") counts.rejected += n;
    if (row.retracted) counts.retracted += n;
    if (row.overdue) counts.overdue += n;
  }

  return { data, total, counts };
}

/** One claim as the review screen sees it, or `null`. */
export async function getClaimReview(db: Knex, claimId: string): Promise<ClaimReviewItem | null> {
  const policy = await loadPolicy(db);
  const overdueBefore = new Date(Date.now() - policy.review_window_hours * 3_600_000);
  const row = await claimQuery(db)
    .where("minute_claims.id", claimId)
    .select<Array<Record<string, unknown>>>(CLAIM_COLUMNS)
    .first();
  if (row === undefined) return null;
  return toReviewItem(db, row, overdueBefore);
}

/* ---------------------------------------------------------------------------
   Deciding
   --------------------------------------------------------------------------- */

export interface ClaimDecisionInput {
  claimId: string;
  reason: string;
  actor: ReviewActor;
}

function requireReason(reason: string): void {
  if (reason.trim() === "") {
    throw new ReviewError(
      "reason is required: a decision without one is not a decision anyone can review",
      400,
    );
  }
}

async function loadForDecision(
  trx: Knex.Transaction,
  claimId: string,
): Promise<Record<string, unknown>> {
  const row: unknown = await trx("minute_claims").where({ id: claimId }).forUpdate().first();
  if (!isRecord(row)) throw new ReviewError("No claim with that id", 404);
  return row;
}

/**
 * Approval — the one thing that makes a claim public, and the only place in
 * this module that writes the pin.
 *
 * Everything it refuses, it refuses here rather than in the console, so the
 * refusal holds for any caller:
 *
 *  - **an unnamed approver.** `approved_by` is what "an operator decided this"
 *    means; without it the row would satisfy nothing the CHECK is for, and the
 *    database would reject it anyway with a message about a constraint rather
 *    than about a person.
 *  - **an uncited claim, or one whose cited bytes we do not hold.** No
 *    unsourced claim reaches the public site, and a content address with no
 *    artifact behind it is a citation a reader cannot follow.
 *  - **a sentence that asserts motive.** Describing intent is how a citation
 *    becomes an accusation.
 *  - **an action with no label.** Which cannot happen while `ACTION_LABEL` is
 *    exhaustive, and is checked because the thing that makes it exhaustive is a
 *    test, and a test is not a runtime.
 *
 * The event goes inside the transaction. `emitEvent` re-reads the claim through
 * `publication.ts` and refuses a subject that is not public, so the update must
 * already be visible — and a claim on a meeting an operator has withheld
 * legitimately produces no event at all. What announces those is the meeting
 * publish path in `routes/admin/pressroom.ts`, when the meeting goes out.
 */
export async function approveClaim(
  db: Knex,
  input: ClaimDecisionInput,
): Promise<ClaimReviewItem> {
  requireReason(input.reason);
  if (input.actor.id === null) {
    throw new ReviewError(
      "an approval must name the operator making it: publishing a sentence about a " +
        "person is signed work",
      400,
    );
  }
  const approvedBy = input.actor.id;

  await db.transaction(async (trx) => {
    const claim = await loadForDecision(trx, input.claimId);
    if (claim.status !== "held") {
      throw new ReviewError(`That claim is ${text(claim.status)}, so there is nothing to approve`, 409);
    }

    const action = claim.action;
    if (!isClaimAction(action)) {
      throw new ReviewError(
        `That claim's action ${JSON.stringify(action)} has no published wording, so there is ` +
          "no sentence to approve",
        409,
      );
    }

    if (text(claim.quote).trim() === "" || Number(claim.quote_offset) < 0) {
      throw new ReviewError(
        "That claim cites nothing, so it cannot be approved. " +
          "No unsourced claim reaches the public site.",
        409,
      );
    }
    const artifact: unknown = await trx("artifacts")
      .where({ sha256: text(claim.artifact_sha256) })
      .first("id");
    if (!isRecord(artifact)) {
      throw new ReviewError(
        "The bytes that claim cites are not stored, so a reader could not check it. " +
          "No unsourced claim reaches the public site.",
        409,
      );
    }

    const rendered = renderClaim({
      subject_name: text(claim.subject_name),
      action,
      matter: textOrNull(claim.matter),
    });
    if (rendered.trim() === "") {
      throw new ReviewError("That claim renders no sentence", 409);
    }
    const terms = motiveTerms(rendered);
    if (terms.length > 0) {
      throw new ReviewError(
        `A claim describes the record, never the motive. Remove: ${terms.join(", ")}`,
        400,
      );
    }

    await appendCorrectionRow(trx, {
      targetTable: "minute_claims",
      targetId: input.claimId,
      field: "status",
      oldValue: "held",
      newValue: "approved",
      reason: input.reason,
      actor: input.actor,
    });

    await trx("minute_claims")
      .where({ id: input.claimId })
      .update({
        status: "approved",
        rendered_text: rendered,
        render_sha256: renderSha256(rendered),
        render_version: RENDER_VERSION,
        approved_by: approvedBy,
        approved_at: trx.fn.now(),
        reviewed_by: approvedBy,
        review_reason: input.reason,
        reviewed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });

    // After the update, so the re-read `emitEvent` performs sees the approval.
    // Skipped rather than forced when the meeting is withheld: see the header.
    if (await subjectIsPublic(trx, "claim", input.claimId)) {
      await emitEvent(trx, {
        event_type: "claim.approved",
        subject_kind: "claim",
        subject_id: input.claimId,
        jurisdiction_id: await claimJurisdictionId(trx, text(claim.meeting_id)),
        payload: {
          title: rendered,
          claim_id: input.claimId,
          meeting_id: text(claim.meeting_id),
          subject_name: text(claim.subject_name),
          artifact_sha256: text(claim.artifact_sha256),
          quote_offset: Number(claim.quote_offset) || 0,
        },
      });
    }
  });

  const item = await getClaimReview(db, input.claimId);
  if (item === null) throw new ReviewError("No claim with that id", 404);
  return item;
}

/** The jurisdiction a claim belongs to, for routing. */
async function claimJurisdictionId(
  trx: Knex.Transaction,
  meetingId: string,
): Promise<string | null> {
  const row = await trx("meetings")
    .join("commissions", "commissions.id", "meetings.commission_id")
    .where("meetings.id", meetingId)
    .first<{ jurisdiction_id: string | null } | undefined>(
      "commissions.jurisdiction_id as jurisdiction_id",
    );
  return row?.jurisdiction_id ?? null;
}

/**
 * Rejection. The claim becomes `rejected` and the wall never lets it through.
 *
 * Unlike a rejected *finding* — which is left `held`, because `anomaly_flags`
 * has no rejected state — `minute_claims.status` has one, and using it is what
 * lets the console show an operator what they have already refused instead of
 * offering it back to them next week. The audit row's field is `status`,
 * because a column really did change; claiming otherwise would make the log
 * describe a write that did not happen.
 */
export async function rejectClaim(db: Knex, input: ClaimDecisionInput): Promise<ClaimReviewItem> {
  requireReason(input.reason);

  await db.transaction(async (trx) => {
    const claim = await loadForDecision(trx, input.claimId);
    if (claim.status !== "held") {
      throw new ReviewError(`That claim is ${text(claim.status)}, so there is nothing to reject`, 409);
    }

    await appendCorrectionRow(trx, {
      targetTable: "minute_claims",
      targetId: input.claimId,
      field: "status",
      oldValue: "held",
      newValue: "rejected",
      reason: input.reason,
      actor: input.actor,
    });

    await trx("minute_claims")
      .where({ id: input.claimId })
      .update({
        status: "rejected",
        reviewed_by: input.actor.id,
        review_reason: input.reason,
        reviewed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
  });

  const item = await getClaimReview(db, input.claimId);
  if (item === null) throw new ReviewError("No claim with that id", 404);
  return item;
}

/**
 * Retraction — an append, and it leaves a mark.
 *
 * `status` stays `approved` and `rendered_text` is preserved. Both are
 * deliberate: the wall is `approved AND retracted_at IS NULL`, so this one
 * column takes the claim off the page, and the preserved text is what the
 * tombstone quotes. A person named in a retracted claim generally wants it
 * *gone* — but it was published, it is in caches and feeds, and a reader
 * arriving from one of those needs a page saying *that sentence was wrong*
 * rather than a page showing nothing while the cached version remains the only
 * version they ever see. Silence is not a correction.
 *
 * It also revokes what it announced, which it could not do when this was
 * written. `emitEvent`'s `claimIsPublic` predated migration 087 and asked only
 * for `status = 'approved'` and a published meeting, so it still called a
 * retracted claim public and `retractSubject` — which refuses while the subject
 * is *still* public — would have thrown. That function now goes through
 * `whereClaimPublic`, the same helper the wall uses everywhere else, so the
 * inverse assertion holds and the revocation runs.
 *
 * `retractSubject` is called **after** the update and **inside** the same
 * transaction, because that ordering is what makes the refusal meaningful: the
 * claim must already be non-public when the retraction is emitted.
 *
 * What it recalls and what it cannot is reported rather than implied. An event
 * still queued never sends — a real recall. One already dispatched is marked
 * revoked and answered with a `claim.retracted` event, because a Discord post is
 * gone and an RSS item is in a reader's cache. Pretending otherwise would be the
 * most comfortable kind of fiction available here.
 */
export async function retractClaim(db: Knex, input: ClaimDecisionInput): Promise<ClaimReviewItem> {
  requireReason(input.reason);

  await db.transaction(async (trx) => {
    const claim = await loadForDecision(trx, input.claimId);
    if (claim.status !== "approved") {
      throw new ReviewError(
        `That claim is ${text(claim.status)}, so it was never published and cannot be retracted`,
        409,
      );
    }
    if (claim.retracted_at !== null && claim.retracted_at !== undefined) {
      throw new ReviewError("That claim was already retracted", 409);
    }

    await appendCorrectionRow(trx, {
      targetTable: "minute_claims",
      targetId: input.claimId,
      field: "retracted_at",
      oldValue: null,
      newValue: new Date().toISOString(),
      reason: input.reason,
      actor: input.actor,
    });

    await trx("minute_claims")
      .where({ id: input.claimId })
      .update({
        retracted_at: trx.fn.now(),
        retracted_reason: input.reason,
        updated_at: trx.fn.now(),
      });

    // After the update, inside the transaction. `retractSubject` asserts the
    // subject is no longer public, which is only true once the row above has
    // been written — and only checkable because `claimIsPublic` now tests
    // `retracted_at` through the shared helper.
    await retractSubject(trx, {
      subject_kind: "claim",
      subject_id: input.claimId,
      reason: input.reason,
    });
  });

  const item = await getClaimReview(db, input.claimId);
  if (item === null) throw new ReviewError("No claim with that id", 404);
  return item;
}

/* ---------------------------------------------------------------------------
   Reading claims — the reader's side
   --------------------------------------------------------------------------- */

export interface PublicClaimCard {
  id: string;
  /** The anchor. Stable across re-renders because the id is. */
  anchor: string;
  text: string;
  quote: string;
  artifact_sha256: string;
  quote_offset: number;
  source_path: string;
  approved_at: string | null;
  model: string;
  prompt_version: string;
}

export interface PublicClaimTombstone {
  id: string;
  anchor: string;
  retracted_at: string;
  retracted_reason: string;
  /** What it previously read. Preserved on purpose — see `retractClaim`. */
  previous_text: string | null;
}

export interface PublicClaims {
  claims: PublicClaimCard[];
  tombstones: PublicClaimTombstone[];
  /**
   * Approved claims whose pin no longer holds. A count, not the claims: the
   * page says "one claim from this meeting is awaiting re-review" and shows
   * nothing, because the whole point of the pin is that this text does not go
   * out.
   */
  awaiting_re_review: number;
}

/**
 * What a reader may see from one meeting, in the order the minutes say it.
 *
 * A claim never appears alone and this function is why there is no per-claim
 * reader: it answers "what did this meeting's minutes record", which is a
 * question about a meeting. A page whose entire content is one sentence about
 * one named person is an accusation; the same sentence in the record it came
 * from is a record.
 */
export async function listPublicClaims(db: Knex, meetingId: string): Promise<PublicClaims> {
  const query = db("minute_claims")
    .where("minute_claims.meeting_id", meetingId)
    .orderBy("minute_claims.quote_offset", "asc")
    .select<Array<Record<string, unknown>>>("minute_claims.*");
  const rows = await whereClaimPublic(db, query);

  const claims: PublicClaimCard[] = [];
  let awaiting = 0;
  for (const row of rows) {
    const render = renderApprovedClaim({
      subject_name: row.subject_name,
      action: row.action,
      matter: row.matter,
      rendered_text: row.rendered_text,
      render_sha256: row.render_sha256,
      render_version: row.render_version,
    });
    if (render.state !== "renderable") {
      awaiting += 1;
      continue;
    }
    const offset = Number(row.quote_offset) || 0;
    const sha = text(row.artifact_sha256);
    claims.push({
      id: text(row.id),
      anchor: `claim-${text(row.id)}`,
      text: render.text,
      quote: text(row.quote),
      artifact_sha256: sha,
      quote_offset: offset,
      source_path: viewerPath(sha, offset, text(row.quote).length),
      approved_at: asIsoOrNull(row.approved_at),
      model: text(row.model),
      prompt_version: text(row.prompt_version),
    });
  }

  // Tombstones are read outside the wall on purpose: a retracted claim is
  // excluded from it by definition, and the correction is the one thing that
  // must still be reachable at the anchor a reader arrives on.
  const retracted = await db("minute_claims")
    .where("minute_claims.meeting_id", meetingId)
    .where("minute_claims.status", "approved")
    .whereNotNull("minute_claims.retracted_at")
    .whereExists(
      db("meetings")
        .whereRaw("meetings.id = minute_claims.meeting_id")
        .whereNotNull("meetings.published_at"),
    )
    .orderBy("minute_claims.quote_offset", "asc")
    .select<Array<Record<string, unknown>>>("minute_claims.*");

  const tombstones: PublicClaimTombstone[] = retracted.map((row) => ({
    id: text(row.id),
    anchor: `claim-${text(row.id)}`,
    retracted_at: asIso(row.retracted_at),
    retracted_reason: text(row.retracted_reason),
    previous_text: textOrNull(row.rendered_text),
  }));

  return { claims, tombstones, awaiting_re_review: awaiting };
}

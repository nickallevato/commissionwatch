import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  correlateVoteDonorsWithDiagnostics,
  MATCH_BAND_LABEL,
  MATCH_POLICY,
  type CorrelationContribution,
  type CorrelationVote,
} from "../src/services/finance/correlation";
import {
  ENTITY_DECISION_LABEL,
  listEntityDecisions,
  loadEntityDecisions,
  pairFor,
  pairKey,
  recordEntityDecision,
  type StoredEntityDecision,
} from "../src/services/finance/entity-resolution";
import { parseVoteDonorEvidence } from "../src/services/finance/evidence";
import { MATCH_BANDS } from "../src/services/finance/name-match";
import { listQueue } from "../src/services/review/queue";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
  signInOperator,
} from "./helpers/pressroom";

/**
 * The operator's entity-resolution judgement, and the weak-match policy.
 *
 * Two things are under test here and they are two halves of the same problem:
 * a `vote_donor_conflict` rests on a name match, a name match cannot resolve
 * identity, and the only thing that can is a person looking at it.
 *
 *  1. **The threshold is a stated policy.** A `weak` match is dropped, the drop
 *     is counted, and the sentence explaining it is served to the console rather
 *     than paraphrased there.
 *  2. **The judgement is remembered.** A decision is recorded against the pair,
 *     reused on the next sweep, revisable, and audited in the one append-only
 *     log this project has.
 *
 * Nothing here cleans up `record_corrections` — migration 031 forbids DELETE —
 * so every assertion about it is scoped to ids this run generated. The
 * `entity_resolution_decisions` rows *are* cleaned up: that table is current
 * state, not an audit log, and a pair left behind would suppress a later run's
 * findings.
 */

const PREFIX = "entity-resolution-test";
const EMAIL = "entity-resolution-test@example.invalid";
const AGENDA_SHA = sha256Of("entity-resolution-agenda");

/** Deliberately distinctive, so no other fixture's pair collides with it. */
const DONOR = "Zorbulant Aggregate LLC";
const AGENDA_TITLE = "Zorbulant Aggregate gravel supply contract award";

/**
 * Shares exactly one distinctive term with the agenda item out of two, so the
 * coverage is 0.5 on a single term: a `weak` match, and a coincidence.
 */
const WEAK_DONOR = "Zorbulant Grazing Cooperative";

/** The terms the matcher actually finds for `DONOR` in `AGENDA_TITLE`. */
const MATCHED = ["zorbulant", "aggregate"];

function vote(overrides: Partial<CorrelationVote> = {}): CorrelationVote {
  return {
    vote_id: "11111111-1111-1111-1111-111111111111",
    member_id: "22222222-2222-2222-2222-222222222222",
    member_name: "Dana Whitcomb",
    vote: "yes",
    agenda_item_id: "33333333-3333-3333-3333-333333333333",
    agenda_item_number: 7,
    agenda_item_title: AGENDA_TITLE,
    agenda_item_description: null,
    ...overrides,
  };
}

function contribution(overrides: Partial<CorrelationContribution> = {}): CorrelationContribution {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    source_system: "openfec",
    donor_name: DONOR,
    recipient_name: "Dana Whitcomb",
    committee_name: "Whitcomb for Montana",
    amount: 2500,
    contribution_date: "2026-03-04",
    external_id: "4062020241234567890",
    image_number: "202604159876543210",
    source_url: "https://api.open.fec.gov/v1/schedules/schedule_a/?per_page=25",
    ...overrides,
  };
}

function decision(
  overrides: Partial<StoredEntityDecision> & Pick<StoredEntityDecision, "decision">,
): StoredEntityDecision {
  return {
    donorNameFiled: DONOR,
    subjectTerms: "aggregate zorbulant",
    reason: "Checked the filing and the staff report; they are the same company.",
    operatorEmail: EMAIL,
    decidedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

/** The pair the rule will actually look up, not one hand-built beside it. */
function donorPair() {
  const pair = pairFor(DONOR, MATCHED);
  assert.ok(pair !== null);
  return pair;
}

function decisionsFor(stored: StoredEntityDecision): Map<string, StoredEntityDecision> {
  return new Map([[pairKey(donorPair()), stored]]);
}

// ---------------------------------------------------------------------------
// The pair key
// ---------------------------------------------------------------------------

describe("the pair an operator judges", () => {
  it("is stable across the spellings of one filed name", () => {
    // The same company, filed three ways by three clerks. If these produced
    // three keys, a judgement would have to be made three times and the feature
    // would be worse than not having it.
    const a = pairFor("Ridgeline Aggregate LLC", ["ridgeline"]);
    const b = pairFor("RIDGELINE AGGREGATE, L.L.C.", ["ridgeline"]);
    const c = pairFor("Ridgeline  Aggregate  llc", ["ridgeline"]);
    assert.ok(a && b && c);
    assert.equal(pairKey(a), pairKey(b));
    assert.equal(pairKey(b), pairKey(c));
  });

  it("is stable whatever order the matched terms arrive in", () => {
    // `matchedTerms` follows the order of the filed name, and the same pair
    // reached through a differently worded agenda item must not fork.
    const a = pairFor("Ridgeline Aggregate", ["ridgeline", "aggregate"]);
    const b = pairFor("Ridgeline Aggregate", ["aggregate", "ridgeline"]);
    assert.ok(a && b);
    assert.equal(pairKey(a), pairKey(b));
  });

  it("separates two donors that matched on the same term", () => {
    const a = pairFor("Ridgeline Aggregate", ["ridgeline"]);
    const b = pairFor("Ridgeline Housing Trust", ["ridgeline"]);
    assert.ok(a && b);
    assert.notEqual(pairKey(a), pairKey(b));
  });

  it("separates one donor's two subjects", () => {
    const a = pairFor("Ridgeline Aggregate", ["ridgeline"]);
    const b = pairFor("Ridgeline Aggregate", ["ridgeline", "aggregate"]);
    assert.ok(a && b);
    assert.notEqual(pairKey(a), pairKey(b));
  });

  it("is null when there is nothing distinctive to key on", () => {
    assert.equal(pairFor("", ["ridgeline"]), null);
    assert.equal(pairFor("Ridgeline", []), null);
    assert.equal(pairFor("Ridgeline", ["  "]), null);
  });
});

// ---------------------------------------------------------------------------
// The weak-match policy
// ---------------------------------------------------------------------------

describe("the weak-match policy", () => {
  it("does not raise a weak match, and says so in the tally", () => {
    const result = correlateVoteDonorsWithDiagnostics({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [contribution({ donor_name: WEAK_DONOR })],
    });

    assert.deepEqual(result.drafts, []);
    const withheld = result.withheld.find((row) => row.reason === "below_minimum_band");
    assert.ok(withheld, "a dropped weak match must be counted, not silently discarded");
    assert.equal(withheld.band, "weak");
    assert.equal(withheld.count, 1);
  });

  it("still raises the match that clears the threshold", () => {
    const result = correlateVoteDonorsWithDiagnostics({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [contribution()],
    });
    assert.equal(result.drafts.length, 1);
    assert.deepEqual(result.withheld, []);
  });

  it("states the minimum band the console enforces", () => {
    assert.equal(MATCH_POLICY.minimumBand, "moderate");
    assert.deepEqual(
      MATCH_POLICY.bands.map((entry) => entry.band),
      [...MATCH_BANDS],
    );
  });

  it("never lets a label read as certainty", () => {
    // The same lexicon `DonorOverlay.test.tsx` holds the public chip to. There
    // is no band above `strong`, and no label on any surface may imply one.
    const forbidden = ["confirmed", "certain", "identified", "proven", "exact", "verified"];
    const labels = [
      ...Object.values(MATCH_BAND_LABEL),
      ...MATCH_POLICY.bands.map((entry) => entry.label),
      ...Object.values(ENTITY_DECISION_LABEL),
    ];
    for (const label of labels) {
      for (const word of forbidden) {
        assert.ok(!label.toLowerCase().includes(word), `"${label}" must not contain "${word}"`);
      }
    }
  });

  it("never lets the policy statement claim certainty", () => {
    // Scanned against the same lexicon **minus** "verified", because the one
    // sentence the statement is required to carry is "not a verified identity".
    // A naive substring scan over the whole statement would fail on the very
    // caveat it exists to preserve — which is how a guard ends up being deleted
    // rather than the wording being fixed.
    for (const word of ["confirmed", "certain", "identified", "proven", "exact"]) {
      assert.ok(
        !MATCH_POLICY.statement.toLowerCase().includes(word),
        `the policy statement must not contain "${word}"`,
      );
    }
  });

  it("keeps the caveat the public reads on the operator's surface too", () => {
    // The brief's requirement, made a test: an approver should read the same
    // words a reader does, not a softened version of them.
    assert.ok(MATCH_POLICY.statement.includes("not a verified identity"));
  });
});

// ---------------------------------------------------------------------------
// Applying a judgement
// ---------------------------------------------------------------------------

describe("an operator's judgement, applied to the rule", () => {
  const input = {
    meetingId: "55555555-5555-5555-5555-555555555555",
    votes: [vote()],
    contributions: [contribution()],
  };

  it("suppresses the finding when the operator judged different entities", () => {
    const result = correlateVoteDonorsWithDiagnostics({
      ...input,
      entityDecisions: decisionsFor(decision({ decision: "different_entity" })),
    });

    assert.deepEqual(result.drafts, []);
    const withheld = result.withheld.find(
      (row) => row.reason === "operator_judged_different_entity",
    );
    assert.ok(withheld, "a suppression by judgement must be distinguishable from a low band");
    assert.equal(withheld.count, 1);
  });

  it("still raises, and still holds, when the operator judged the same entity", () => {
    const result = correlateVoteDonorsWithDiagnostics({
      ...input,
      entityDecisions: decisionsFor(decision({ decision: "same_entity" })),
    });

    assert.equal(result.drafts.length, 1);
    // The whole point: judging two names to be the same entity is not approval.
    // Nothing here may publish a finding as a side effect.
    assert.equal(result.drafts[0].review_state, "held");
  });

  it("carries the judgement into the stored evidence", () => {
    const result = correlateVoteDonorsWithDiagnostics({
      ...input,
      entityDecisions: decisionsFor(decision({ decision: "same_entity" })),
    });
    const evidence = parseVoteDonorEvidence(result.drafts[0].metadata);
    assert.ok(evidence);
    assert.equal(evidence.operatorEntityDecision?.decision, "same_entity");
    assert.equal(evidence.operatorEntityDecision?.operatorEmail, EMAIL);
  });

  it("carries null when the pair has never been judged", () => {
    const result = correlateVoteDonorsWithDiagnostics(input);
    const evidence = parseVoteDonorEvidence(result.drafts[0].metadata);
    assert.ok(evidence);
    assert.equal(evidence.operatorEntityDecision, null);
  });

  it("does not change the sentence a reader is shown", () => {
    // A judgement is context for the next operator. It is not a stronger claim,
    // and the published description must not quietly become one.
    const plain = correlateVoteDonorsWithDiagnostics(input).drafts[0];
    const judged = correlateVoteDonorsWithDiagnostics({
      ...input,
      entityDecisions: decisionsFor(decision({ decision: "same_entity" })),
    }).drafts[0];
    assert.equal(judged.description, plain.description);
    assert.equal(judged.severity, plain.severity);
  });

  it("does not resurrect a match that was below the band anyway", () => {
    // The threshold runs first. An operator cannot have judged a pair they were
    // never shown, and a stored judgement must not be a back door around the
    // policy.
    const result = correlateVoteDonorsWithDiagnostics({
      ...input,
      contributions: [contribution({ donor_name: WEAK_DONOR })],
      entityDecisions: decisionsFor(decision({ decision: "same_entity" })),
    });
    assert.deepEqual(result.drafts, []);
  });

  it("treats every entity class identically", () => {
    // The invariant, restated against this feature: swapping the class word
    // changes nothing, because the class word is discarded before the pair is
    // built and there is no branch on it here either.
    const keys = ["LLC", "Union", "PAC", "Foundation", "Association"].map((suffix) => {
      const pair = pairFor(`Zorbulant Aggregate ${suffix}`, ["zorbulant"]);
      assert.ok(pair !== null);
      return pairKey(pair);
    });
    assert.equal(new Set(keys).size, 1);
  });
});

// ---------------------------------------------------------------------------
// Storing, reusing, and changing your mind
// ---------------------------------------------------------------------------

describe("recording an entity-resolution judgement", () => {
  let cookie: string;
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let meetingId: string;
  let artifactId: string;
  let flagId: string;
  let weakFlagId: string;
  let nonMatchFlagId: string;

  const actor = { id: null as string | null, email: EMAIL };

  async function clearDecisions(): Promise<void> {
    await db("entity_resolution_decisions").where("donor_name_filed", "like", "Zorbulant%").del();
  }

  before(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([AGENDA_SHA]);
    await clearDecisions();

    fixture = await createSource(PREFIX, { enabled: true });
    meetingId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
    });
    artifactId = await createArtifact(
      AGENDA_SHA,
      "https://example.invalid/entity-resolution/agenda.pdf",
    );

    const draft = correlateVoteDonorsWithDiagnostics({
      meetingId,
      votes: [vote()],
      contributions: [contribution()],
    }).drafts[0];

    const [row] = await db("anomaly_flags")
      .insert({
        meeting_id: meetingId,
        artifact_id: artifactId,
        flag_type: "vote_donor_conflict",
        description: draft.description,
        severity: draft.severity,
        source: "auto",
        review_state: "held",
        metadata: JSON.stringify(draft.metadata),
      })
      .returning<Array<{ id: string }>>("id");
    flagId = row.id;

    // A second name-match finding at a different band, to filter and sort by.
    const weakMetadata = {
      ...(draft.metadata as Record<string, unknown>),
      donorMatch: {
        method: "distinctive_term_overlap",
        band: "weak",
        score: 0.5,
        matchedTerms: ["zorbulant"],
        unmatchedTerms: ["aggregate"],
        discardedTerms: ["llc"],
      },
    };
    const [weakRow] = await db("anomaly_flags")
      .insert({
        meeting_id: meetingId,
        artifact_id: artifactId,
        flag_type: "vote_donor_conflict",
        description: draft.description,
        severity: "medium",
        source: "auto",
        review_state: "held",
        metadata: JSON.stringify(weakMetadata),
      })
      .returning<Array<{ id: string }>>("id");
    weakFlagId = weakRow.id;

    // A finding that is not a name match at all: it has no pair to judge.
    const [plainRow] = await db("anomaly_flags")
      .insert({
        meeting_id: meetingId,
        artifact_id: artifactId,
        flag_type: "quorum_issue",
        description: "The roll call records four members present against a quorum of five.",
        severity: "medium",
        source: "auto",
        review_state: "held",
        metadata: null,
      })
      .returning<Array<{ id: string }>>("id");
    nonMatchFlagId = plainRow.id;

    cookie = await signInOperator(EMAIL, "Entity Resolution Test");
  });

  after(async () => {
    await clearDecisions();
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([AGENDA_SHA]);
    await db.destroy();
  });

  it("stores one row per pair and reads it back keyed for the rule", async () => {
    await recordEntityDecision(db, {
      pair: donorPair(),
      decision: "different_entity",
      reason: "The filing is a Nevada company; the agenda item names a local partnership.",
      actor,
    });

    const map = await loadEntityDecisions(db);
    const pair = donorPair();
    assert.equal(map.get(pairKey(pair))?.decision, "different_entity");
  });

  it("appends the first judgement to the one audit log, with no previous value", async () => {
    // Scoped to the row this run created. `record_corrections` forbids DELETE,
    // so rows from every previous run of this suite are still there — pointing
    // at decision rows that this suite's own cleanup has since removed. A query
    // by table and value would find one of those and assert against it.
    const stored = await db("entity_resolution_decisions")
      .where({ donor_name_filed: DONOR, subject_terms: "aggregate zorbulant" })
      .first();
    assert.ok(stored, "the judgement must have been stored");

    const rows = await db("record_corrections")
      .where({ target_table: "entity_resolution_decisions", target_id: stored.id })
      .orderBy("created_at", "asc");
    assert.equal(rows.length, 1, "one judgement, one audit row");
    assert.equal(rows[0].field, "decision");
    assert.equal(rows[0].new_value, "different_entity");
    // "Was never decided" and "was decided the other way" are different facts.
    assert.equal(rows[0].old_value, null);
    assert.equal(rows[0].operator_email, EMAIL);
    // The log row names a target that exists, including on the first write —
    // the id is generated before the insert precisely so this holds.
    assert.equal(rows[0].target_id, stored.id);
  });

  it("revises in place and logs the previous answer", async () => {
    await recordEntityDecision(db, {
      pair: donorPair(),
      decision: "same_entity",
      reason: "The staff report names the same registration number as the filing.",
      actor,
    });

    // One row per pair, still. A second row would make "has this been decided?"
    // a question with two answers.
    const rows = await db("entity_resolution_decisions").where({
      donor_name_filed: DONOR,
      subject_terms: "aggregate zorbulant",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, "same_entity");

    const log = await db("record_corrections")
      .where({ target_table: "entity_resolution_decisions", target_id: rows[0].id })
      .orderBy("created_at", "asc");
    assert.equal(log.length, 2);
    assert.equal(log[1].old_value, "different_entity");
    assert.equal(log[1].new_value, "same_entity");
  });

  it("lists what has been judged", async () => {
    const listed = await listEntityDecisions(db);
    const mine = listed.find((row) => row.donorNameFiled === DONOR);
    assert.ok(mine);
    assert.equal(mine.decision, "same_entity");
    assert.equal(mine.subjectTerms, "aggregate zorbulant");
  });

  it("refuses a judgement with no stated reason", async () => {
    await assert.rejects(
      recordEntityDecision(db, {
        pair: donorPair(),
        decision: "same_entity",
        reason: "   ",
        actor,
      }),
      /reason is required/,
    );
  });

  it("refuses a reason that asserts a motive", async () => {
    // The log is published. A judgement about two names is a statement about the
    // record; why anybody did anything is not ours to state, here least of all.
    await assert.rejects(
      recordEntityDecision(db, {
        pair: donorPair(),
        decision: "same_entity",
        reason: "Same company — the donation was clearly a bribe to buy the vote.",
        actor,
      }),
      /never the motive/,
    );
  });

  // -------------------------------------------------------------------------
  // Through the console
  // -------------------------------------------------------------------------

  it("serves the stored match and the current judgement on the queue item", async () => {
    const listing = await listQueue(db, { status: "pending_review" });
    const item = listing.data.find((row) => row.finding.id === flagId);
    assert.ok(item);
    // The whole inversion this change exists to fix: the operator sees the band.
    assert.equal(item.evidence?.donorMatch.band, "strong");
    assert.ok((item.evidence?.donorMatch.matchedTerms.length ?? 0) > 0);
    assert.equal(item.entity_decision?.decision, "same_entity");
  });

  it("serves the policy rather than making the console invent one", async () => {
    const listing = await listQueue(db, { status: "pending_review" });
    assert.equal(listing.match_policy.minimumBand, "moderate");
    assert.ok(listing.match_policy.statement.length > 0);
    assert.ok(listing.band_counts.strong >= 1);
    assert.ok(listing.band_counts.weak >= 1);
    assert.ok(listing.band_counts.unbanded >= 1);
  });

  it("filters the queue by the stored band", async () => {
    const listing = await listQueue(db, { status: "pending_review", band: "weak" });
    const ids = listing.data.map((row) => row.finding.id);
    assert.ok(ids.includes(weakFlagId));
    assert.ok(!ids.includes(flagId));
    assert.ok(!ids.includes(nonMatchFlagId));
  });

  it("sorts the most ambiguous first, with unbanded findings last", async () => {
    const listing = await listQueue(db, { status: "pending_review", sort: "weakest_first" });
    const ids = listing.data.map((row) => row.finding.id);
    const weakAt = ids.indexOf(weakFlagId);
    const strongAt = ids.indexOf(flagId);
    const plainAt = ids.indexOf(nonMatchFlagId);
    assert.ok(weakAt >= 0 && strongAt >= 0 && plainAt >= 0);
    assert.ok(weakAt < strongAt, "a weak match must be reachable before a strong one");
    assert.ok(strongAt < plainAt, "a finding with no band is not the least ambiguous one");
  });

  it("records a judgement through the console and keeps the finding held", async () => {
    const res = await request(app)
      .post(`/api/admin/review/queue/${flagId}/entity-resolution`)
      .set("Cookie", cookie)
      .send({
        decision: "same_entity",
        reason: "The agenda packet and the filing give the same registration number.",
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.entity_decision.decision, "same_entity");
    // Judging is not approving.
    assert.equal(res.body.finding.review_state, "held");

    const flag = await db("anomaly_flags").where({ id: flagId }).first();
    assert.equal(flag.review_state, "held");
  });

  it("refuses to judge a finding that carries no name match", async () => {
    const res = await request(app)
      .post(`/api/admin/review/queue/${nonMatchFlagId}/entity-resolution`)
      .set("Cookie", cookie)
      .send({ decision: "same_entity", reason: "Looks right to me." });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /no pair of names to judge/);
  });

  it("refuses an unknown decision", async () => {
    const res = await request(app)
      .post(`/api/admin/review/queue/${flagId}/entity-resolution`)
      .set("Cookie", cookie)
      .send({ decision: "probably", reason: "A reason." });
    assert.equal(res.status, 400);
  });

  it("refuses an anonymous caller", async () => {
    const res = await request(app)
      .post(`/api/admin/review/queue/${flagId}/entity-resolution`)
      .send({ decision: "same_entity", reason: "A reason." });
    assert.equal(res.status, 401);
  });

  it("refuses an invalid band or sort on the queue", async () => {
    const band = await request(app)
      .get("/api/admin/review/queue?band=definite")
      .set("Cookie", cookie);
    assert.equal(band.status, 400);

    const sort = await request(app)
      .get("/api/admin/review/queue?sort=severity")
      .set("Cookie", cookie);
    assert.equal(sort.status, 400);
  });
});

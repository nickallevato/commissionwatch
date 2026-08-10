import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { detectAnomalies } from "../src/services/anomaly-detection";
import {
  correlateVoteDonors,
  describeFinding,
  MINIMUM_MATCH_BAND,
  type CorrelationContribution,
  type CorrelationVote,
} from "../src/services/finance/correlation";
import { parseVoteDonorEvidence, fecDocumentUrl } from "../src/services/finance/evidence";
import { motiveTerms } from "../src/services/review/language";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * `vote_donor_conflict` — the rule that raises it, and the four things it must
 * never do.
 *
 *  1. It must not describe a motive. The record is what somebody did and what
 *     a filing says; the reason is not ours to state.
 *  2. It must not treat one class of donor differently from another.
 *  3. It must not publish itself. Every finding names a living person.
 *  4. It must not build a claim on a record nobody else can look up.
 */

const PREFIX = "vote-donor-test";

const AGENDA_TITLE = "Ridgeline Aggregate gravel supply contract award";

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
    donor_name: "Ridgeline Aggregate LLC",
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

describe("the donor-to-vote rule, as a pure function", () => {
  it("raises one finding per donor per vote", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [contribution()],
    });

    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].flag_type, "vote_donor_conflict");
    assert.equal(drafts[0].agenda_item_id, "33333333-3333-3333-3333-333333333333");
  });

  it("collapses several gifts from one donor into one finding with every citation", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [
        contribution({ id: "aaaaaaaa-0000-0000-0000-000000000001", external_id: "sub-1", amount: 1000, contribution_date: "2026-01-05" }),
        contribution({ id: "aaaaaaaa-0000-0000-0000-000000000002", external_id: "sub-2", amount: 2400, contribution_date: "2026-03-04" }),
      ],
    });

    assert.equal(drafts.length, 1);
    const evidence = parseVoteDonorEvidence(drafts[0].metadata);
    assert.ok(evidence);
    assert.equal(evidence.contributionCount, 2);
    assert.equal(evidence.totalAmount, 3400);
    assert.equal(evidence.earliestContributionDate, "2026-01-05");
    assert.equal(evidence.latestContributionDate, "2026-03-04");
    assert.equal(evidence.contributions.length, 2);
  });

  it("says nothing about a vote the official did not cast", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote({ vote: "absent" })],
      contributions: [contribution()],
    });
    assert.deepEqual(drafts, []);
  });

  it("declines a weak name match rather than reporting it faintly", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote({ agenda_item_title: "Anderson Street sidewalk repair" })],
      contributions: [contribution({ donor_name: "Anderson Ridge Company" })],
    });
    assert.deepEqual(drafts, []);
    assert.equal(MINIMUM_MATCH_BAND, "moderate");
  });

  it("declines when the recipient is a different person with a shared surname", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote({ member_name: "Dana Whitcomb" })],
      contributions: [contribution({ recipient_name: "Priya Whitcomb" })],
    });
    assert.deepEqual(drafts, []);
  });

  it("treats the jurisdiction's own name as carrying no information", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote({ agenda_item_title: "Bozeman street tree replacement programme" })],
      contributions: [contribution({ donor_name: "Bozeman Holdings" })],
      extraGenericTerms: ["Bozeman"],
    });
    assert.deepEqual(drafts, []);
  });

  /**
   * **The sourcing invariant, at the point it would be breached.**
   *
   * A contribution with neither the filing system's identifier nor a document
   * image number cannot be looked up by anybody else. A dollar figure is not a
   * source, so a finding built only from such records is not raised at all.
   */
  it("refuses to build a claim on a record nobody can look up", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [contribution({ external_id: null, image_number: null })],
    });
    assert.deepEqual(drafts, []);
  });

  it("keeps the citable record and drops the uncitable one from the same donor", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [
        contribution({ id: "aaaaaaaa-0000-0000-0000-000000000001", external_id: "sub-1", amount: 1000 }),
        contribution({ id: "aaaaaaaa-0000-0000-0000-000000000002", external_id: null, image_number: null, amount: 9999 }),
      ],
    });

    const evidence = parseVoteDonorEvidence(drafts[0].metadata);
    assert.ok(evidence);
    assert.equal(evidence.contributionCount, 1);
    assert.equal(evidence.totalAmount, 1000);
  });

  it("carries the filing's own identifiers, not just a number", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [contribution()],
    });
    const evidence = parseVoteDonorEvidence(drafts[0].metadata);
    assert.ok(evidence);
    const cited = evidence.contributions[0];
    assert.equal(cited.externalId, "4062020241234567890");
    assert.equal(cited.imageNumber, "202604159876543210");
    assert.match(cited.sourceUrl, /^https:\/\/api\.open\.fec\.gov\//);
    assert.equal(cited.documentUrl, fecDocumentUrl("202604159876543210"));
  });

  it("never puts an API key in the stored provenance", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [contribution()],
    });
    assert.ok(!JSON.stringify(drafts).includes("api_key"));
  });

  it("records the match as a match, with the terms that produced it", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [contribution()],
    });
    const evidence = parseVoteDonorEvidence(drafts[0].metadata);
    assert.ok(evidence);
    assert.equal(evidence.donorMatch.method, "distinctive_term_overlap");
    assert.deepEqual(evidence.donorMatch.matchedTerms, ["ridgeline", "aggregate"]);
    assert.ok(evidence.donorMatch.discardedTerms.includes("llc"));
    // There is no band above `strong`, and nothing may claim identity.
    assert.ok(["weak", "moderate", "strong"].includes(evidence.donorMatch.band));
    assert.ok(["weak", "moderate", "strong"].includes(evidence.recipientMatch.band));
  });

  it("carries the federal-only caveat inside the finding itself", () => {
    const drafts = correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [contribution()],
    });
    const evidence = parseVoteDonorEvidence(drafts[0].metadata);
    assert.ok(evidence);
    assert.match(evidence.coverageNote, /Federal Election Commission/);
  });
});

/**
 * **Uniform treatment across entity classes, asserted at the detector.**
 *
 * The six inputs below differ in exactly one thing: what kind of organisation
 * the donor is. A corporation, a union, a political action committee, a
 * nonprofit foundation, a developer and a trade association, each giving the
 * same amount on the same day to the same recipient, on the same agenda item.
 *
 * The rule must produce the same number of findings, at the same severity, with
 * the same match, and a description that differs only where the filed name
 * appears verbatim. Anything else is a detector that can be pointed at one
 * category, which the project's non-partisanship invariant forbids and which
 * is also what makes a finding indefensible when somebody alleges bias.
 */
describe("every entity class is detected identically", () => {
  const CLASSES = [
    "Ridgeline Aggregate LLC",
    "Ridgeline Aggregate Workers Union Local 7",
    "Ridgeline Aggregate Political Action Committee",
    "Ridgeline Aggregate Foundation",
    "Ridgeline Aggregate Developers Incorporated",
    "Ridgeline Aggregate Trade Association",
  ];

  const results = CLASSES.map((donorName) =>
    correlateVoteDonors({
      meetingId: "55555555-5555-5555-5555-555555555555",
      votes: [vote()],
      contributions: [contribution({ donor_name: donorName })],
    }),
  );

  it("raises exactly one finding for each", () => {
    for (const [index, drafts] of results.entries()) {
      assert.equal(drafts.length, 1, `${CLASSES[index]} produced ${drafts.length} findings`);
    }
  });

  it("assigns the same severity, review state and match to each", () => {
    const first = results[0][0];
    const firstEvidence = parseVoteDonorEvidence(first.metadata);
    assert.ok(firstEvidence);

    for (const [index, drafts] of results.entries()) {
      const draft = drafts[0];
      assert.equal(draft.severity, first.severity, CLASSES[index]);
      assert.equal(draft.review_state, first.review_state, CLASSES[index]);

      const evidence = parseVoteDonorEvidence(draft.metadata);
      assert.ok(evidence);
      assert.equal(evidence.donorMatch.band, firstEvidence.donorMatch.band, CLASSES[index]);
      assert.equal(evidence.donorMatch.score, firstEvidence.donorMatch.score, CLASSES[index]);
      assert.deepEqual(
        evidence.donorMatch.matchedTerms,
        firstEvidence.donorMatch.matchedTerms,
        CLASSES[index],
      );
      assert.equal(evidence.totalAmount, firstEvidence.totalAmount, CLASSES[index]);
    }
  });

  it("produces descriptions identical but for the filed name", () => {
    const normalised = results.map((drafts, index) =>
      drafts[0].description.replaceAll(CLASSES[index], "<DONOR>"),
    );
    for (const [index, description] of normalised.entries()) {
      assert.equal(description, normalised[0], CLASSES[index]);
    }
  });

  it("has no entity-class vocabulary in the rule's own source", () => {
    // The strongest form of the assertion: the detector cannot branch on a
    // category it never names. `name-match.ts` names the categories in order to
    // erase them; `correlation.ts` must not name them at all.
    const source = readRuleSource();
    for (const term of ["union", "nonprofit", "developer", "corporation", "pac"]) {
      assert.ok(
        !new RegExp(`\\b${term}\\b`, "i").test(stripComments(source)),
        `correlation.ts must not branch on "${term}"`,
      );
    }
  });
});

describe("the published sentence", () => {
  const drafts = correlateVoteDonors({
    meetingId: "55555555-5555-5555-5555-555555555555",
    votes: [vote()],
    contributions: [contribution()],
  });
  const evidence = parseVoteDonorEvidence(drafts[0].metadata);

  it("states the record and the arithmetic", () => {
    assert.ok(evidence);
    const text = describeFinding(evidence);
    assert.match(text, /Dana Whitcomb voted yes on agenda item 7/);
    assert.match(text, /\$2,500\.00/);
    assert.match(text, /Ridgeline Aggregate LLC/);
  });

  /**
   * The archive wrote "voted yes on X **after receiving** a contribution from
   * Y". That is a sequence offered for the reader to complete, and it is the
   * sentence this rule exists not to write.
   */
  it("asserts no motive, no sequence and no relationship", () => {
    assert.ok(evidence);
    const text = describeFinding(evidence);
    assert.deepEqual(motiveTerms(text), []);
    for (const phrase of [
      "after receiving",
      "in return",
      "in exchange",
      "benefit",
      "influence",
      "reward",
      "despite",
      "failed to disclose",
    ]) {
      assert.ok(!text.toLowerCase().includes(phrase), `must not say "${phrase}"`);
    }
  });

  it("says in plain words that the link is a name match", () => {
    assert.ok(evidence);
    const text = describeFinding(evidence);
    assert.match(text, /name match, not a verified identity/);
  });
});

/**
 * End to end through `detectAnomalies`, against the real schema.
 */
describe("the rule inside the detection pipeline", () => {
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let meetingId: string;
  let memberId: string;

  before(async () => {
    fixture = await createSource(PREFIX);
    meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });

    const [member] = await db("members")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        name: "Dana Whitcomb",
        title: "Commissioner",
        term_start: "2024-01-01",
      })
      .returning<Array<{ id: string }>>("id");
    memberId = member.id;

    const [item] = await db("agenda_items")
      .insert({ meeting_id: meetingId, item_number: 7, title: AGENDA_TITLE })
      .returning<Array<{ id: string }>>("id");

    await db("votes").insert({
      meeting_id: meetingId,
      agenda_item_id: item.id,
      member_id: memberId,
      vote: "yes",
    });

    await db("campaign_contributions").insert({
      source_system: "openfec",
      jurisdiction_id: fixture.jurisdictionId,
      recipient_name: "Dana Whitcomb",
      committee_name: "Whitcomb for Montana",
      donor_name: "Ridgeline Aggregate LLC",
      amount: 2500,
      contribution_date: "2026-03-04",
      external_id: `${PREFIX}-sub-1`,
      image_number: "202604159876543210",
      source_url: "https://api.open.fec.gov/v1/schedules/schedule_a/?per_page=25",
      raw: JSON.stringify({ contributor_name: "Ridgeline Aggregate LLC" }),
    });
  });

  after(async () => {
    await db("campaign_contributions").where("external_id", "like", `${PREFIX}%`).del();
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  it("raises the flag the enum has carried since migration 020", async () => {
    const flags = await detectAnomalies(db, meetingId);
    const conflicts = flags.filter((flag) => flag.flag_type === "vote_donor_conflict");
    assert.equal(conflicts.length, 1);
  });

  /** Every finding names a person, so every finding is held. */
  it("writes the finding held, never published", async () => {
    const flags = await detectAnomalies(db, meetingId);
    const conflict = flags.find((flag) => flag.flag_type === "vote_donor_conflict");
    assert.ok(conflict);
    assert.equal(conflict.review_state, "held");
  });

  it("is absent from the public findings API until an operator approves it", async () => {
    await detectAnomalies(db, meetingId);
    const response = await request(app).get("/api/anomalies").expect(200);
    const body = response.body as { data: Array<{ id: string; flag_type: string }> };
    const leaked = body.data.filter((flag) => flag.flag_type === "vote_donor_conflict");
    assert.deepEqual(leaked, []);
  });

  it("queues itself for review rather than waiting to be noticed", async () => {
    const flags = await detectAnomalies(db, meetingId);
    const conflict = flags.find((flag) => flag.flag_type === "vote_donor_conflict");
    assert.ok(conflict);
    const queued = await db("approval_requests").where({ anomaly_flag_id: conflict.id }).first();
    assert.ok(queued, "a held finding must reach the queue when it is raised");
  });
});

/* ------------------------------------------------------------------------- */

/**
 * `__dirname`, not `import.meta.url`: tsx transpiles this suite to CommonJS,
 * where `import.meta` is not available to the type checker. See
 * `migrations-selfcontained.test.ts`, which learned the same thing.
 */
function readRuleSource(): string {
  return readFileSync(join(__dirname, "..", "src", "services", "finance", "correlation.ts"), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

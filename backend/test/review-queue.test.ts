import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { findPublicFinding } from "../src/services/publication";
import {
  loadPolicy,
  resolveReviewState,
  severityAtOrAbove,
  updatePolicy,
} from "../src/services/review/policy";
import { metadataHashes, resolveCitations } from "../src/services/review/evidence";
import { motiveTerms } from "../src/services/review/language";
import {
  approveFinding,
  editFinding,
  ensureApprovalRequests,
  getQueueItem,
  listQueue,
  rejectFinding,
  ReviewError,
} from "../src/services/review/queue";
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
 * B-a — the findings review queue.
 *
 * Before this landed there was no code path in the product that set
 * `anomaly_flags.review_state` to `published`, so a held finding could never
 * reach anybody. These tests hold the two directions of that:
 *
 *  - an unapproved or rejected finding appears on **no** public response, and
 *  - approving one, by a named operator with a stated reason and a citation,
 *    is what makes it appear.
 *
 * Nothing here cleans up `record_corrections`: migration 031 forbids DELETE on
 * it, and every assertion is scoped to ids this run generated.
 */

const PREFIX = "review-queue-test";
const EMAIL = "review-queue-test@example.invalid";
const CITED_SHA = sha256Of("review-queue-cited-agenda");
const ORPHAN_SHA = sha256Of("review-queue-orphan-artifact");

/** A phrase no other fixture in the repo contains, so search can be asked about it. */
const HELD_PHRASE = "zorbulant quorum reconciliation";

async function createFlag(options: {
  meetingId: string | null;
  artifactId?: string | null;
  severity: string;
  description: string;
  reviewState: "published" | "held";
  metadata?: Record<string, unknown>;
  flagType?: string;
}): Promise<string> {
  const [row] = await db("anomaly_flags")
    .insert({
      meeting_id: options.meetingId,
      artifact_id: options.artifactId ?? null,
      flag_type: options.flagType ?? "quorum_issue",
      description: options.description,
      severity: options.severity,
      source: "auto",
      review_state: options.reviewState,
      metadata: options.metadata === undefined ? null : JSON.stringify(options.metadata),
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

describe("the findings review queue", () => {
  let cookie: string;
  let fixture: Awaited<ReturnType<typeof createSource>>;
  /** Published meeting, holds a stored agenda: its findings are citable. */
  let citedMeetingId: string;
  /** Published meeting with no stored document at all: nothing to cite. */
  let barrenMeetingId: string;
  /** Unpublished meeting, to prove the wall's second condition. */
  let withheldMeetingId: string;
  let citedArtifactId: string;
  let orphanArtifactId: string;

  const actor = { id: null as string | null, email: "review@example.invalid" };

  before(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([CITED_SHA, ORPHAN_SHA]);

    fixture = await createSource(PREFIX, { enabled: true });
    citedMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
    });
    barrenMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-05",
    });
    withheldMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-08-06",
    });

    citedArtifactId = await createArtifact(
      CITED_SHA,
      "https://example.invalid/review-queue/agenda.pdf",
    );
    orphanArtifactId = await createArtifact(
      ORPHAN_SHA,
      "https://example.invalid/review-queue/loose.pdf",
    );

    const [document] = await db("meeting_documents")
      .insert({
        meeting_id: citedMeetingId,
        title: "Agenda",
        document_type: "agenda",
        url: "https://example.invalid/review-queue/agenda.pdf",
      })
      .returning<Array<{ id: string }>>("id");
    await db("document_versions").insert({
      meeting_document_id: document.id,
      artifact_id: citedArtifactId,
      version_no: 1,
      item_snapshot: JSON.stringify([{ item_number: 1, title: "Consent agenda" }]),
    });

    cookie = await signInOperator(EMAIL, "Review Operator");
    const operator = await db("operators")
      .where({ email: EMAIL })
      .first<{ id: string } | undefined>("id");
    actor.id = operator?.id ?? null;
    actor.email = EMAIL;
  });

  after(async () => {
    // anomaly_flags cascade from meetings; record_corrections deliberately does
    // not, and cannot be cleaned.
    await db("approval_requests")
      .whereIn(
        "anomaly_flag_id",
        db("anomaly_flags").select("id").whereIn("meeting_id", [
          citedMeetingId,
          barrenMeetingId,
          withheldMeetingId,
        ]),
      )
      .del();
    await db("anomaly_flags").whereIn("artifact_id", [citedArtifactId, orphanArtifactId]).del();
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([CITED_SHA, ORPHAN_SHA]);
    await db("operators").where({ email: EMAIL }).del();
    await db.destroy();
  });

  // -------------------------------------------------------------------------
  // The threshold — B-b's replacement
  // -------------------------------------------------------------------------

  describe("the severity threshold", () => {
    it("ships one row, holding at high", async () => {
      const policy = await loadPolicy(db);
      assert.equal(policy.hold_at_or_above, "high");
      assert.equal(policy.review_window_hours, 72);
      const rows = await db("review_policy").count("* as total").first<{ total?: string }>();
      assert.equal(Number(rows?.total ?? 0), 1);
    });

    it("refuses a second policy row rather than leaving two answers in force", async () => {
      await assert.rejects(() => db("review_policy").insert({ singleton: true }));
    });

    it("compares at or above, and treats an unknown severity as below", () => {
      assert.equal(severityAtOrAbove("critical", "high"), true);
      assert.equal(severityAtOrAbove("high", "high"), true);
      assert.equal(severityAtOrAbove("medium", "high"), false);
      assert.equal(severityAtOrAbove("catastrophic", "high"), false);
    });

    it("can only add holds — a rule that held a finding always wins", () => {
      const policy = { hold_at_or_above: "critical" as const };
      // Below the threshold, but the detector held it because it names a
      // person. Nothing naming a person auto-publishes, at any threshold.
      assert.equal(resolveReviewState({ severity: "low", alwaysHold: true }, policy), "held");
      assert.equal(resolveReviewState({ severity: "low", alwaysHold: false }, policy), "published");
      assert.equal(
        resolveReviewState({ severity: "critical", alwaysHold: false }, policy),
        "held",
      );
    });

    it("logs a threshold change to the one audit table, and needs a reason", async () => {
      await assert.rejects(
        () => updatePolicy(db, { holdAtOrAbove: "medium" }, "  ", actor),
        (err: unknown) => err instanceof Error && /reason is required/.test(err.message),
      );

      const before_ = await loadPolicy(db);
      const updated = await updatePolicy(
        db,
        { holdAtOrAbove: "medium" },
        "Widened while the queue is small enough to read every day.",
        actor,
      );
      assert.equal(updated.hold_at_or_above, "medium");
      assert.equal(updated.updated_by_email, EMAIL);

      const logged = await db("record_corrections")
        .where({ target_table: "review_policy", target_id: before_.id, field: "hold_at_or_above" })
        .orderBy("created_at", "desc")
        .first<{ old_value: string; new_value: string; operator_email: string } | undefined>();
      assert.equal(logged?.old_value, before_.hold_at_or_above);
      assert.equal(logged?.new_value, "medium");
      assert.equal(logged?.operator_email, EMAIL);

      // Put it back: every later assertion assumes the shipped default.
      await updatePolicy(db, { holdAtOrAbove: "high" }, "Restoring the default.", actor);
    });
  });

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  describe("claim-to-citation binding", () => {
    it("reads a sha256 out of nested metadata, and ignores one under another key", () => {
      const hashes = metadataHashes({
        from_sha256: CITED_SHA,
        nested: { to_sha256: ORPHAN_SHA.toUpperCase() },
        // Not a citation: a hash-shaped string under a key that is not a hash.
        external_id: ORPHAN_SHA.replace("a", "b"),
      });
      assert.equal(hashes.length, 2);
      assert.ok(hashes.includes(CITED_SHA));
      assert.ok(hashes.includes(ORPHAN_SHA));
    });

    it("cites the flag's own artifact, a metadata hash, and the meeting's documents", async () => {
      const direct = await resolveCitations(db, {
        id: "x",
        meeting_id: null,
        artifact_id: orphanArtifactId,
        metadata: null,
      });
      assert.deepEqual(
        direct.map((c) => c.kind),
        ["flag_artifact"],
      );

      const byHash = await resolveCitations(db, {
        id: "x",
        meeting_id: null,
        artifact_id: null,
        metadata: { to_sha256: CITED_SHA },
      });
      assert.equal(byHash[0].kind, "metadata_sha256");
      assert.equal(byHash[0].sha256, CITED_SHA);
      // The left join supplies the document for display without deciding
      // whether the citation exists.
      assert.equal(byHash[0].document_title, "Agenda");
      assert.equal(byHash[0].version_no, 1);

      const byMeeting = await resolveCitations(db, {
        id: "x",
        meeting_id: citedMeetingId,
        artifact_id: null,
        metadata: null,
      });
      assert.equal(byMeeting.length, 1);
      assert.equal(byMeeting[0].kind, "meeting_document");
      assert.equal(byMeeting[0].sha256, CITED_SHA);
    });

    it("returns nothing for a meeting with no stored document", async () => {
      const none = await resolveCitations(db, {
        id: "x",
        meeting_id: barrenMeetingId,
        artifact_id: null,
        metadata: null,
      });
      assert.deepEqual(none, []);
    });
  });

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  describe("the queue", () => {
    it("is closed without a session", async () => {
      await request(app).get("/api/admin/review/queue").expect(401);
      await request(app).get("/api/admin/review/policy").expect(401);
      await request(app)
        .post(`/api/admin/review/queue/${"0".repeat(8)}-0000-4000-8000-000000000000/approve`)
        .send({ reason: "no" })
        .expect(401);
    });

    it("enqueues every held finding, whoever wrote it", async () => {
      const flagId = await createFlag({
        meetingId: citedMeetingId,
        severity: "high",
        description: `Only 2 of 5 members present — ${HELD_PHRASE}`,
        reviewState: "held",
      });

      // Written straight into the table with no request row, the way a detector
      // that predates the queue would.
      const created = await ensureApprovalRequests(db);
      assert.ok(created >= 1);

      const item = await getQueueItem(db, flagId);
      assert.ok(item);
      assert.equal(item.request.status, "pending_review");
      assert.equal(item.request.severity, "high");
      assert.equal(item.finding.review_state, "held");
      assert.equal(item.context.commission_name, `${PREFIX} Commission`);
      assert.ok(item.citations.length > 0);

      // Idempotent: one flag, one request.
      assert.equal(await ensureApprovalRequests(db), 0);
    });

    it("dates the review window from when the finding was raised", async () => {
      const item = await listQueue(db, {});
      assert.ok(item.data.length > 0);
      const first = item.data[0];
      const raised = new Date(first.finding.created_at).getTime();
      const expires = new Date(first.request.expires_at).getTime();
      assert.equal(Math.round((expires - raised) / 3_600_000), item.policy.review_window_hours);
    });

    it("reports an elapsed window as overdue and leaves the finding held", async () => {
      const flagId = await createFlag({
        meetingId: citedMeetingId,
        severity: "critical",
        description: "Only 1 of 5 members present",
        reviewState: "held",
      });
      await ensureApprovalRequests(db);
      // The window is a marker, not a decision. Nothing writes a status when it
      // passes, so the test moves the boundary rather than the clock.
      await db("approval_requests")
        .where({ anomaly_flag_id: flagId })
        .update({ expires_at: new Date(Date.now() - 3_600_000) });

      const item = await getQueueItem(db, flagId);
      assert.equal(item?.request.overdue, true);
      assert.equal(item?.request.status, "pending_review");
      // The whole point: an expired request publishes nothing.
      assert.equal(item?.finding.review_state, "held");
      assert.equal(await findPublicFinding(db, flagId), undefined);

      const listing = await listQueue(db, {});
      assert.ok(listing.counts.overdue >= 1);
      // Overdue sorts first.
      assert.equal(listing.data[0].finding.id, flagId);

      await db("approval_requests").where({ anomaly_flag_id: flagId }).del();
      await db("anomaly_flags").where({ id: flagId }).del();
    });
  });

  // -------------------------------------------------------------------------
  // Deciding
  // -------------------------------------------------------------------------

  describe("approval", () => {
    it("refuses a finding that cites no stored artifact", async () => {
      const flagId = await createFlag({
        meetingId: barrenMeetingId,
        severity: "high",
        description: "Minutes not published 40 days after meeting",
        reviewState: "held",
      });
      await ensureApprovalRequests(db);

      await assert.rejects(
        () =>
          approveFinding(db, {
            flagId,
            reason: "Reads correctly against the record.",
            actor,
          }),
        (err: unknown) =>
          err instanceof ReviewError &&
          err.statusCode === 409 &&
          /No unsourced claim/.test(err.message),
      );

      const still = await db("anomaly_flags")
        .where({ id: flagId })
        .first<{ review_state: string } | undefined>("review_state");
      assert.equal(still?.review_state, "held");
    });

    it("refuses a decision with no stated reason", async () => {
      const flagId = await createFlag({
        meetingId: citedMeetingId,
        severity: "high",
        description: "Only 2 of 5 members present",
        reviewState: "held",
      });
      await ensureApprovalRequests(db);
      await assert.rejects(
        () => approveFinding(db, { flagId, reason: "   ", actor }),
        (err: unknown) => err instanceof ReviewError && err.statusCode === 400,
      );
      await db("approval_requests").where({ anomaly_flag_id: flagId }).del();
      await db("anomaly_flags").where({ id: flagId }).del();
    });

    it("publishes the finding, names the operator, and logs the decision", async () => {
      const flagId = await createFlag({
        meetingId: citedMeetingId,
        severity: "high",
        description: "Only 2 of 5 members present (quorum requires 3)",
        reviewState: "held",
      });
      await ensureApprovalRequests(db);
      assert.equal(await findPublicFinding(db, flagId), undefined);

      const item = await approveFinding(db, {
        flagId,
        reason: "Checked against the stored agenda; the arithmetic holds.",
        actor,
      });

      assert.equal(item.request.status, "approved");
      assert.equal(item.request.reviewer_email, EMAIL);
      assert.ok(item.request.reviewed_at);
      assert.equal(item.finding.review_state, "published");

      const logged = await db("record_corrections")
        .where({ target_table: "anomaly_flags", target_id: flagId, field: "review_state" })
        .first<{ old_value: string; new_value: string; operator_email: string; reason: string }>();
      assert.equal(logged.old_value, "held");
      assert.equal(logged.new_value, "published");
      assert.equal(logged.operator_email, EMAIL);
      assert.match(logged.reason, /arithmetic holds/);

      // Approval is what makes it public.
      const publicRow = await findPublicFinding(db, flagId);
      assert.equal(publicRow?.id, flagId);
      await request(app).get(`/api/anomalies/${flagId}`).expect(200);
    });

    it("refuses to decide the same request twice", async () => {
      const flagId = await createFlag({
        meetingId: citedMeetingId,
        severity: "high",
        description: "Only 2 of 5 members present (quorum requires 3)",
        reviewState: "held",
      });
      await ensureApprovalRequests(db);
      await approveFinding(db, { flagId, reason: "Reads correctly.", actor });
      await assert.rejects(
        () => approveFinding(db, { flagId, reason: "Again.", actor }),
        (err: unknown) => err instanceof ReviewError && err.statusCode === 409,
      );
    });
  });

  describe("rejection", () => {
    it("leaves the finding held and unpublishable, and cannot be reversed by approving", async () => {
      const flagId = await createFlag({
        meetingId: citedMeetingId,
        severity: "high",
        description: `Only 4 of 5 members present — ${HELD_PHRASE}`,
        reviewState: "held",
      });
      await ensureApprovalRequests(db);

      const item = await rejectFinding(db, {
        flagId,
        reason: "The roster used the wrong term dates; the quorum figure is wrong.",
        actor,
      });
      assert.equal(item.request.status, "rejected");
      // There is no `rejected` review state and there does not need to be.
      assert.equal(item.finding.review_state, "held");
      assert.equal(await findPublicFinding(db, flagId), undefined);

      await assert.rejects(
        () => approveFinding(db, { flagId, reason: "Changed my mind." , actor }),
        (err: unknown) => err instanceof ReviewError && err.statusCode === 409,
      );

      const logged = await db("record_corrections")
        .where({ target_table: "anomaly_flags", target_id: flagId, field: "review_decision" })
        .first<{ new_value: string; operator_email: string } | undefined>();
      assert.equal(logged?.new_value, "rejected");
      assert.equal(logged?.operator_email, EMAIL);
    });
  });

  describe("edit with reason", () => {
    it("refuses text asserting intent, corruption or illegality", () => {
      assert.deepEqual(motiveTerms("Only 2 of 5 members were present"), []);
      // The vocabulary of elapsed time is not forbidden — a finding may say a
      // document was published 90 days later. Motive is.
      assert.deepEqual(motiveTerms("Minutes were published 90 days after the meeting"), []);
      assert.ok(motiveTerms("The board deliberately concealed the award").length >= 2);
      // Word-bounded: "criminal" must not be found inside another word.
      assert.deepEqual(motiveTerms("discriminals"), []);
    });

    it("rewrites the description, logs it, and keeps the finding held", async () => {
      const flagId = await createFlag({
        meetingId: citedMeetingId,
        severity: "high",
        description: "Only 2 of 5 members present",
        reviewState: "held",
      });
      await ensureApprovalRequests(db);

      await assert.rejects(
        () =>
          editFinding(db, {
            flagId,
            field: "description",
            newValue: "The commission illegally voted without a quorum",
            reason: "Sharper.",
            actor,
          }),
        (err: unknown) =>
          err instanceof ReviewError && err.statusCode === 400 && /never the motive/.test(err.message),
      );

      await assert.rejects(
        () =>
          editFinding(db, {
            flagId,
            field: "metadata",
            newValue: "{}",
            reason: "No.",
            actor,
          }),
        (err: unknown) => err instanceof ReviewError && err.statusCode === 400,
      );

      const item = await editFinding(db, {
        flagId,
        field: "description",
        newValue: "Two of five seated members were recorded present; quorum is three.",
        reason: "The original omitted that the count is of seated members.",
        actor,
      });
      assert.match(item.finding.description, /seated members/);
      assert.equal(item.finding.review_state, "held");
      assert.equal(item.request.status, "pending_review");

      const logged = await db("record_corrections")
        .where({ target_table: "anomaly_flags", target_id: flagId, field: "description" })
        .first<{ old_value: string; operator_email: string } | undefined>();
      assert.equal(logged?.old_value, "Only 2 of 5 members present");
      assert.equal(logged?.operator_email, EMAIL);

      await db("approval_requests").where({ anomaly_flag_id: flagId }).del();
      await db("anomaly_flags").where({ id: flagId }).del();
    });
  });

  // -------------------------------------------------------------------------
  // The wall
  // -------------------------------------------------------------------------

  describe("the publication wall", () => {
    let heldId: string;
    let withheldMeetingFlagId: string;

    before(async () => {
      heldId = await createFlag({
        meetingId: citedMeetingId,
        severity: "high",
        description: `Held finding — ${HELD_PHRASE}`,
        reviewState: "held",
      });
      // Approved, but its meeting is not published. The second half of the
      // wall: `/api/anomalies` is the one public route that does not take a
      // meeting id, so before B-a this row leaked both the meeting's existence
      // and a sentence of its content.
      withheldMeetingFlagId = await createFlag({
        meetingId: withheldMeetingId,
        severity: "low",
        description: `Withheld meeting finding — ${HELD_PHRASE}`,
        reviewState: "published",
      });
      await ensureApprovalRequests(db);
    });

    it("keeps a held finding off /api/anomalies, in the list and by id", async () => {
      const res = await request(app).get("/api/anomalies?limit=200").expect(200);
      const ids = res.body.data.map((row: { id: string }) => row.id);
      assert.equal(ids.includes(heldId), false);
      await request(app).get(`/api/anomalies/${heldId}`).expect(404);
      const descriptions = res.body.data.map((row: { description: string }) => row.description);
      assert.equal(
        descriptions.some((text: string) => text.includes(HELD_PHRASE)),
        false,
      );
    });

    it("keeps an approved finding on an unpublished meeting off /api/anomalies too", async () => {
      const res = await request(app).get("/api/anomalies?limit=200").expect(200);
      const ids = res.body.data.map((row: { id: string }) => row.id);
      assert.equal(ids.includes(withheldMeetingFlagId), false);
      await request(app).get(`/api/anomalies/${withheldMeetingFlagId}`).expect(404);
    });

    it("keeps a held finding off both per-meeting anomaly routes", async () => {
      for (const path of [
        `/api/anomalies/meeting/${citedMeetingId}`,
        `/api/meetings/${citedMeetingId}/anomalies`,
      ]) {
        const res = await request(app).get(path).expect(200);
        const ids = res.body.data.map((row: { id: string }) => row.id);
        assert.equal(ids.includes(heldId), false, `${path} exposed a held finding`);
      }
    });

    it("keeps a held finding out of /api/search entirely", async () => {
      // Findings are not indexed at all — search reads agenda items, meetings,
      // members and document text. This asserts that stays true, because search
      // is the only public surface that takes a word rather than a meeting id.
      const res = await request(app)
        .get(`/api/search?q=${encodeURIComponent(HELD_PHRASE)}`)
        .expect(200);
      assert.equal(res.body.total, 0);
      assert.deepEqual(res.body.data, []);
    });

    it("keeps the agenda diff of an unpublished meeting unreachable", async () => {
      await request(app).get(`/api/meetings/${withheldMeetingId}/agenda-diff`).expect(404);
      // And the published meeting's diff answers, so the assertion above is
      // about publication rather than about the route being broken.
      await request(app).get(`/api/meetings/${citedMeetingId}/agenda-diff`).expect(200);
    });

    it("shows the operator what the public cannot see", async () => {
      const res = await request(app)
        .get("/api/admin/review/queue?status=pending_review")
        .set("Cookie", cookie)
        .expect(200);
      const ids = res.body.data.map((row: { finding: { id: string } }) => row.finding.id);
      assert.ok(ids.includes(heldId));
      assert.equal(typeof res.body.policy.hold_at_or_above, "string");
    });
  });

  // -------------------------------------------------------------------------
  // Over the wire
  // -------------------------------------------------------------------------

  describe("the API", () => {
    it("approves over HTTP and records the signed-in operator", async () => {
      const flagId = await createFlag({
        meetingId: citedMeetingId,
        severity: "high",
        description: "Executive session item carried 5 recorded votes",
        reviewState: "held",
        flagType: "closed_door_vote",
      });
      await ensureApprovalRequests(db);

      await request(app)
        .post(`/api/admin/review/queue/${flagId}/approve`)
        .set("Cookie", cookie)
        .send({})
        .expect(400);

      const res = await request(app)
        .post(`/api/admin/review/queue/${flagId}/approve`)
        .set("Cookie", cookie)
        .send({ reason: "The votes are in the stored agenda." })
        .expect(200);

      assert.equal(res.body.request.status, "approved");
      assert.equal(res.body.request.reviewer_email, EMAIL);
      assert.equal(res.body.finding.review_state, "published");
      await request(app).get(`/api/anomalies/${flagId}`).expect(200);
    });

    it("400s an unparseable id rather than searching for it", async () => {
      await request(app)
        .get("/api/admin/review/queue/not-a-uuid")
        .set("Cookie", cookie)
        .expect(400);
    });

    it("404s a finding that does not exist", async () => {
      await request(app)
        .get("/api/admin/review/queue/00000000-0000-4000-8000-000000000000")
        .set("Cookie", cookie)
        .expect(404);
    });

    it("serves and updates the threshold", async () => {
      const before_ = await request(app)
        .get("/api/admin/review/policy")
        .set("Cookie", cookie)
        .expect(200);
      assert.equal(before_.body.hold_at_or_above, "high");

      await request(app)
        .put("/api/admin/review/policy")
        .set("Cookie", cookie)
        .send({ hold_at_or_above: "extreme", reason: "no such severity" })
        .expect(400);

      await request(app)
        .put("/api/admin/review/policy")
        .set("Cookie", cookie)
        .send({ hold_at_or_above: "critical" })
        .expect(400);

      const res = await request(app)
        .put("/api/admin/review/policy")
        .set("Cookie", cookie)
        .send({ hold_at_or_above: "critical", reason: "Narrowing while the backlog clears." })
        .expect(200);
      assert.equal(res.body.hold_at_or_above, "critical");

      await request(app)
        .put("/api/admin/review/policy")
        .set("Cookie", cookie)
        .send({ hold_at_or_above: "high", reason: "Restoring the default." })
        .expect(200);
    });
  });
});

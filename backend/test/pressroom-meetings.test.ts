import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { extractAgendaItems } from "../src/services/ingestion/agenda-items";
import { upsertAgendaItems } from "../src/services/ingestion/handlers";
import { getMeetingDetail, readFieldConfidence } from "../src/services/pressroom/meetings";
import {
  cleanupByPrefix,
  createArtifact,
  createJob,
  createMeeting,
  createRun,
  createSource,
  deleteArtifacts,
  sha256Of,
  signInOperator,
} from "./helpers/pressroom";

/**
 * The meeting screen — decision 6, and the console's view of an unpublished row.
 *
 * Confidence is per field. Seven good agenda items and one mangled one is not a
 * low-confidence meeting, and a record-level score would say it was — about the
 * seven that are fine as much as about the one that is not.
 */

const PREFIX = "pressroom-meetings-test";
const EMAIL = "pressroom-meetings-test@example.invalid";
const SHA = sha256Of("pressroom-meetings");

describe("agenda item confidence", () => {
  it("marks a truncated title low, and says which column cut it", () => {
    const { items } = extractAgendaItems(["AGENDA", `1. ${"x".repeat(400)}`]);
    assert.equal(items[0].confidence.title.level, "low");
    assert.match(items[0].confidence.title.reason, /255/);
  });

  it("marks a good title high without dragging the item's other fields down", () => {
    const { items } = extractAgendaItems([
      "AGENDA",
      "III. OLD BUSINESS",
      "1. Outstanding Noxious Weed Management Award",
    ]);
    assert.equal(items[0].confidence.title.level, "high");
    assert.equal(items[0].confidence.category.level, "high");
  });

  it("marks a missing section low on `category` alone", () => {
    const { items } = extractAgendaItems(["AGENDA", "1. Claims and payroll"]);
    assert.equal(items[0].confidence.category.level, "low");
    // The title is fine. This is the whole point of per-field marks: one weak
    // field must not condemn the ones beside it.
    assert.equal(items[0].confidence.title.level, "high");
  });

  it("drops to medium on every title when the document never says it is an agenda", () => {
    const { items } = extractAgendaItems(["1. Claims and payroll"]);
    assert.equal(items[0].confidence.title.level, "medium");
  });

  it("says nothing about a description the item does not have", () => {
    const { items } = extractAgendaItems(["AGENDA", "1. Claims and payroll"]);
    assert.equal("description" in items[0].confidence, false);
  });

  it("marks a captured description high", () => {
    const { items } = extractAgendaItems([
      "AGENDA",
      "1. Coordinators Report",
      "- Grants Update",
    ]);
    assert.equal(items[0].confidence.description?.level, "high");
  });

  it("reads a stored map back, and drops a mark it cannot understand", () => {
    assert.deepEqual(readFieldConfidence('{"title":{"level":"low","reason":"why"}}'), {
      title: { level: "low", reason: "why" },
    });
    // An unreadable mark rendered as an empty chip would read as "assessed and
    // fine", which is the one thing it does not mean.
    assert.deepEqual(readFieldConfidence({ title: "low" }), {});
    assert.deepEqual(readFieldConfidence("not json"), {});
  });
});

describe("pressroom meeting detail", () => {
  let cookie: string;
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let meetingId: string;

  before(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([SHA]);

    fixture = await createSource(PREFIX, { enabled: true });
    // Deliberately unpublished: the console is the one surface that can see it.
    meetingId = await createMeeting(fixture.commissionId, { publishedAt: null });

    const { items } = extractAgendaItems([
      "AGENDA",
      "III. OLD BUSINESS",
      "1. Outstanding Noxious Weed Management Award",
      `2. ${"x".repeat(400)}`,
    ]);
    await upsertAgendaItems(db, meetingId, items);

    await db("meeting_documents").insert({
      meeting_id: meetingId,
      title: "August 4 Agenda",
      document_type: "agenda",
      url: "https://example.invalid/pressroom-meetings/agenda.pdf",
    });

    await createArtifact(SHA, "https://example.invalid/pressroom-meetings/agenda.pdf");
    const runId = await createRun(fixture.sourceId, { status: "succeeded", counts: { parsed: 1 } });
    await createJob(runId, "parse", { sha256: SHA, meetingId, documentType: "agenda" });

    cookie = await signInOperator(EMAIL, "Meetings Operator");
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([SHA]);
    await db("operators").where({ email: EMAIL }).del();
    await db.destroy();
  });

  it("is closed without a session", async () => {
    await request(app).get(`/api/admin/pressroom/meetings/${meetingId}`).expect(401);
  });

  it("shows an unpublished meeting, which no public route will", async () => {
    const detail = await getMeetingDetail(db, meetingId);
    assert.ok(detail);
    assert.equal(detail.meeting.published_at, null);
  });

  it("names the commission and the jurisdiction", async () => {
    const detail = await getMeetingDetail(db, meetingId);
    assert.ok(detail);
    assert.match(detail.commission.name, new RegExp(PREFIX));
    assert.equal(detail.jurisdiction.state, "MT");
  });

  it("persists per-field confidence through the upsert and reads it back", async () => {
    const detail = await getMeetingDetail(db, meetingId);
    assert.ok(detail);
    assert.equal(detail.agenda_items.length, 2);
    assert.equal(detail.agenda_items[0].field_confidence.title.level, "high");
    assert.equal(detail.agenda_items[1].field_confidence.title.level, "low");
    assert.match(detail.agenda_items[1].field_confidence.title.reason, /255/);
  });

  it("resolves the artifacts a re-parse would replay, through the parse job", async () => {
    const detail = await getMeetingDetail(db, meetingId);
    assert.ok(detail);
    assert.equal(detail.artifacts.length, 1);
    assert.equal(detail.artifacts[0].sha256, SHA);
    assert.equal(detail.documents.length, 1);
  });

  it("renders with zero rows rather than erroring", async () => {
    const bare = await createMeeting(fixture.commissionId, { publishedAt: null, date: "2026-08-05" });
    const detail = await getMeetingDetail(db, bare);
    assert.ok(detail);
    assert.deepEqual(detail.agenda_items, []);
    assert.deepEqual(detail.artifacts, []);
    assert.deepEqual(detail.corrections, []);
  });

  it("404s a meeting that does not exist", async () => {
    await request(app)
      .get("/api/admin/pressroom/meetings/00000000-0000-4000-8000-000000000000")
      .set("Cookie", cookie)
      .expect(404);
  });

  it("serves the detail over the API", async () => {
    const res = await request(app)
      .get(`/api/admin/pressroom/meetings/${meetingId}`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(res.body.meeting.published_at, null);
    assert.equal(res.body.agenda_items.length, 2);
  });
});

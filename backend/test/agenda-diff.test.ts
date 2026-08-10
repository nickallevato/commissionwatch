import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  DEFAULT_AGENDA_CHANGE_WINDOW_HOURS,
  agendaChangeFlags,
  buildTimelines,
  diffAgendaItems,
  loadDocumentTimelines,
  normalizeTitle,
  parseItemSnapshot,
  scheduledInstant,
  snapshotFromDrafts,
  summariseChanges,
  type TimelineRow,
  type VersionItem,
} from "../src/services/agenda-diff";
import { checkLastMinuteAgendaChange } from "../src/services/anomaly-detection";
import {
  recordDocumentVersion,
  recordVersionSnapshot,
} from "../src/services/ingestion/handlers";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
} from "./helpers/pressroom";

/**
 * P5 · The agenda diff timeline.
 *
 * Three things are proved here, in this order:
 *
 * 1. **The diff is over agenda items, not bytes.** Every pure-function case
 *    below compares extracted text. Nothing in this feature ever asks whether
 *    two PDFs differ, because two renderings of an identical agenda do, for
 *    reasons no reader cares about.
 * 2. **Version history is a consequence of the constraints.** Recording the
 *    same artifact against the same document twice creates one row, because
 *    `unique (meeting_document_id, artifact_id)` says so — not because anything
 *    checked first.
 * 3. **The publication wall holds.** An unpublished meeting's diff is not
 *    publicly reachable. This is the most quotable output the project produces,
 *    so it is the worst place for the review gate to have a hole.
 */

const PREFIX = "agenda-diff-test";

const HASHES: string[] = [];

/** A suite-owned artifact whose hash is derived from `seed`. */
async function artifact(seed: string): Promise<{ id: string; sha256: string }> {
  const sha256 = sha256Of(`${PREFIX}-${seed}`);
  HASHES.push(sha256);
  const id = await createArtifact(sha256, `https://example.invalid/${seed}`);
  return { id, sha256 };
}

async function createDocument(
  meetingId: string,
  url: string,
  title = "Agenda",
  documentType = "agenda",
): Promise<string> {
  const [row] = await db("meeting_documents")
    .insert({
      meeting_id: meetingId,
      title,
      document_type: documentType,
      url,
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

const ROLL_CALL: VersionItem = { item_number: 1, title: "Roll call" };
const BUDGET: VersionItem = { item_number: 2, title: "FY27 budget resolution" };
const REZONE: VersionItem = { item_number: 3, title: "Rezone 400 N Wallace" };

/* ------------------------------------------------------------------ pure */

describe("diffAgendaItems", () => {
  it("reports nothing when the extracted items are identical", () => {
    assert.deepEqual(diffAgendaItems([ROLL_CALL, BUDGET], [ROLL_CALL, BUDGET]), []);
  });

  it("ignores case and whitespace, which are extraction artefacts", () => {
    const noisy: VersionItem = { item_number: 1, title: "  ROLL   call\n" };
    assert.deepEqual(diffAgendaItems([ROLL_CALL], [noisy]), []);
    assert.equal(normalizeTitle("  ROLL   call\n"), "roll call");
  });

  it("reports an item that appears only in the newer version as added", () => {
    const changes = diffAgendaItems([ROLL_CALL], [ROLL_CALL, REZONE]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "added");
    assert.equal(changes[0].item_number, 3);
    assert.equal(changes[0].title, "Rezone 400 N Wallace");
  });

  it("reports an item that appears only in the older version as removed", () => {
    const changes = diffAgendaItems([ROLL_CALL, REZONE], [ROLL_CALL]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "removed");
    assert.equal(changes[0].title, "Rezone 400 N Wallace");
  });

  it("pairs a removal and an addition on the same item number as a retitle", () => {
    const changes = diffAgendaItems(
      [{ item_number: 2, title: "Budget resolution" }],
      [{ item_number: 2, title: "FY27 budget resolution" }],
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "retitled");
    assert.equal(changes[0].previous_title, "Budget resolution");
    assert.equal(changes[0].title, "FY27 budget resolution");
  });

  it("does not pair a removal with an addition at a different number", () => {
    // Guessing which removal "became" which addition would put an invented
    // relationship into the published record.
    const changes = diffAgendaItems(
      [{ item_number: 2, title: "Budget resolution" }],
      [{ item_number: 7, title: "FY27 budget resolution" }],
    );
    assert.equal(changes.length, 2);
    assert.deepEqual(
      changes.map((change) => change.kind).sort(),
      ["added", "removed"],
    );
  });

  it("does not report an item that only moved position", () => {
    const changes = diffAgendaItems(
      [
        { item_number: 1, title: "Roll call" },
        { item_number: 2, title: "Rezone 400 N Wallace" },
      ],
      [
        { item_number: 1, title: "Rezone 400 N Wallace" },
        { item_number: 2, title: "Roll call" },
      ],
    );
    assert.deepEqual(changes, []);
  });

  it("handles an emptied agenda without inventing a retitle", () => {
    const changes = diffAgendaItems([ROLL_CALL, BUDGET], []);
    assert.equal(changes.length, 2);
    assert.ok(changes.every((change) => change.kind === "removed"));
  });
});

describe("summariseChanges", () => {
  it("counts each kind in a fixed order, singular and plural", () => {
    const changes = diffAgendaItems([ROLL_CALL, BUDGET], [ROLL_CALL, REZONE]);
    assert.equal(summariseChanges(changes), "1 item added, 1 item removed");
  });

  it("says so plainly when nothing changed", () => {
    assert.equal(summariseChanges([]), "no change to the extracted items");
  });
});

describe("parseItemSnapshot", () => {
  it("reads a well-formed snapshot", () => {
    assert.deepEqual(parseItemSnapshot([{ item_number: 1, title: "Roll call" }]), [ROLL_CALL]);
  });

  it("treats a missing snapshot as unknown, never as an empty agenda", () => {
    // The two are different claims: one is a gap in what we know, the other is
    // an assertion that the body had nothing on its agenda.
    assert.equal(parseItemSnapshot(null), null);
    assert.equal(parseItemSnapshot(undefined), null);
    assert.deepEqual(parseItemSnapshot([]), []);
  });

  it("rejects a malformed row rather than reading half of it", () => {
    assert.equal(parseItemSnapshot([{ item_number: "1", title: "x" }]), null);
    assert.equal(parseItemSnapshot([{ title: "x" }]), null);
    assert.equal(parseItemSnapshot(["Roll call"]), null);
    assert.equal(parseItemSnapshot({ item_number: 1 }), null);
  });
});

describe("snapshotFromDrafts", () => {
  it("keeps the number and the title, and drops the rest", () => {
    assert.deepEqual(
      snapshotFromDrafts([
        { itemNumber: 1, title: "Roll call", description: "x", category: null } as never,
      ]),
      [ROLL_CALL],
    );
  });
});

describe("scheduledInstant", () => {
  it("composes date and time in the jurisdiction's zone, not the server's", () => {
    // 2 p.m. Mountain Daylight Time on 4 August is 20:00 UTC. Composing this in
    // UTC would put it six hours out, which against a 48-hour window is the
    // difference between a flag and a false statement.
    const at = scheduledInstant("2026-08-04", "14:00:00", "America/Denver");
    assert.ok(at);
    assert.equal(at.toISOString(), "2026-08-04T20:00:00.000Z");
  });

  it("uses standard time on the winter side of the DST boundary", () => {
    const at = scheduledInstant("2026-01-14", "14:00", "America/Denver");
    assert.ok(at);
    assert.equal(at.toISOString(), "2026-01-14T21:00:00.000Z");
  });

  it("accepts the local-midnight Date that pg returns for a bare DATE", () => {
    const at = scheduledInstant(new Date(2026, 7, 4), "14:00:00", "America/Denver");
    assert.ok(at);
    assert.equal(at.toISOString(), "2026-08-04T20:00:00.000Z");
  });

  it("returns null when the meeting publishes no time", () => {
    // A meeting with no published hour has no known hour. Assuming midnight
    // would manufacture the very number the finding reports.
    assert.equal(scheduledInstant("2026-08-04", null, "America/Denver"), null);
    assert.equal(scheduledInstant("2026-08-04", undefined, "America/Denver"), null);
  });

  it("returns null rather than an instant for an unknown zone", () => {
    assert.equal(scheduledInstant("2026-08-04", "14:00", "Mars/Olympus_Mons"), null);
  });
});

describe("agendaChangeFlags", () => {
  const scheduledAt = new Date("2026-08-04T20:00:00.000Z");

  function pairTimeline(toFirstSeen: string, to: VersionItem[]) {
    const from = {
      id: "v1",
      version_no: 1,
      first_seen_at: "2026-07-20T12:00:00.000Z",
      sha256: "a".repeat(64),
      byte_size: 10,
      item_count: 1,
    };
    const toVersion = {
      id: "v2",
      version_no: 2,
      first_seen_at: toFirstSeen,
      sha256: "b".repeat(64),
      byte_size: 11,
      item_count: to.length,
    };
    return {
      document_id: "doc-1",
      title: "Agenda",
      document_type: "agenda",
      url: "https://example.invalid/agenda",
      versions: [from, toVersion],
      diffs: [
        {
          from,
          to: toVersion,
          changes: diffAgendaItems([ROLL_CALL], to),
          from_items: [ROLL_CALL],
          to_items: to,
        },
      ],
    };
  }

  const base = {
    meetingId: "00000000-0000-4000-8000-000000000001",
    scheduledAt,
    windowHours: DEFAULT_AGENDA_CHANGE_WINDOW_HOURS,
    memberNames: [] as string[],
  };

  it("raises the flag with both hashes and the changed item list", () => {
    const flags = agendaChangeFlags({
      ...base,
      timelines: [pairTimeline("2026-08-04T01:00:00.000Z", [ROLL_CALL, REZONE])],
    });
    assert.equal(flags.length, 1);
    assert.equal(flags[0].metadata.from_sha256, "a".repeat(64));
    assert.equal(flags[0].metadata.to_sha256, "b".repeat(64));
    assert.deepEqual(flags[0].metadata.changes, [
      { kind: "added", item_number: 3, title: "Rezone 400 N Wallace" },
    ]);
    assert.equal(flags[0].metadata.hours_before, 19);
    assert.equal(flags[0].review_state, "published");
  });

  it("describes the record and never the motive", () => {
    const flags = agendaChangeFlags({
      ...base,
      timelines: [pairTimeline("2026-08-04T01:00:00.000Z", [ROLL_CALL, REZONE])],
    });
    const text = flags[0].description.toLowerCase();
    for (const word of [
      "quietly",
      "deliberate",
      "slipped",
      "buried",
      "avoid",
      "hide",
      "hidden",
      "sneak",
      "controversial",
      "suspicious",
      "improper",
    ]) {
      assert.equal(text.includes(word), false, `description implies motive: "${word}"`);
    }
    assert.ok(text.startsWith('"agenda" was republished 19 hours before the scheduled start'));
  });

  it("holds a flag whose changed items name someone on the roster", () => {
    // Nothing naming a person auto-publishes.
    const flags = agendaChangeFlags({
      ...base,
      memberNames: ["Terry Cunningham"],
      timelines: [
        pairTimeline("2026-08-04T01:00:00.000Z", [
          ROLL_CALL,
          { item_number: 4, title: "Appointment of Terry Cunningham to the board" },
        ]),
      ],
    });
    assert.equal(flags.length, 1);
    assert.equal(flags[0].review_state, "held");
  });

  it("does not raise for a version that landed outside the window", () => {
    const flags = agendaChangeFlags({
      ...base,
      timelines: [pairTimeline("2026-07-25T01:00:00.000Z", [ROLL_CALL, REZONE])],
    });
    assert.equal(flags.length, 0);
  });

  it("does not raise for a republication after the meeting", () => {
    // A revision published after a body has met cannot have changed what was
    // voted on. It is a different fact and not this flag.
    const flags = agendaChangeFlags({
      ...base,
      timelines: [pairTimeline("2026-08-05T01:00:00.000Z", [ROLL_CALL, REZONE])],
    });
    assert.equal(flags.length, 0);
  });

  it("does not raise when the meeting has no scheduled instant", () => {
    const flags = agendaChangeFlags({
      ...base,
      scheduledAt: null,
      timelines: [pairTimeline("2026-08-04T01:00:00.000Z", [ROLL_CALL, REZONE])],
    });
    assert.equal(flags.length, 0);
  });

  it("does not raise when the two versions extract to the same items", () => {
    const flags = agendaChangeFlags({
      ...base,
      timelines: [pairTimeline("2026-08-04T01:00:00.000Z", [ROLL_CALL])],
    });
    assert.equal(flags.length, 0);
  });

  it("honours a jurisdiction window narrower than the default", () => {
    const timelines = [pairTimeline("2026-08-03T00:00:00.000Z", [ROLL_CALL, REZONE])];
    assert.equal(agendaChangeFlags({ ...base, timelines }).length, 1);
    assert.equal(agendaChangeFlags({ ...base, windowHours: 12, timelines }).length, 0);
  });
});

describe("buildTimelines", () => {
  function row(overrides: Partial<TimelineRow>): TimelineRow {
    return {
      document_id: "doc-1",
      document_title: "Agenda",
      document_type: "agenda",
      document_url: "https://example.invalid/agenda",
      version_id: "v1",
      version_no: 1,
      first_seen_at: new Date("2026-07-20T12:00:00.000Z"),
      sha256: "a".repeat(64),
      byte_size: 10,
      item_snapshot: [ROLL_CALL],
      ...overrides,
    };
  }

  it("produces no diffs for a document with exactly one version", () => {
    // The common case. It must be a complete answer, not an empty comparison.
    const [timeline] = buildTimelines([row({})]);
    assert.equal(timeline.versions.length, 1);
    assert.deepEqual(timeline.diffs, []);
    assert.equal(timeline.versions[0].item_count, 1);
  });

  it("diffs consecutive versions in version order regardless of row order", () => {
    const [timeline] = buildTimelines([
      row({ version_id: "v2", version_no: 2, item_snapshot: [ROLL_CALL, BUDGET] }),
      row({ version_id: "v1", version_no: 1 }),
    ]);
    assert.deepEqual(
      timeline.versions.map((version) => version.version_no),
      [1, 2],
    );
    assert.equal(timeline.diffs.length, 1);
    assert.equal(timeline.diffs[0].changes?.length, 1);
    assert.equal(timeline.diffs[0].changes?.[0].kind, "added");
  });

  it("reports a diff as uncomputable when a version was never extracted", () => {
    // An empty change list would read as "nothing changed", which is a claim we
    // are not in a position to make.
    const [timeline] = buildTimelines([
      row({ item_snapshot: null }),
      row({ version_id: "v2", version_no: 2, item_snapshot: [ROLL_CALL, BUDGET] }),
    ]);
    assert.equal(timeline.versions[0].item_count, null);
    assert.equal(timeline.diffs[0].changes, null);
    assert.equal(timeline.diffs[0].from_items, null);
  });

  it("keeps documents separate", () => {
    const timelines = buildTimelines([
      row({}),
      row({ document_id: "doc-2", document_title: "Minutes", document_type: "minutes" }),
    ]);
    assert.equal(timelines.length, 2);
    assert.deepEqual(
      timelines.map((timeline) => timeline.title),
      ["Agenda", "Minutes"],
    );
  });
});

/* ------------------------------------------------------- database wiring */

describe("document_versions, against the database", () => {
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let meetingId: string;
  let documentId: string;
  let v1: { id: string; sha256: string };
  let v2: { id: string; sha256: string };

  before(async () => {
    await cleanupByPrefix(PREFIX);
    fixture = await createSource(PREFIX, { enabled: false });
    meetingId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
    });
    await db("meetings").where({ id: meetingId }).update({ time: "14:00:00" });
    documentId = await createDocument(meetingId, "https://example.invalid/agenda-1");
    v1 = await artifact("v1");
    v2 = await artifact("v2");
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts(HASHES);
    await db.destroy();
  });

  it("creates one version per distinct artifact and none for a re-fetch", async () => {
    const first = await recordDocumentVersion(db, documentId, v1.id, new Date("2026-07-20T12:00:00Z"));
    assert.deepEqual(first, { created: true, versionNo: 1 });

    // Unchanged bytes resolve to the same artifact. The unique constraint
    // decides, not a prior "have I seen this?" question.
    const again = await recordDocumentVersion(db, documentId, v1.id, new Date("2026-07-25T12:00:00Z"));
    assert.deepEqual(again, { created: false, versionNo: 1 });

    const second = await recordDocumentVersion(db, documentId, v2.id, new Date("2026-08-04T01:00:00Z"));
    assert.deepEqual(second, { created: true, versionNo: 2 });

    const rows = await db("document_versions").where({ meeting_document_id: documentId });
    assert.equal(rows.length, 2);
  });

  it("keeps first_seen_at at the moment the bytes were first held", async () => {
    const row = await db("document_versions")
      .where({ meeting_document_id: documentId, version_no: 1 })
      .first("first_seen_at");
    assert.equal(new Date(row.first_seen_at).toISOString(), "2026-07-20T12:00:00.000Z");
  });

  it("refuses a second row for the same document and artifact", async () => {
    await assert.rejects(
      db("document_versions").insert({
        meeting_document_id: documentId,
        artifact_id: v1.id,
        version_no: 99,
      }),
      /document_versions_document_artifact_unique/,
    );
  });

  it("refuses a second row claiming the same version number", async () => {
    const spare = await artifact("spare");
    await assert.rejects(
      db("document_versions").insert({
        meeting_document_id: documentId,
        artifact_id: spare.id,
        version_no: 1,
      }),
      /document_versions_document_version_unique/,
    );
  });

  it("attaches an extraction to every version carrying that artifact", async () => {
    const updated = await recordVersionSnapshot(db, v1.id, [ROLL_CALL]);
    assert.equal(updated, 1);
    await recordVersionSnapshot(db, v2.id, [ROLL_CALL, REZONE]);

    const timelines = await loadDocumentTimelines(db, meetingId);
    assert.equal(timelines.length, 1);
    assert.equal(timelines[0].versions.length, 2);
    assert.equal(timelines[0].diffs.length, 1);
    assert.equal(timelines[0].diffs[0].changes?.length, 1);
    assert.equal(timelines[0].diffs[0].changes?.[0].kind, "added");
  });

  it("substantiates last_minute_agenda_change from the version history", async () => {
    const meeting = await db("meetings").where({ id: meetingId }).first();
    const flags = await checkLastMinuteAgendaChange(db, meeting);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].flag_type, "last_minute_agenda_change");
    assert.equal(flags[0].metadata?.from_sha256, v1.sha256);
    assert.equal(flags[0].metadata?.to_sha256, v2.sha256);
  });

  it("raises nothing for a meeting whose document has one version", async () => {
    const quiet = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-05",
    });
    await db("meetings").where({ id: quiet }).update({ time: "14:00:00" });
    const doc = await createDocument(quiet, "https://example.invalid/agenda-quiet");
    const only = await artifact("quiet");
    await recordDocumentVersion(db, doc, only.id, new Date("2026-08-05T01:00:00Z"));
    await recordVersionSnapshot(db, only.id, [ROLL_CALL]);

    const timelines = await loadDocumentTimelines(db, quiet);
    assert.equal(timelines[0].versions.length, 1);
    assert.deepEqual(timelines[0].diffs, []);

    const meeting = await db("meetings").where({ id: quiet }).first();
    assert.deepEqual(await checkLastMinuteAgendaChange(db, meeting), []);
  });

  it("uses the jurisdiction's own window", async () => {
    await db("jurisdictions")
      .where({ id: fixture.jurisdictionId })
      .update({ agenda_change_window_hours: 6 });
    const meeting = await db("meetings").where({ id: meetingId }).first();
    assert.deepEqual(await checkLastMinuteAgendaChange(db, meeting), []);
    await db("jurisdictions")
      .where({ id: fixture.jurisdictionId })
      .update({ agenda_change_window_hours: DEFAULT_AGENDA_CHANGE_WINDOW_HOURS });
  });

  it("holds a flag naming a member of the jurisdiction", async () => {
    await db("members").insert({
      jurisdiction_id: fixture.jurisdictionId,
      name: "Rezone 400 N Wallace",
      title: "Trustee",
      term_start: "2026-01-01",
    });
    const meeting = await db("meetings").where({ id: meetingId }).first();
    const flags = await checkLastMinuteAgendaChange(db, meeting);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].review_state, "held");
    await db("members").where({ jurisdiction_id: fixture.jurisdictionId }).del();
  });

  it("serves the timeline on the public route", async () => {
    const res = await request(app).get(`/api/meetings/${meetingId}/agenda-diff`).expect(200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.data[0].versions.length, 2);
    assert.equal(res.body.data[0].diffs[0].to.sha256, v2.sha256);
  });

  it("404s the diff of an unpublished meeting", async () => {
    // The publication wall, at the one endpoint most worth quoting.
    const withheld = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-08-06",
    });
    const doc = await createDocument(withheld, "https://example.invalid/agenda-withheld");
    const bytes = await artifact("withheld");
    await recordDocumentVersion(db, doc, bytes.id, new Date("2026-08-06T01:00:00Z"));

    await request(app).get(`/api/meetings/${withheld}/agenda-diff`).expect(404);
    // And it is really there for an operator to see.
    const timelines = await loadDocumentTimelines(db, withheld);
    assert.equal(timelines.length, 1);
  });

  it("rejects a malformed meeting id rather than querying with it", async () => {
    await request(app).get("/api/meetings/not-a-uuid/agenda-diff").expect(400);
  });
});

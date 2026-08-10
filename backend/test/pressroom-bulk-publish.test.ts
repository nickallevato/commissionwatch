import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  publishMeetings,
  PUBLISH_BATCH_MAX,
} from "../src/services/pressroom/corrections";
import { listMeetingsForSource } from "../src/services/pressroom/meetings";
import {
  cleanupByPrefix,
  createMeeting,
  createSource,
  signInOperator,
} from "./helpers/pressroom";

/**
 * Reviewing and publishing what a sweep produced.
 *
 * `ingested` and `published` became different states in migration 030, which
 * was right and left a hole: the console could open one meeting by id and could
 * not discover any. That is workable for a sweep landing three records and
 * impossible for one landing the Bozeman archive, where the whole 2013–2026
 * listing arrives from a single page. Without a browse-and-publish path, the
 * only way a sweep reaches the public site is by opening meetings one id at a
 * time, and there is nowhere to get the ids.
 */

const PREFIX = "pressroom-bulk-test";
const EMAIL = "pressroom-bulk-test@example.invalid";

let cookie = "";

before(async () => {
  cookie = await signInOperator(EMAIL, "Bulk Tester");
});

after(async () => {
  await cleanupByPrefix(PREFIX);
  await db("operators").where({ email: EMAIL }).del();
  await db.destroy();
});

describe("listing what a source has ingested", () => {
  it("separates the unpublished backlog from what is already live", async () => {
    const { sourceId, commissionId } = await createSource(PREFIX, { enabled: true });
    const held = await createMeeting(commissionId, { publishedAt: null, date: "2026-08-01" });
    const live = await createMeeting(commissionId, { publishedAt: new Date(), date: "2026-08-02" });

    const backlog = await listMeetingsForSource(db, { sourceId, published: false });
    assert.deepEqual(
      backlog.meetings.map((meeting) => meeting.id),
      [held],
    );

    const published = await listMeetingsForSource(db, { sourceId, published: true });
    assert.deepEqual(
      published.meetings.map((meeting) => meeting.id),
      [live],
    );

    const all = await listMeetingsForSource(db, { sourceId });
    assert.equal(all.meetings.length, 2);
  });

  it("counts the whole backlog, not just the page", async () => {
    const { sourceId, commissionId } = await createSource(PREFIX, { enabled: true });
    for (let index = 0; index < 5; index += 1) {
      await createMeeting(commissionId, { publishedAt: null, date: `2026-07-0${index + 1}` });
    }

    const page = await listMeetingsForSource(db, { sourceId, published: false, limit: 2 });
    assert.equal(page.meetings.length, 2, "limit was not applied");
    // "Showing 2 of 5" is a true sentence. "Showing 2" implies there are 2.
    assert.equal(page.unpublished_total, 5);
  });

  it("renders a DATE column as the day it is, not an instant", async () => {
    // The driver hands back a Date at UTC midnight. Rendered as an ISO instant
    // and read in Mountain Time, every meeting would move to the day before —
    // which is every jurisdiction this project covers.
    const { sourceId, commissionId } = await createSource(PREFIX, { enabled: true });
    await createMeeting(commissionId, { publishedAt: null, date: "2026-03-11" });

    const listed = await listMeetingsForSource(db, { sourceId, published: false });
    assert.equal(listed.meetings[0].date, "2026-03-11");
  });

  it("does not leak meetings belonging to another source", async () => {
    const mine = await createSource(`${PREFIX}-mine`, { enabled: true });
    const theirs = await createSource(`${PREFIX}-theirs`, { enabled: true });
    await createMeeting(theirs.commissionId, { publishedAt: null });

    const listed = await listMeetingsForSource(db, { sourceId: mine.sourceId });
    assert.equal(listed.meetings.length, 0);
  });
});

describe("publishing a selection", () => {
  it("publishes every selected meeting and logs each one", async () => {
    const { commissionId } = await createSource(PREFIX, { enabled: true });
    const first = await createMeeting(commissionId, { publishedAt: null, date: "2026-06-01" });
    const second = await createMeeting(commissionId, { publishedAt: null, date: "2026-06-02" });

    const result = await publishMeetings(db, [first, second], "Reviewed the Gallatin sweep.", {
      id: null,
      email: EMAIL,
    });

    assert.deepEqual(result.published.sort(), [first, second].sort());
    assert.deepEqual(result.already_published, []);
    assert.deepEqual(result.not_found, []);

    for (const id of [first, second]) {
      const row = await db("meetings").where({ id }).first("published_at");
      assert.ok(row.published_at, `${id} was reported published and is not`);

      // One row per meeting, not one row for the batch: the log's job is to
      // answer "why is THIS record public".
      const logged = await db("record_corrections")
        .where({ target_table: "meetings", target_id: id, field: "published_at" })
        .first();
      assert.ok(logged, `${id} was published with no correction row`);
      assert.equal(logged.reason, "Reviewed the Gallatin sweep.");
      assert.equal(logged.operator_email, EMAIL);
    }
  });

  it("skips what is already public instead of logging a no-op", async () => {
    const { commissionId } = await createSource(PREFIX, { enabled: true });
    const live = await createMeeting(commissionId, { publishedAt: new Date(), date: "2026-06-03" });
    const held = await createMeeting(commissionId, { publishedAt: null, date: "2026-06-04" });

    const result = await publishMeetings(db, [live, held], "Second pass.", {
      id: null,
      email: EMAIL,
    });

    assert.deepEqual(result.published, [held]);
    assert.deepEqual(result.already_published, [live]);

    const noise = await db("record_corrections")
      .where({ target_table: "meetings", target_id: live, reason: "Second pass." })
      .first();
    assert.equal(noise, undefined, "an already-published meeting wrote a correction row");
  });

  it("reports ids that matched nothing rather than dropping them", async () => {
    const { commissionId } = await createSource(PREFIX, { enabled: true });
    const real = await createMeeting(commissionId, { publishedAt: null, date: "2026-06-05" });
    const ghost = "00000000-0000-0000-0000-000000000000";

    const result = await publishMeetings(db, [real, ghost], "Mixed batch.", {
      id: null,
      email: EMAIL,
    });

    assert.deepEqual(result.published, [real]);
    assert.deepEqual(result.not_found, [ghost]);
  });

  it("refuses a batch with no reason", async () => {
    const { commissionId } = await createSource(PREFIX, { enabled: true });
    const held = await createMeeting(commissionId, { publishedAt: null, date: "2026-06-06" });

    await assert.rejects(
      () => publishMeetings(db, [held], "  ", { id: null, email: EMAIL }),
      /reason is required/,
    );

    const row = await db("meetings").where({ id: held }).first("published_at");
    assert.equal(row.published_at, null, "a refused batch still published");
  });

  it("refuses a batch over the ceiling", async () => {
    const ids = Array.from(
      { length: PUBLISH_BATCH_MAX + 1 },
      (_unused, index) => `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    );
    await assert.rejects(
      () => publishMeetings(db, ids, "too many", { id: null, email: EMAIL }),
      new RegExp(`at most ${PUBLISH_BATCH_MAX}`),
    );
  });

  it("refuses an empty selection", async () => {
    await assert.rejects(
      () => publishMeetings(db, [], "nothing selected", { id: null, email: EMAIL }),
      /no meetings were selected/,
    );
  });

  it("leaves nothing published when the batch throws partway", async () => {
    // One transaction: a partial publish that also partially logged would leave
    // the site asserting things the log cannot explain. `motiveTerms` rejects
    // the reason inside the transaction, after the first row is written.
    const { commissionId } = await createSource(PREFIX, { enabled: true });
    const first = await createMeeting(commissionId, { publishedAt: null, date: "2026-06-07" });
    const second = await createMeeting(commissionId, { publishedAt: null, date: "2026-06-08" });

    await assert.rejects(() =>
      publishMeetings(db, [first, second], "Publishing this corrupt deal.", {
        id: null,
        email: EMAIL,
      }),
    );

    for (const id of [first, second]) {
      const row = await db("meetings").where({ id }).first("published_at");
      assert.equal(row.published_at, null, `${id} survived a rolled-back batch as published`);
    }
  });
});

describe("the console routes", () => {
  it("close the listing and the bulk publish to anyone without a session", async () => {
    const { sourceId, commissionId } = await createSource(PREFIX, { enabled: true });
    const held = await createMeeting(commissionId, { publishedAt: null, date: "2026-06-09" });

    await request(app).get(`/api/admin/pressroom/sources/${sourceId}/meetings`).expect(401);
    await request(app)
      .post("/api/admin/pressroom/meetings/publish")
      .send({ meeting_ids: [held], reason: "should never apply" })
      .expect(401);

    const row = await db("meetings").where({ id: held }).first("published_at");
    assert.equal(row.published_at, null);
  });

  it("list and publish for a signed-in operator", async () => {
    const { sourceId, commissionId } = await createSource(PREFIX, { enabled: true });
    const held = await createMeeting(commissionId, { publishedAt: null, date: "2026-06-10" });

    const listed = await request(app)
      .get(`/api/admin/pressroom/sources/${sourceId}/meetings?published=false`)
      .set("Cookie", cookie)
      .expect(200);
    assert.deepEqual(
      listed.body.meetings.map((meeting: { id: string }) => meeting.id),
      [held],
    );

    const published = await request(app)
      .post("/api/admin/pressroom/meetings/publish")
      .set("Cookie", cookie)
      .send({ meeting_ids: [held], reason: "Reviewed and published." })
      .expect(200);
    assert.deepEqual(published.body.published, [held]);
  });

  it("reject a bad published filter, a bad limit and a non-uuid id with 400", async () => {
    const { sourceId } = await createSource(PREFIX, { enabled: true });

    await request(app)
      .get(`/api/admin/pressroom/sources/${sourceId}/meetings?published=maybe`)
      .set("Cookie", cookie)
      .expect(400);

    await request(app)
      .get(`/api/admin/pressroom/sources/${sourceId}/meetings?limit=99999`)
      .set("Cookie", cookie)
      .expect(400);

    await request(app)
      .post("/api/admin/pressroom/meetings/publish")
      .set("Cookie", cookie)
      .send({ meeting_ids: ["not-a-uuid"], reason: "bad id" })
      .expect(400);

    await request(app)
      .post("/api/admin/pressroom/meetings/publish")
      .set("Cookie", cookie)
      .send({ meeting_ids: [], reason: "" })
      .expect(400);
  });
});

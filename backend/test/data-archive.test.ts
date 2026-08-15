import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  listSnapshots,
  readArchivedDataset,
  snapshotDataset,
  snapshotOn,
  takeSnapshot,
} from "../src/services/export/archive";
import { findDataset } from "../src/services/export/datasets";
import { FeatureRegistry, setFeatureRegistry } from "../src/services/features/registry";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * The dated export archive — F7.
 *
 * What this suite holds:
 *
 * **It is off, and off means 404.** The key is `dated_export_archive`, default
 * off, and while it is off the paths do not exist rather than existing and
 * refusing — the same choice `/mcp` makes, for the same reason: a
 * disabled-but-present endpoint is a surface somebody probes.
 *
 * **Retraction reaches the archive.** The property the whole design turns on. A
 * meeting published, snapshotted, and then withdrawn must be absent from the
 * *archived* export of the date it was public on. Nothing in the archive code
 * knows what a retraction is; it falls out of re-reading through the same
 * `ExportDataset.build` that `/api/data` uses, and this test is what says the
 * reuse is real rather than intended.
 *
 * **The loss is counted, not hidden.** A shorter file with no explanation is
 * indistinguishable from a smaller record, so `withheld_since` states the
 * difference and the two hashes say whether the bytes moved.
 *
 * **It refuses to answer before its first snapshot.** Publication state is one
 * mutable column that withdrawal clears, so a date before the first snapshot is
 * genuinely unrecorded — and the 404 says that in those words rather than
 * implying the site published nothing that day.
 *
 * Every name here is invented.
 */

const PREFIX = "data-archive-test";

let registry: FeatureRegistry;
let commissionId: string;
let publishedMeeting: string;
let withheldMeeting: string;

async function setFlag(enabled: boolean): Promise<void> {
  await db("features_audit").where({ key: "dated_export_archive" }).del();
  await db("features").where({ key: "dated_export_archive" }).del();
  if (enabled) {
    await db("features").insert({ key: "dated_export_archive", enabled: true });
  }
  await registry.refresh();
}

async function clearSnapshots(): Promise<void> {
  // `export_snapshot_datasets` cascades from the parent.
  await db("export_snapshots").del();
}

before(async () => {
  await cleanupByPrefix(PREFIX);
  await clearSnapshots();

  const fixture = await createSource(PREFIX, { enabled: false });
  commissionId = fixture.commissionId;
  publishedMeeting = await createMeeting(commissionId, {
    publishedAt: new Date(),
    date: "2026-03-12",
    location: `${PREFIX} published chamber`,
  });
  withheldMeeting = await createMeeting(commissionId, {
    publishedAt: null,
    date: "2026-03-19",
    location: `${PREFIX} withheld chamber`,
  });

  registry = new FeatureRegistry(db, { env: {}, logger: { warn: () => {}, error: () => {} } });
  await registry.refresh();
  setFeatureRegistry(registry);
});

after(async () => {
  setFeatureRegistry(null);
  await clearSnapshots();
  await db("features_audit").where({ key: "dated_export_archive" }).del();
  await db("features").where({ key: "dated_export_archive" }).del();
  await cleanupByPrefix(PREFIX);
  await db.destroy();
});

beforeEach(async () => {
  await clearSnapshots();
  await setFlag(true);
  // Every test starts from the published state; the retraction tests do their
  // own withdrawing and put it back.
  await db("meetings").where({ id: publishedMeeting }).update({ published_at: new Date() });
});

describe("the archive is off by default", () => {
  it("404s every archive path with the flag off", async () => {
    await setFlag(false);
    await request(app).get("/api/data/archive").expect(404);
    await request(app).get("/api/data/archive/2026-03-12").expect(404);
    await request(app).get("/api/data/archive/2026-03-12/meetings.json").expect(404);
    await request(app).get("/api/data/archive/2026-03-12/meetings.csv").expect(404);
  });

  it("leaves the live export working either way", async () => {
    // The flag gates the archive and nothing else. A switch that could turn off
    // the open data itself would be a switch over what a stranger can read of
    // the present record, which is not what this key is for.
    await setFlag(false);
    await request(app).get("/api/data/meetings.json").expect(200);
    await setFlag(true);
    await request(app).get("/api/data/meetings.json").expect(200);
  });
});

describe("taking a snapshot", () => {
  it("records every dataset, with the rows the export held", async () => {
    const { snapshot, datasets } = await takeSnapshot(db, { note: `${PREFIX} first` });
    assert.ok(snapshot.id);
    assert.equal(snapshot.note, `${PREFIX} first`);

    const meetings = datasets.find((entry) => entry.dataset === "meetings");
    assert.ok(meetings, "no meetings dataset was recorded");
    assert.ok(meetings.row_ids.includes(publishedMeeting), "the published meeting was not recorded");
    // The wall, at snapshot time: the builder never returned it, so it was never
    // recorded and cannot leak later.
    assert.ok(
      !meetings.row_ids.includes(withheldMeeting),
      "a withheld meeting reached the snapshot",
    );
    assert.equal(meetings.row_count, meetings.row_ids.length);
    assert.match(meetings.sha256, /^[0-9a-f]{64}$/);
  });

  it("addresses a snapshot by the day it was taken, and by later days", async () => {
    const { snapshot } = await takeSnapshot(db);
    const day = snapshot.taken_at.toISOString().slice(0, 10);

    const onDay = await snapshotOn(db, day);
    assert.equal(onDay?.id, snapshot.id);

    // A date after it resolves to it too: a reader asking about a day between
    // two snapshots gets what the export said at the time, rather than a 404
    // that would read as "the site said nothing that day".
    const later = await snapshotOn(db, "2099-01-01");
    assert.equal(later?.id, snapshot.id);
  });

  it("answers nothing for a date before the first snapshot", async () => {
    await takeSnapshot(db);
    // The forward-only boundary. Reaching for the earliest snapshot instead
    // would answer a March question with April's record.
    assert.equal(await snapshotOn(db, "2020-01-01"), null);
  });

  it("refuses a malformed date rather than parsing it loosely", async () => {
    await takeSnapshot(db);
    assert.equal(await snapshotOn(db, "12 March 2026"), null);
    assert.equal(await snapshotOn(db, "2026-3-12"), null);
  });
});

describe("an archived export is walled by today's rule", () => {
  it("serves the rows that were published then and are still published now", async () => {
    const { snapshot } = await takeSnapshot(db);
    const day = snapshot.taken_at.toISOString().slice(0, 10);

    const res = await request(app).get(`/api/data/archive/${day}/meetings.json`).expect(200);
    const rows = res.body.rows as Array<{ id: string }>;
    assert.ok(rows.some((row) => row.id === publishedMeeting));
    assert.ok(!rows.some((row) => row.id === withheldMeeting));
    assert.equal(res.body.withheld_since, 0);
    assert.equal(res.body.unchanged, true);
    assert.equal(res.body.sha256_then, res.body.sha256_now);
  });

  it("drops a record retracted since the snapshot, and says how many", async () => {
    // THE property. A dataset published in March and withdrawn since must not
    // remain downloadable through the archive.
    const { snapshot } = await takeSnapshot(db);
    const day = snapshot.taken_at.toISOString().slice(0, 10);

    const before = await request(app).get(`/api/data/archive/${day}/meetings.json`).expect(200);
    assert.ok((before.body.rows as Array<{ id: string }>).some((row) => row.id === publishedMeeting));

    await db("meetings").where({ id: publishedMeeting }).update({ published_at: null });

    const after = await request(app).get(`/api/data/archive/${day}/meetings.json`).expect(200);
    const rows = after.body.rows as Array<{ id: string }>;
    assert.ok(
      !rows.some((row) => row.id === publishedMeeting),
      "a retracted meeting was still downloadable through the archive",
    );
    // Counted rather than quietly shorter: a smaller file with no explanation
    // is indistinguishable from a smaller record.
    assert.equal(after.body.rows_recorded - after.body.rows_served, after.body.withheld_since);
    assert.ok(after.body.withheld_since >= 1);
    assert.equal(after.body.unchanged, false);
    assert.notEqual(after.body.sha256_then, after.body.sha256_now);
  });

  it("drops it from the CSV as well as the JSON", async () => {
    // Two serialisations of one query. A wall that held in one and not the other
    // would be the same defect with a different content type.
    const { snapshot } = await takeSnapshot(db);
    const day = snapshot.taken_at.toISOString().slice(0, 10);
    await db("meetings").where({ id: publishedMeeting }).update({ published_at: null });

    const res = await request(app).get(`/api/data/archive/${day}/meetings.csv`).expect(200);
    assert.ok(!res.text.includes(publishedMeeting));
    assert.ok(!res.text.includes(withheldMeeting));
    assert.match(res.text.split("\r\n")[0], /^id,/);
  });

  it("never admits a row published after the snapshot", async () => {
    // The other direction. The archive is not "today's export dated in the
    // past": a record that became public after the snapshot was not in it.
    const { snapshot } = await takeSnapshot(db);
    const day = snapshot.taken_at.toISOString().slice(0, 10);

    await db("meetings").where({ id: withheldMeeting }).update({ published_at: new Date() });
    try {
      const res = await request(app).get(`/api/data/archive/${day}/meetings.json`).expect(200);
      const rows = res.body.rows as Array<{ id: string }>;
      assert.ok(
        !rows.some((row) => row.id === withheldMeeting),
        "a meeting published after the snapshot appeared in it",
      );
      // And it is in the live export, which is what makes the absence above a
      // property of the archive rather than of a broken query.
      const live = await request(app).get("/api/data/meetings.json").expect(200);
      assert.ok((live.body.rows as Array<{ id: string }>).some((row) => row.id === withheldMeeting));
    } finally {
      await db("meetings").where({ id: withheldMeeting }).update({ published_at: null });
    }
  });

  it("reads through the same builder the live export uses", async () => {
    // Asserted structurally as well as behaviourally: the service is handed the
    // dataset definition from `findDataset`, so there is one implementation of
    // the wall in the export path and the archive is a caller of it.
    const { snapshot } = await takeSnapshot(db);
    const definition = findDataset("meetings");
    assert.ok(definition);
    const recorded = await snapshotDataset(db, snapshot.id, "meetings");
    assert.ok(recorded);

    const archived = await readArchivedDataset(db, definition, recorded);
    assert.equal(archived.dataset, definition);
    assert.ok(archived.rows.every((row) => typeof row.id === "string"));
    // Projected to the dataset's own columns, so the archive cannot publish a
    // column the live export withholds.
    for (const row of archived.rows) {
      for (const key of Object.keys(row)) {
        assert.ok(definition.columns.includes(key), `${key} is not an exported column`);
      }
    }
  });
});

describe("the archive states its own limits", () => {
  it("publishes the boundary and the retraction rule on the index", async () => {
    await takeSnapshot(db);
    const res = await request(app).get("/api/data/archive").expect(200);

    assert.ok(res.body.answerable_from, "the index does not say from when it can answer");
    assert.match(res.body.forward_only, /cannot be reconstructed/);
    assert.match(res.body.retraction, /withdrawn/);
    assert.equal(res.body.snapshots.length, 1);
    assert.ok(res.body.datasets.includes("meetings"));
  });

  it("says nothing was recorded, rather than nothing was published", async () => {
    await takeSnapshot(db);
    const res = await request(app).get("/api/data/archive/2020-01-01").expect(404);
    // The distinction the whole feature turns on.
    assert.match(res.body.error, /never recorded and cannot be reconstructed/);
  });

  it("reports an empty archive honestly", async () => {
    await clearSnapshots();
    const res = await request(app).get("/api/data/archive").expect(200);
    assert.equal(res.body.answerable_from, null);
    assert.deepEqual(res.body.snapshots, []);
    assert.equal((await listSnapshots(db)).length, 0);
  });

  it("400s a malformed date and 404s an unknown dataset", async () => {
    await takeSnapshot(db);
    await request(app).get("/api/data/archive/not-a-date").expect(400);
    await request(app).get("/api/data/archive/not-a-date/meetings.json").expect(400);
    const snapshot = await snapshotOn(db, "2099-01-01");
    assert.ok(snapshot);
    const day = snapshot.taken_at.toISOString().slice(0, 10);
    await request(app).get(`/api/data/archive/${day}/not_a_dataset.json`).expect(404);
    await request(app).get(`/api/data/archive/${day}/meetings.xml`).expect(404);
  });
});

import { describe, it, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";
import * as cheerio from "cheerio";

// Must be set before any delivery code resolves the key — the retraction path
// reaches `services/delivery` through the event spine.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import db from "../src/config/database";
import feedRouter from "../src/routes/feed";
import { emitEvent, retractSubject } from "../src/services/events";
import {
  renderClaim,
  renderSha256,
  RENDER_VERSION,
} from "../src/services/review/claims";
import { renderAtom, renderRss, type FeedDocument } from "../src/services/feeds/atom";
import { collectEventEntries } from "../src/services/feeds/entries";
import {
  collectQueryEntries,
  parseFeedQuery,
  requireJurisdictionName,
  FeedQueryError,
} from "../src/services/feeds/query";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
} from "./helpers/pressroom";

/**
 * The first two delivery channels: the feed, and the query feed.
 *
 * Both are public consumers of the event spine, and the properties asserted
 * here are the ones that make that safe rather than merely convenient:
 *
 *  - **`ops` never reaches a reader.** The emitter cannot check an ops event
 *    against a publication state, because there is none, so the filter lives on
 *    the consumer. Asserted *on the consumer*, with an ops event that really
 *    exists in the table — otherwise the absence proves only that we forgot to
 *    write one.
 *  - **Every entry carries a citation.** A feed item that leaves the source
 *    behind is an unsourced claim in a stranger's inbox.
 *  - **A retraction is its own entry.** A feed that only ever adds propagates
 *    the mistake and never the correction.
 *  - **`<id>` is a URN over the event id and is stable across renders.** A
 *    reader keying on a URL re-shows every item the day a path changes.
 *  - **The query feed reaches the publication wall through `services/search.ts`**,
 *    tested in both directions — withheld, then published — because absence
 *    alone would also hold for a query that is simply broken.
 *
 * The XML is parsed, not matched with a regular expression. `cheerio` in XML
 * mode is the parser already in this project's dependencies; it is htmlparser2
 * underneath and therefore lenient about a document a strict parser would
 * reject, so the escaping tests additionally assert on the raw bytes.
 */

/**
 * The router under test, mounted at the site root exactly as `app.ts` must
 * mount it — `app.use(feedRouter)`, no prefix, because the paths are
 * `/feed.xml` and `/feed.rss` and a feed reader looks nowhere else.
 *
 * A bare app rather than the real one because mounting into `src/app.ts` is the
 * orchestrator's step, not this agent's, and a suite that imported the real app
 * would fail for the whole window between these files landing and that line
 * being added — which reads as a broken feed rather than as an unmounted one.
 */
const app = express().use(feedRouter);

const PREFIX = "feeds-test";
const BASE = "https://commissionwatch.example";
const AGENDA_SHA = sha256Of("feeds-test-agenda");
const TERM = "zonotrichia";

/** The pinned sentence, rendered by the one renderer. Filled in `before`. */
let CLAIM_TEXT = "";

interface Fixture {
  jurisdictionId: string;
  commissionId: string;
  publishedMeetingId: string;
  retractedMeetingId: string;
  withheldMeetingId: string;
  artifactId: string;
  documentId: string;
  flagId: string;
  claimId: string;
}

let fixture: Fixture;
const createdEventIds: string[] = [];

async function record(id: string): Promise<string> {
  createdEventIds.push(id);
  return id;
}

before(async () => {
  await cleanupByPrefix(PREFIX);
  // `artifacts` is content-addressed and outside the prefix scheme, so a run
  // killed before its `after` leaves this sha behind and poisons every later
  // run with a unique-constraint failure in the hook — which reports as
  // "every test cancelled" and looks nothing like its cause. Setup is
  // idempotent on purpose.
  await deleteArtifacts([AGENDA_SHA]);
  const source = await createSource(PREFIX, { enabled: false });

  const publishedMeetingId = await createMeeting(source.commissionId, {
    publishedAt: new Date(),
    date: "2026-08-10",
  });
  const retractedMeetingId = await createMeeting(source.commissionId, {
    publishedAt: new Date(),
    date: "2026-08-11",
  });
  const withheldMeetingId = await createMeeting(source.commissionId, {
    publishedAt: null,
    date: "2026-08-12",
  });

  const artifactId = await createArtifact(AGENDA_SHA, "https://example.invalid/feeds-agenda.pdf");

  const [document] = await db("meeting_documents")
    .insert({
      meeting_id: publishedMeetingId,
      title: `${PREFIX} agenda`,
      document_type: "agenda",
      url: "https://example.invalid/feeds-agenda.pdf",
    })
    .returning<Array<{ id: string }>>("id");

  await db("document_versions").insert({
    meeting_document_id: document.id,
    artifact_id: artifactId,
    version_no: 1,
  });

  const [flag] = await db("anomaly_flags")
    .insert({
      meeting_id: publishedMeetingId,
      artifact_id: artifactId,
      flag_type: "quorum_issue",
      description: `Only 2 of 5 members present for the ${TERM} rezone`,
      severity: "high",
      source: "auto",
      review_state: "published",
    })
    .returning<Array<{ id: string }>>("id");

  // Pinned exactly as `approveClaim` pins it — the rendered bytes, their sha,
  // and the render version. Migration 087's CHECK refuses an approved claim
  // without all three, and `renderApprovedClaim` refuses to render one whose
  // pin does not match, so a fixture that skipped this would silently test the
  // "awaiting re-review" path instead of the published one.
  CLAIM_TEXT = renderClaim({
    subject_name: "Commissioner Fixture",
    action: "voted_yes",
    matter: "Ordinance 2145",
  });
  const [claim] = await db("minute_claims")
    .insert({
      meeting_id: publishedMeetingId,
      artifact_sha256: AGENDA_SHA,
      subject_name: "Commissioner Fixture",
      action: "voted_yes",
      matter: "Ordinance 2145",
      quote: "Commissioner Fixture voted aye on the motion.",
      quote_offset: 12,
      model: "test-model",
      prompt_version: "v0",
      status: "approved",
      rendered_text: CLAIM_TEXT,
      render_sha256: renderSha256(CLAIM_TEXT),
      render_version: RENDER_VERSION,
      approved_by: randomUUID(),
      approved_at: new Date(),
    })
    .returning<Array<{ id: string }>>("id");

  // Two agenda items carrying the same rare term: one on a published meeting,
  // one on a withheld one. The pair is what makes the wall test mean something.
  await db("agenda_items").insert([
    {
      meeting_id: publishedMeetingId,
      item_number: 1,
      title: `Public ${TERM} rezone`,
      description: "Second reading.",
    },
    {
      meeting_id: withheldMeetingId,
      item_number: 1,
      title: `Withheld ${TERM} rezone`,
      description: "Not yet published.",
    },
  ]);

  fixture = {
    jurisdictionId: source.jurisdictionId,
    commissionId: source.commissionId,
    publishedMeetingId,
    retractedMeetingId,
    withheldMeetingId,
    artifactId,
    documentId: document.id,
    flagId: flag.id,
    claimId: claim.id,
  };

  const j = fixture.jurisdictionId;

  await record(
    (
      await emitEvent(db, {
        event_type: "meeting.published",
        subject_kind: "meeting",
        subject_id: publishedMeetingId,
        jurisdiction_id: j,
        severity: "info",
      })
    ).id,
  );
  await record(
    (
      await emitEvent(db, {
        event_type: "finding.published",
        subject_kind: "finding",
        subject_id: flag.id,
        jurisdiction_id: j,
        severity: "high",
      })
    ).id,
  );
  await record(
    (
      await emitEvent(db, {
        event_type: "claim.published",
        subject_kind: "claim",
        subject_id: claim.id,
        jurisdiction_id: j,
        severity: "medium",
      })
    ).id,
  );
  await record(
    (
      await emitEvent(db, {
        event_type: "document.published",
        subject_kind: "document",
        subject_id: document.id,
        jurisdiction_id: j,
        severity: "info",
      })
    ).id,
  );

  // An ops event that really exists, so its absence from the feeds below is
  // evidence rather than an artefact of never having written one.
  await record(
    (
      await emitEvent(db, {
        event_type: "ops.sweep_failed",
        subject_kind: "ops",
        jurisdiction_id: j,
        severity: "critical",
        dedupe_key: `${PREFIX}:ops:sweep_failed:1`,
        payload: { error: "the sweep failed" },
      })
    ).id,
  );

  // A publish, a dispatch, then an unpublish — which is the only path that
  // produces a `*.retracted` event. `retractSubject` refuses to invent one for
  // an event that never went out, because that one is genuinely recalled.
  const dispatched = await emitEvent(db, {
    event_type: "meeting.published",
    subject_kind: "meeting",
    subject_id: retractedMeetingId,
    jurisdiction_id: j,
    severity: "info",
  });
  await record(dispatched.id);
  await db("events").where({ id: dispatched.id }).update({ dispatched_at: new Date() });
  await db("meetings").where({ id: retractedMeetingId }).update({ published_at: null });
  const retraction = await retractSubject(db, {
    subject_kind: "meeting",
    subject_id: retractedMeetingId,
    reason: "Published against the wrong commission — an <operator> & a typo",
    jurisdiction_id: j,
  });
  assert.ok(retraction.retraction, "the fixture did not produce a retraction event");
  await record(retraction.retraction.id);
});

// Guarded on `fixture` rather than assuming it: when setup fails, teardown
// running anyway is what returns the database to a state the next run can build
// in, and an unguarded `fixture.claimId` here would throw a TypeError that
// replaces the real hook error in the report — and skip `db.destroy()`, so the
// process hangs instead of exiting with the failure.
after(async () => {
  await db("deliveries")
    .whereIn("dedupe_key", db("events").whereIn("id", createdEventIds).select("dedupe_key"))
    .del();
  await db("events").whereIn("id", createdEventIds).del();
  if (fixture !== undefined) {
    await db("minute_claims").where({ id: fixture.claimId }).del();
    await db("approval_requests").where({ anomaly_flag_id: fixture.flagId }).del();
    await db("anomaly_flags").where({ id: fixture.flagId }).del();
    await db("document_versions").where({ meeting_document_id: fixture.documentId }).del();
    await db("meeting_documents").where({ id: fixture.documentId }).del();
  }
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([AGENDA_SHA]);
  await db.destroy();
});

/** Our jurisdiction only, so the seed and other suites' rows stay out of it. */
function eventFilters(): Parameters<typeof collectEventEntries>[2] {
  return {
    jurisdiction_id: fixture.jurisdictionId,
    event_type: null,
    min_severity: null,
    limit: 50,
  };
}

async function atomDocument(): Promise<string> {
  const entries = await collectEventEntries(db, BASE, eventFilters());
  return renderAtom(feedDoc(entries));
}

function feedDoc(entries: Awaited<ReturnType<typeof collectEventEntries>>): FeedDocument {
  return {
    selfUrl: `${BASE}/feed.xml`,
    homeUrl: BASE,
    title: "CommissionWatch — the published record",
    subtitle: "Every meeting, finding, claim and document as it is published.",
    updated: new Date("2026-08-14T00:00:00.000Z"),
    entries,
  };
}

function parseXml(body: string): cheerio.CheerioAPI {
  return cheerio.load(body, { xml: true });
}

/* ------------------------------------------------------------------------- */

describe("the Atom feed", () => {
  it("parses, and carries one entry per public event", async () => {
    const $ = parseXml(await atomDocument());

    assert.equal($("feed").length, 1, "no <feed> root");
    assert.equal(
      $("feed > link[rel='self']").attr("href"),
      `${BASE}/feed.xml`,
      "Atom requires a self link and readers use it to re-subscribe",
    );

    const titles = $("entry > title")
      .map((_, el) => $(el).text())
      .get();
    assert.ok(
      titles.some((t) => t.includes("meeting of 2026-08-10")),
      `the published meeting is missing: ${titles.join(" | ")}`,
    );
    assert.ok(titles.some((t) => t.startsWith("Finding (high): quorum_issue")));
    assert.ok(
      titles.some((t) => t.startsWith(CLAIM_TEXT)),
      "the claim entry is not headed by the pinned sentence the operator approved",
    );
    assert.ok(titles.some((t) => t.startsWith("Document added")));
  });

  it("gives every entry a citation, in the body and as a link", async () => {
    const $ = parseXml(await atomDocument());
    const entries = $("entry").toArray();
    assert.ok(entries.length >= 4, "the fixture produced too few entries to mean anything");

    for (const el of entries) {
      const entry = $(el);
      const via = entry.find("link[rel='via']").attr("href");
      assert.ok(via && via.length > 0, `an entry went out with no citation link: ${entry.text()}`);
      assert.match(
        entry.find("summary").text(),
        /Source: /,
        "an entry body left the citation behind",
      );
    }
  });

  it("cites the claim by content address and links it inside its meeting, never as its own page", async () => {
    const $ = parseXml(await atomDocument());
    const claim = $("entry")
      .filter((_, el) => $(el).find("title").text().startsWith(CLAIM_TEXT))
      .first();

    assert.equal(
      claim.find("link[rel='alternate']").attr("href"),
      `${BASE}/meetings/${fixture.publishedMeetingId}#claim-${fixture.claimId}`,
      "a claim must render inside the meeting it came from, at #claim-{id}",
    );
    assert.match(
      claim.find("summary").text(),
      new RegExp(AGENDA_SHA),
      "the claim's content address did not survive into the entry",
    );
  });

  /**
   * The second half of the claim wall, and the one the event alone does not
   * hold. `services/events/emit.ts` checks `status = 'approved'` and a published
   * meeting; migration 087 added `retracted_at`, and a claim retracted *after*
   * its event was written still passes the emitter's check. The feed applies
   * `whereClaimPublic` for exactly that gap.
   */
  it("stops serving a claim the moment it is retracted, even though its event stands", async () => {
    const before = await collectEventEntries(db, BASE, eventFilters());
    assert.ok(
      before.some((entry) => entry.title.startsWith(CLAIM_TEXT)),
      "the claim was not being served, so its later absence would prove nothing",
    );

    await db("minute_claims")
      .where({ id: fixture.claimId })
      .update({ retracted_at: new Date(), retracted_reason: "wrong person" });
    try {
      const stillLive = await db("events")
        .where({ subject_id: fixture.claimId })
        .whereNull("revoked_at")
        .first<{ id: string } | undefined>("id");
      assert.ok(stillLive, "the fixture revoked the event, so this tests the wrong thing");

      const after = await collectEventEntries(db, BASE, eventFilters());
      assert.ok(
        !after.some((entry) => entry.title.startsWith(CLAIM_TEXT)),
        "a retracted claim was still served from its un-revoked event",
      );
    } finally {
      await db("minute_claims")
        .where({ id: fixture.claimId })
        .update({ retracted_at: null, retracted_reason: null });
    }
  });
});

describe("the RSS feed", () => {
  it("parses, and keys each item on the URN rather than a link", async () => {
    const entries = await collectEventEntries(db, BASE, eventFilters());
    const $ = parseXml(renderRss(feedDoc(entries)));

    assert.equal($("rss > channel").length, 1);
    const guids = $("item > guid").toArray();
    assert.ok(guids.length >= 4);
    for (const el of guids) {
      assert.equal(
        $(el).attr("isPermaLink"),
        "false",
        "without isPermaLink=false RSS treats the guid as a URL, which defeats the URN",
      );
      assert.match($(el).text(), /^urn:uuid:[0-9a-f-]{36}$/);
    }
  });

  it("dates items in RFC 822, which is the only format RSS defines", async () => {
    const entries = await collectEventEntries(db, BASE, eventFilters());
    const $ = parseXml(renderRss(feedDoc(entries)));
    for (const el of $("item > pubDate").toArray()) {
      assert.match(
        $(el).text(),
        /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
      );
    }
  });
});

describe("ops events", () => {
  it("really exist for this jurisdiction, so the absences below mean something", async () => {
    const row = await db("events")
      .where({ jurisdiction_id: fixture.jurisdictionId, subject_kind: "ops" })
      .first<{ id: string } | undefined>("id");
    assert.ok(row, "the fixture wrote no ops event");
  });

  it("never appear in either feed", async () => {
    const entries = await collectEventEntries(db, BASE, eventFilters());
    const atom = renderAtom(feedDoc(entries));
    const rss = renderRss(feedDoc(entries));

    const opsIds = await db("events")
      .where({ jurisdiction_id: fixture.jurisdictionId, subject_kind: "ops" })
      .pluck<string[]>("id");

    for (const id of opsIds) {
      assert.ok(!atom.includes(id), `an ops event reached the Atom feed: ${id}`);
      assert.ok(!rss.includes(id), `an ops event reached the RSS feed: ${id}`);
    }
    assert.ok(!atom.includes("sweep_failed"), "ops machinery text reached a reader");
    assert.ok(!atom.includes("the sweep failed"), "an ops payload reached a reader");
  });

  it("stays out even when the reader asks for the severity it was written at", async () => {
    // The ops event is `critical`, the highest rung, so a severity floor is the
    // one filter that would surface it if the ops rule were applied after it
    // rather than by `whereEventPublic`.
    const entries = await collectEventEntries(db, BASE, {
      ...eventFilters(),
      min_severity: "critical",
    });
    assert.deepEqual(entries, [], "a severity filter surfaced an ops event");
  });
});

describe("retractions", () => {
  it("appear as their own entry, marked as a withdrawal", async () => {
    const $ = parseXml(await atomDocument());
    const withdrawn = $("entry")
      .filter((_, el) => $(el).find("title").text().startsWith("Withdrawn:"))
      .first();

    assert.equal(withdrawn.length, 1, "the retraction produced no entry of its own");
    assert.match(withdrawn.find("summary").text(), /has been withdrawn/);
    assert.equal(
      withdrawn.find("link[rel='alternate']").attr("href"),
      `${BASE}/corrections`,
      "a withdrawal must point at the corrections log, not at the record it removed",
    );
  });

  it("is distinguishable from the publication it corrects", async () => {
    const $ = parseXml(await atomDocument());
    const titles = $("entry > title")
      .map((_, el) => $(el).text())
      .get();
    const withdrawals = titles.filter((t) => t.startsWith("Withdrawn:"));
    const publications = titles.filter((t) => !t.startsWith("Withdrawn:"));
    assert.equal(withdrawals.length, 1);
    assert.ok(publications.length >= 4, "the withdrawal swallowed the publications");
  });

  it("does not republish the record it withdrew", async () => {
    const atom = await atomDocument();
    assert.ok(
      !atom.includes(`/meetings/${fixture.retractedMeetingId}`),
      "the withdrawn meeting is still linked from the feed",
    );
    assert.ok(
      !atom.includes("meeting of 2026-08-11"),
      "the withdrawn meeting's record was rendered into its own retraction",
    );
  });

  it("escapes the operator's reason rather than emitting a document a parser rejects", async () => {
    const atom = await atomDocument();
    assert.ok(atom.includes("&lt;operator&gt;"), "a raw angle bracket survived from the reason");
    assert.ok(atom.includes("&amp; a typo"), "a raw ampersand survived from the reason");
    assert.doesNotThrow(() => parseXml(atom));
  });
});

describe("entry ids", () => {
  it("are the event id as a URN, stable across renders, and never the URL", async () => {
    const first = parseXml(await atomDocument());
    const second = parseXml(await atomDocument());

    const idsOf = ($: cheerio.CheerioAPI): string[] =>
      $("entry > id")
        .map((_, el) => $(el).text())
        .get();

    const a = idsOf(first);
    const b = idsOf(second);
    assert.ok(a.length >= 4);
    assert.deepEqual(a, b, "entry ids moved between two renders of the same data");

    for (const id of a) {
      assert.match(id, /^urn:uuid:[0-9a-f-]{36}$/, `entry id is not a URN: ${id}`);
      assert.ok(!id.startsWith("http"), `entry id is a URL, so a moved path re-shows every item`);
    }

    // And it really is the event id, not something that merely looks like one.
    const eventIds = await db("events")
      .where({ jurisdiction_id: fixture.jurisdictionId })
      .whereNot({ subject_kind: "ops" })
      .whereNull("revoked_at")
      .pluck<string[]>("id");
    for (const id of a) {
      assert.ok(eventIds.includes(id.replace("urn:uuid:", "")), `${id} is not an event id`);
    }
  });
});

describe("the query feed", () => {
  const renderedAt = new Date("2026-08-14T00:00:00.000Z");

  it("rejects a query longer than the bound rather than scanning for it", () => {
    assert.throws(
      () => parseFeedQuery({ q: "a".repeat(500) }),
      (err: unknown) => err instanceof FeedQueryError && /200 characters/.test(err.message),
    );
    assert.throws(
      () => parseFeedQuery({ q: Array.from({ length: 40 }, (_, i) => `t${i}`).join(" ") }),
      (err: unknown) => err instanceof FeedQueryError && /12 terms/.test(err.message),
    );
  });

  it("rejects a malformed jurisdiction id instead of answering with an empty feed", () => {
    assert.throws(
      () => parseFeedQuery({ jurisdiction_id: "not-a-uuid" }),
      (err: unknown) => err instanceof FeedQueryError,
    );
  });

  it("never echoes the query into the rejection, because nothing here keeps it", () => {
    try {
      parseFeedQuery({ q: "a".repeat(500) });
      assert.fail("an over-long query was accepted");
    } catch (err) {
      assert.ok(err instanceof FeedQueryError);
      assert.ok(!err.message.includes("aaaa"), "the 400 quoted the query back into a log");
    }
  });

  it("finds a published agenda item and withholds an unpublished one", async () => {
    const entries = await collectQueryEntries(db, BASE, {
      q: TERM,
      jurisdiction_name: null,
      search_kind: null,
      min_severity: null,
      limit: 50,
      renderedAt,
    });
    const titles = entries.map((entry) => entry.title);

    assert.ok(
      titles.some((t) => t.includes(`Public ${TERM} rezone`)),
      `the published agenda item is missing: ${titles.join(" | ")}`,
    );
    assert.ok(
      !titles.some((t) => t.includes(`Withheld ${TERM} rezone`)),
      "an unpublished agenda item leaked through the query feed",
    );
  });

  it("adds the withheld item the moment it is published, so the absence above means something", async () => {
    await db("meetings").where({ id: fixture.withheldMeetingId }).update({ published_at: new Date() });
    try {
      const entries = await collectQueryEntries(db, BASE, {
        q: TERM,
        jurisdiction_name: null,
        search_kind: null,
        min_severity: null,
        limit: 50,
        renderedAt,
      });
      assert.ok(
        entries.some((entry) => entry.title.includes(`Withheld ${TERM} rezone`)),
        "publishing the meeting did not surface its item — the omission above proves nothing",
      );
    } finally {
      await db("meetings").where({ id: fixture.withheldMeetingId }).update({ published_at: null });
    }
  });

  it("filters by kind", async () => {
    const entries = await collectQueryEntries(db, BASE, {
      q: TERM,
      jurisdiction_name: null,
      search_kind: "finding",
      min_severity: null,
      limit: 50,
      renderedAt,
    });
    assert.ok(entries.length > 0, "the finding fixture did not match its own term");
    for (const entry of entries) {
      assert.match(entry.title, /^Finding: /);
    }
  });

  it("filters by jurisdiction", async () => {
    const entries = await collectQueryEntries(db, BASE, {
      q: TERM,
      jurisdiction_name: `${PREFIX} County`,
      search_kind: null,
      min_severity: null,
      limit: 50,
      renderedAt,
    });
    assert.ok(entries.some((entry) => entry.title.includes(`Public ${TERM} rezone`)));
  });

  it("rejects a well-formed jurisdiction id that names nothing", async () => {
    await assert.rejects(
      () => requireJurisdictionName(db, "00000000-0000-4000-8000-000000000000"),
      (err: unknown) => err instanceof FeedQueryError && /names no jurisdiction/.test(err.message),
    );
    assert.equal(
      await requireJurisdictionName(db, fixture.jurisdictionId),
      `${PREFIX} County`,
      "the resolver rejected a jurisdiction that exists — the rejection above proves nothing",
    );
  });

  it("strips the control characters search marks its matches with", async () => {
    const entries = await collectQueryEntries(db, BASE, {
      q: TERM,
      jurisdiction_name: null,
      search_kind: null,
      min_severity: null,
      limit: 50,
      renderedAt,
    });
    const body = renderAtom({ ...feedDoc(entries), entries });
    // XML 1.0 permits only tab, LF and CR from the C0 range. `ts_headline`
    // delimits matches with chr(2)/chr(3), so an unstripped snippet is a feed
    // every reader rejects, not a cosmetic problem.
    // eslint-disable-next-line no-control-regex
    assert.ok(
      !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(body),
      "a control character went out",
    );
    assert.doesNotThrow(() => parseXml(body));
  });
});

describe("the HTTP routes", () => {
  it("refuses to invent URLs when PUBLIC_BASE_URL is unset", async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      const res = await request(app).get("/feed.xml").expect(503);
      assert.match(res.text, /PUBLIC_BASE_URL/);
      const rss = await request(app).get("/feed.rss").expect(503);
      assert.match(rss.text, /PUBLIC_BASE_URL/);
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = saved;
    }
  });

  it("serves Atom and RSS with a validator and a short cache", async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = BASE;
    try {
      const res = await request(app)
        .get(`/feed.xml?jurisdiction_id=${fixture.jurisdictionId}`)
        .expect(200);
      assert.match(res.headers["content-type"], /atom\+xml/);
      assert.match(res.headers["cache-control"], /max-age=300/);
      assert.ok(res.headers.etag, "no ETag — feed readers poll hard");
      assert.ok(res.headers["last-modified"], "no Last-Modified");

      await request(app)
        .get(`/feed.xml?jurisdiction_id=${fixture.jurisdictionId}`)
        .set("If-None-Match", res.headers.etag)
        .expect(304);

      const rss = await request(app)
        .get(`/feed.rss?jurisdiction_id=${fixture.jurisdictionId}`)
        .expect(200);
      assert.match(rss.headers["content-type"], /rss\+xml/);
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = saved;
    }
  });

  it("echoes the query in the title, escaped, so six saved feeds are distinguishable", async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = BASE;
    try {
      const res = await request(app).get("/feed.xml").query({ q: 'rezone & <b>"x"' }).expect(200);

      const $ = parseXml(res.text);
      assert.match($("feed > title").text(), /rezone & <b>"x"/);
      assert.match($("feed > subtitle").text(), /rezone & <b>"x"/);

      // And on the wire it is escaped, which is what stops the echo being an
      // injection into a document every reader parses.
      assert.ok(res.text.includes("&amp;"), "a raw ampersand went out in the title");
      assert.ok(!res.text.includes("<b>"), "a raw tag survived from the query into the document");
      assert.ok(res.text.includes("&lt;b&gt;"));
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = saved;
    }
  });

  it("400s an invalid jurisdiction id rather than returning an empty page", async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = BASE;
    try {
      const res = await request(app).get("/feed.xml?jurisdiction_id=nope").expect(400);
      assert.match(res.text, /jurisdiction_id/);

      const unknown = await request(app)
        .get("/feed.xml?jurisdiction_id=00000000-0000-4000-8000-000000000000")
        .expect(400);
      assert.match(unknown.text, /names no jurisdiction/);
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = saved;
    }
  });

  it("400s an over-long query rather than accepting a load generator", async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = BASE;
    try {
      const res = await request(app)
        .get("/feed.xml")
        .query({ q: "a".repeat(500) })
        .expect(400);
      assert.match(res.text, /200 characters/);
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = saved;
    }
  });
});

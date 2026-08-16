import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import db from "../src/config/database";
import {
  PrerenderConsumer,
  PrerenderStore,
  buildMeetingPage,
  renderDocument,
} from "../src/services/prerender";
import { emitEvent, retractSubject } from "../src/services/events";
import { RENDER_VERSION, renderClaim, renderSha256 } from "../src/services/review/claims";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
} from "./helpers/pressroom";
import { seedCursorPastExistingEvents } from "./helpers/events";

/**
 * Prerendering, tested against the property that matters rather than the shape
 * of the output.
 *
 * The property is: **a prerendered file exists exactly while its subject is
 * public.** Everything else here — titles, canonicals, JSON-LD, escaping — is a
 * page being correct. That one is a page being *safe*, and it is tested in both
 * directions, because a suite that only proves a withheld meeting has no file
 * also passes when the renderer is broken and writes nothing at all.
 *
 * The hostile-text case is not hypothetical decoration. Every string on these
 * pages came out of a county PDF or CivicPlus HTML, and this project has already
 * had to solve the same problem twice: `services/search.ts` marks matches with
 * control characters rather than `<b>`, and `DataLicensePage.tsx` neutralises
 * `</script>` inside its JSON-LD. This asserts both at once.
 */

const PREFIX = "prerender-test";
const BASE = "https://commissionwatch.example";
const HOSTILE = '</script><img src=x onerror="alert(1)"><script>alert(2)</script>';

let root: string;
let store: PrerenderStore;
let consumer: PrerenderConsumer;
let fixture: Awaited<ReturnType<typeof createSource>>;
let meetingId: string;
let secondMeetingId: string;
let memberId: string;
let findingId: string;
let bareFindingId: string;
let claimId: string;
let artifactSha: string;

function titleOf(html: string): string {
  const match = /<title>([\s\S]*?)<\/title>/.exec(html);
  assert.ok(match, "page has no <title>");
  return match[1];
}

function canonicalOf(html: string): string {
  const match = /<link rel="canonical" href="([^"]*)">/.exec(html);
  assert.ok(match, "page has no canonical link");
  return match[1];
}

function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(pattern)) {
    blocks.push(JSON.parse(match[1]) as unknown);
  }
  return blocks;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "JSON-LD block is not an object");
  return value as Record<string, unknown>;
}

/**
 * Start the consumer where this suite's fixtures start, not at the beginning of
 * the log.
 *
 * `tick()` reads `batchSize` events in `(updated_at, id)` order from wherever
 * its cursor stands, and `events` is append-only by design — migration 083 says
 * so in as many words: "Retention: never delete." A fresh `PrerenderStore` root
 * means no cursor file, which means a NULL cursor, which means the first ticks
 * spend their whole batch on whatever else the table already holds. Past 200
 * such rows the fixtures are never reached and the withdrawal assertion below
 * fails — a *withdrawn meeting kept its page*, the worst report this suite can
 * produce, for a reason that has nothing to do with the code under test. It has
 * happened: 1,585 rows left by ad-hoc runs.
 *
 * `seedCursorPastExistingEvents` in `helpers/events.ts` is that seeding, shared
 * with `feature-toggle-live.test.ts`, which needs it for the same reason; that
 * file also carries the run-level hygiene that stops the soil regrowing.
 */
describe("prerendering", () => {
  before(async () => {
    await cleanupByPrefix(PREFIX);
    root = await mkdtemp(join(tmpdir(), "cw-prerender-"));
    store = new PrerenderStore(root);
    consumer = new PrerenderConsumer(db, { store, baseUrl: BASE, enabled: true });

    fixture = await createSource(PREFIX, { enabled: false });
    meetingId = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-03-12",
      // Hostile text where a scraper would put a venue name.
      location: `City Hall ${HOSTILE}`,
    });
    secondMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-04-09",
    });

    await db("agenda_items").insert({
      meeting_id: meetingId,
      item_number: 1,
      title: `Ordinance 2145, second reading ${HOSTILE}`,
    });

    const [member] = await db("members")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        name: `${PREFIX} Councillor`,
        title: "Commissioner",
        term_start: "2024-01-01",
      })
      .returning<Array<{ id: string }>>("id");
    memberId = member.id;
    await db("votes").insert({ meeting_id: meetingId, member_id: memberId, vote: "no" });

    const [finding] = await db("anomaly_flags")
      .insert({
        meeting_id: meetingId,
        flag_type: "emergency_session",
        severity: "high",
        description: `Called with 12 hours notice ${HOSTILE}`,
        review_state: "published",
      })
      .returning<Array<{ id: string }>>("id");
    findingId = finding.id;

    // A second published finding, on the meeting that has no stored documents.
    // Without it the "what does a finding rest on" test only ever exercises the
    // cited branch — verified by reverting the fix and watching the test pass
    // anyway, which is the failure mode a fixture like this exists to close.
    const [bareFinding] = await db("anomaly_flags")
      .insert({
        meeting_id: secondMeetingId,
        flag_type: "missing_minutes",
        severity: "medium",
        description: "No minutes have been published for this meeting.",
        review_state: "published",
      })
      .returning<Array<{ id: string }>>("id");
    bareFindingId = bareFinding.id;

    // A stored document, so the meeting page can cite a content address and the
    // source page has something to render.
    artifactSha = sha256Of(`${PREFIX}-minutes`);
    const artifactId = await createArtifact(artifactSha, "https://example.gov/minutes.pdf");
    const [document] = await db("meeting_documents")
      .insert({
        meeting_id: meetingId,
        title: "Minutes",
        document_type: "minutes",
        url: "https://example.gov/minutes.pdf",
      })
      .returning<Array<{ id: string }>>("id");
    await db("document_versions").insert({
      meeting_document_id: document.id,
      artifact_id: artifactId,
      version_no: 1,
    });
    await db("artifact_texts").insert({
      artifact_id: artifactId,
      text: `Commissioner voted no on the motion. ${HOSTILE}`,
      char_count: 64,
    });

    // An approved claim, pinned exactly as `approveClaim` pins one. Written
    // directly because this suite is about what the renderer does with an
    // approved claim, not about the approval path.
    const rendered = renderClaim({
      subject_name: `${PREFIX} Councillor`,
      action: "voted_no",
      matter: "Ordinance 2145",
    });
    const [claim] = await db("minute_claims")
      .insert({
        meeting_id: meetingId,
        artifact_sha256: artifactSha,
        subject_name: `${PREFIX} Councillor`,
        member_id: memberId,
        action: "voted_no",
        matter: "Ordinance 2145",
        quote: `Commissioner voted no on the motion. ${HOSTILE}`,
        quote_offset: 0,
        model: "test-model",
        prompt_version: "v1",
        status: "approved",
        rendered_text: rendered,
        render_sha256: renderSha256(rendered),
        render_version: RENDER_VERSION,
        approved_by: "00000000-0000-0000-0000-000000000001",
        approved_at: new Date(),
      })
      .returning<Array<{ id: string }>>("id");
    claimId = claim.id;

    await seedCursorPastExistingEvents(db, consumer);
  });

  after(async () => {
    await db("minute_claims").where({ meeting_id: meetingId }).del();
    await db("events")
      .whereIn("subject_id", [meetingId, secondMeetingId, findingId, bareFindingId, claimId])
      .del();
    await db("members").where({ id: memberId }).del();
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([artifactSha]);
    await rm(root, { recursive: true, force: true });
  });

  it("writes no page for an unpublished meeting, and one for a published one", async () => {
    const withheld = await buildMeetingPage(db, meetingId, BASE);
    assert.equal(withheld, null, "an unpublished meeting produced a page");

    await consumer.renderTarget({ kind: "meeting", id: meetingId });
    assert.equal(
      await store.exists(`/meetings/${meetingId}`),
      false,
      "an unpublished meeting left a file on disk",
    );

    await db("meetings").where({ id: meetingId }).update({ published_at: new Date() });

    await consumer.renderTarget({ kind: "meeting", id: meetingId });
    const html = await store.read(`/meetings/${meetingId}`);
    assert.ok(html, "publishing produced no file");
    assert.ok(
      html.includes("12 March 2026"),
      "the meeting page does not carry its title in the bytes",
    );
    assert.ok(
      html.includes(`${PREFIX} Commission`),
      "the meeting page does not name the body in the bytes",
    );
  });

  it("removes the page when the meeting is unpublished", async () => {
    assert.equal(await store.exists(`/meetings/${meetingId}`), true, "precondition: page exists");

    await db("meetings").where({ id: meetingId }).update({ published_at: null });
    await consumer.renderTarget({ kind: "meeting", id: meetingId });

    assert.equal(
      await store.exists(`/meetings/${meetingId}`),
      false,
      "unpublishing left the prerendered page on disk",
    );

    await db("meetings").where({ id: meetingId }).update({ published_at: new Date() });
    await consumer.renderTarget({ kind: "meeting", id: meetingId });
  });

  /**
   * The revocation path, which is where the spec was wrong.
   *
   * `retractSubject` emits a `*.retracted` event **only if an earlier event was
   * already dispatched**, and `EVENT_DRAIN_ENABLED` defaults to off. So a
   * consumer keyed on retraction events would never see this withdrawal. The
   * consumer walks `updated_at`, which revocation does move, and re-asks the
   * publication helpers rather than trusting the event's meaning.
   */
  it("removes the page through the event loop when a meeting is withdrawn", async () => {
    await db.transaction(async (trx) => {
      await emitEvent(trx, {
        event_type: "meeting.published",
        subject_kind: "meeting",
        subject_id: meetingId,
        jurisdiction_id: fixture.jurisdictionId,
      });
    });

    const published = await consumer.tick();
    assert.ok(published.scanned > 0, "the tick read no events");
    assert.equal(await store.exists(`/meetings/${meetingId}`), true, "publish did not render");

    await db.transaction(async (trx) => {
      await trx("meetings").where({ id: meetingId }).update({ published_at: null });
      await retractSubject(trx, {
        subject_kind: "meeting",
        subject_id: meetingId,
        reason: "withdrawn by the test",
      });
    });

    const withdrawn = await consumer.tick();
    assert.ok(withdrawn.scanned > 0, "the revocation did not move the cursor's column");
    assert.equal(
      await store.exists(`/meetings/${meetingId}`),
      false,
      "a withdrawn meeting kept its prerendered page — the worst failure this system can produce",
    );

    // Republish for the tests that follow, and prove the same loop puts it back.
    await db("meetings").where({ id: meetingId }).update({ published_at: new Date() });
    await consumer.renderTarget({ kind: "meeting", id: meetingId });
  });

  it("re-renders the meeting page on claim.approved, because a claim has no page", async () => {
    await store.remove(`/meetings/${meetingId}`);

    await db.transaction(async (trx) => {
      await emitEvent(trx, {
        event_type: "claim.approved",
        subject_kind: "claim",
        subject_id: claimId,
        jurisdiction_id: fixture.jurisdictionId,
      });
    });

    await consumer.tick();

    const html = await store.read(`/meetings/${meetingId}`);
    assert.ok(html, "claim.approved did not rebuild the meeting page");
    assert.ok(
      html.includes(`id="claim-${claimId}"`),
      "the rebuilt meeting page does not carry the claim's anchor",
    );
    assert.ok(html.includes("voted no"), "the rebuilt meeting page does not carry the claim");
    assert.equal(
      await store.exists(`/claims/${claimId}`),
      false,
      "a claim was given a page of its own",
    );
  });

  it("gives every page a distinguishing title", async () => {
    const { written } = await consumer.rebuild();
    assert.ok(written > 0, "the rebuild wrote nothing");

    const paths = await store.list();
    assert.ok(paths.length >= 4, `expected several pages, got ${paths.length}`);

    const titles = new Map<string, string>();
    for (const path of paths) {
      const html = await store.read(path);
      assert.ok(html, `${path} is unreadable`);
      const title = titleOf(html);
      assert.notEqual(title, "CommissionWatch", `${path} carries the site name as its title`);
      const clash = titles.get(title);
      assert.equal(clash, undefined, `${path} and ${String(clash)} share the title "${title}"`);
      titles.set(title, path);
    }
  });

  it("gives every page an absolute, self-referencing canonical", async () => {
    for (const path of await store.list()) {
      const html = await store.read(path);
      assert.ok(html);
      const canonical = canonicalOf(html);
      assert.ok(
        canonical.startsWith("https://"),
        `${path} has a relative canonical: ${canonical}`,
      );
      assert.equal(canonical, `${BASE}${path}`, `${path} does not point at itself`);
    }
  });

  it("emits JSON-LD that parses and carries its required fields", async () => {
    const required: Record<string, string[]> = {
      Event: ["name", "startDate", "location", "organizer", "url"],
      Person: ["name", "url", "memberOf"],
      ClaimReview: ["url", "claimReviewed", "author", "itemReviewed"],
      Dataset: ["name", "description", "url", "license", "distribution"],
      DigitalDocument: ["name", "url", "identifier"],
    };

    let checked = 0;
    for (const path of await store.list()) {
      const html = await store.read(path);
      assert.ok(html);
      const blocks = jsonLdBlocks(html);
      assert.ok(blocks.length > 0, `${path} emits no JSON-LD`);
      for (const block of blocks) {
        const record = asRecord(block);
        assert.equal(record["@context"], "https://schema.org", `${path}: wrong @context`);
        const type = record["@type"];
        assert.equal(typeof type, "string", `${path}: JSON-LD block has no @type`);
        const fields = required[String(type)];
        assert.ok(fields, `${path}: unexpected JSON-LD @type ${String(type)}`);
        for (const field of fields) {
          assert.ok(
            record[field] !== undefined && record[field] !== null,
            `${path}: ${String(type)} is missing ${field}`,
          );
        }
        checked += 1;
      }
    }
    assert.ok(checked >= 4, `expected JSON-LD on several page types, checked ${checked}`);
  });

  /**
   * A finding page states its evidence, or states that it has none.
   *
   * The Evidence section used to be conditional: a finding whose meeting held
   * no stored documents rendered with the section simply absent, and a reader
   * — or a crawler reading the JSON-LD — cannot tell an omitted section from a
   * finding that rests on nothing. The reader-facing page has always said
   * "Source: meeting record" in that case; this is the static copy saying the
   * same thing rather than saying nothing.
   *
   * The JSON-LD half matters as much: `citation: []` asserts that citations
   * were gathered and there are none, which is false. An absent field asserts
   * nothing, which is true.
   */
  it("says what a finding rests on, including when nothing is stored", async () => {
    await consumer.rebuild();

    let findings = 0;
    for (const path of await store.list()) {
      if (!path.startsWith("/findings/")) continue;
      findings += 1;
      const html = await store.read(path);
      assert.ok(html);
      assert.match(html, /Evidence/, `${path} has no Evidence section at all`);
      const cites = html.includes("/source/");
      const statesNone = /rests on the meeting record/.test(html);
      assert.ok(
        cites || statesNone,
        `${path} shows an Evidence section that neither cites nor explains itself`,
      );

      for (const block of jsonLdBlocks(html)) {
        const record = asRecord(block);
        if (record["@type"] !== "ClaimReview") continue;
        const reviewed = asRecord(record.itemReviewed);
        const citation = reviewed.citation;
        assert.notDeepEqual(
          citation,
          [],
          `${path} emits an empty citation array, which claims there are none`,
        );
      }
    }
    assert.ok(findings > 0, "the fixture rendered no finding pages to check");
  });

  /**
   * The escaping test, and why it looks at both grammars.
   *
   * `</script>` inside a JSON string closes the element in an HTML tokeniser
   * even though it is legal JSON, and an `onerror` attribute in element content
   * only matters if the `<` around it survived. Both hazards come from the same
   * bytes, so both are asserted over the same record.
   */
  it("cannot be broken out of by hostile text in a record", async () => {
    for (const path of await store.list()) {
      const html = await store.read(path);
      assert.ok(html);

      // The words `onerror=` and `alert(` survive as *text*, and must: this page
      // quotes what the document said. What must not survive is the `<` that
      // would make them markup.
      assert.ok(!html.includes("<img"), `${path}: an <img> tag reached the document`);

      // Every `<script>` in the document is a JSON-LD block and nothing else.
      const scripts = html.match(/<script[^>]*>/g) ?? [];
      for (const tag of scripts) {
        assert.equal(
          tag,
          '<script type="application/ld+json">',
          `${path}: an unexpected script tag ${tag}`,
        );
      }
      // ...and each one closes exactly once, so nothing inside a value ended it.
      assert.equal(
        (html.match(/<\/script>/g) ?? []).length,
        scripts.length,
        `${path}: a value closed a script element early`,
      );

      // The blocks still parse with the hostile text intact inside them.
      for (const block of jsonLdBlocks(html)) asRecord(block);
    }
  });

  it("refuses a page path that would escape the output directory", () => {
    assert.throws(
      () => store.fileFor("/meetings/../../etc/passwd"),
      /not writable as a name/,
      "a traversal path was accepted",
    );
  });

  it("escapes the record in the rendered document, not only on disk", async () => {
    const page = await buildMeetingPage(db, meetingId, BASE);
    assert.ok(page, "the published meeting produced no page");
    const html = renderDocument(page, BASE);
    assert.ok(html.includes("&lt;img"), "hostile text was not escaped into the body");
    assert.ok(html.startsWith("<!doctype html>"), "the document is not a complete document");
  });
});

/**
 * File scope, not inside the describe — `sitemap.test.ts` explains why: a
 * describe's `after` runs the moment that block finishes, so tearing the pool
 * down there kills it for anything declared below. Without this the suite passes
 * and the process never exits, which in a `--test-concurrency=1` run reads
 * exactly like a hang.
 */
after(async () => {
  await db.destroy();
});

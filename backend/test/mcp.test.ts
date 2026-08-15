import { describe, it, before, after, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";

// Must be set before any delivery code resolves the key — `retractSubject` on
// the event spine reaches `services/delivery`.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import db from "../src/config/database";
import mcpRouter, { resetMcpRateLimit } from "../src/routes/mcp";
import {
  handleMcpMessage,
  mcpDiscoveryDocument,
  toolsAreConsistent,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  MCP_TOOLS,
  MCP_MAX_RESULTS,
  type JsonRpcResponse,
  type McpToolResult,
} from "../src/services/delivery/mcp";
import { emitEvent } from "../src/services/events";
import { renderClaim, renderSha256, RENDER_VERSION } from "../src/services/review/claims";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
} from "./helpers/pressroom";

/**
 * The machine channel — delivery §"Two channels beyond the list" (b).
 *
 * An MCP client is a public consumer in exactly the sense a feed reader is, so
 * this suite asserts the same properties the delivery spec requires of every
 * consumer, **on this consumer** rather than on the helpers it borrows:
 *
 *  - **`ops` never reaches it.** With a real ops event in the table, so the
 *    absence is evidence and not an artefact of never having written one.
 *  - **The wall holds in both directions.** An unpublished meeting, its agenda
 *    items, its documents, its claims and its stored text are absent from every
 *    tool; publishing it makes them appear. Absence alone would also hold for a
 *    channel that is simply broken, which is why the second half is here.
 *  - **A held finding and a retracted claim are absent** while the published
 *    ones beside them are present.
 *  - **Every result carries its citation.** A tool result that leaves the
 *    source behind is an unsourced claim inside somebody else's context window,
 *    where nobody can repair it.
 *  - **It is off.** `MCP_ENABLED` unset means both paths 404, which is the whole
 *    claim made by shipping it dark and is one assertion.
 *
 * The router is mounted on a bare app rather than the real one for the reason
 * `feeds.test.ts` gives, and because the real app's own rate limiter would then
 * be counting these requests too.
 */

const app = express().use(express.json()).use(mcpRouter);

const PREFIX = "mcp-test";
const BASE = "https://commissionwatch.example";
const AGENDA_SHA = sha256Of("mcp-test-agenda");
const WITHHELD_SHA = sha256Of("mcp-test-withheld-agenda");
const TERM = "phalaenoptilus";
const DOCUMENT_TEXT = `A stored agenda mentioning the ${TERM} rezone at some length. `.repeat(10);

interface Fixture {
  jurisdictionId: string;
  publishedMeetingId: string;
  withheldMeetingId: string;
  artifactId: string;
  withheldArtifactId: string;
  documentId: string;
  withheldDocumentId: string;
  publishedFlagId: string;
  heldFlagId: string;
  claimId: string;
  retractedClaimId: string;
  memberId: string;
}

let fixture: Fixture;
let CLAIM_TEXT = "";
let RETRACTED_TEXT = "";
const createdEventIds: string[] = [];

/** One JSON-RPC round trip through the module, bypassing HTTP. */
async function call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const response = await handleMcpMessage(db, BASE, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.ok(response !== null, "a request must produce a response");
  assert.ok("result" in response, `tools/call returned an error: ${JSON.stringify(response)}`);
  return response.result as McpToolResult;
}

/** The JSON body of a successful tool call. */
function payload(result: McpToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, `tool refused: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/** Everything a tool said, as one string. The cheapest honest absence test. */
function flatten(result: McpToolResult): string {
  return JSON.stringify(result);
}

async function attachDocument(
  meetingId: string,
  artifactId: string,
  title: string,
): Promise<string> {
  const [document] = await db("meeting_documents")
    .insert({
      meeting_id: meetingId,
      title,
      document_type: "agenda",
      url: `https://example.invalid/${title.replace(/\s+/g, "-")}.pdf`,
    })
    .returning<Array<{ id: string }>>("id");
  await db("document_versions").insert({
    meeting_document_id: document.id,
    artifact_id: artifactId,
    version_no: 1,
  });
  return document.id;
}

before(async () => {
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([AGENDA_SHA, WITHHELD_SHA]);

  const source = await createSource(PREFIX, { enabled: false });
  const publishedMeetingId = await createMeeting(source.commissionId, {
    publishedAt: new Date(),
    date: "2026-08-10",
  });
  const withheldMeetingId = await createMeeting(source.commissionId, {
    publishedAt: null,
    date: "2026-08-12",
  });

  const artifactId = await createArtifact(AGENDA_SHA, "https://example.invalid/mcp-agenda.pdf");
  const withheldArtifactId = await createArtifact(
    WITHHELD_SHA,
    "https://example.invalid/mcp-withheld.pdf",
  );
  await db("artifact_texts").insert([
    { artifact_id: artifactId, text: DOCUMENT_TEXT, char_count: DOCUMENT_TEXT.length },
    { artifact_id: withheldArtifactId, text: DOCUMENT_TEXT, char_count: DOCUMENT_TEXT.length },
  ]);

  const documentId = await attachDocument(publishedMeetingId, artifactId, `${PREFIX} agenda`);
  const withheldDocumentId = await attachDocument(
    withheldMeetingId,
    withheldArtifactId,
    `${PREFIX} withheld agenda`,
  );

  const [publishedFlag] = await db("anomaly_flags")
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

  // Held, on the *published* meeting. The wall this tests is the finding's own
  // review state, and hanging it off an unpublished meeting would have let the
  // meeting wall pass the test for it.
  const [heldFlag] = await db("anomaly_flags")
    .insert({
      meeting_id: publishedMeetingId,
      artifact_id: artifactId,
      flag_type: "closed_door_vote",
      description: `A held finding about the ${TERM} rezone naming Commissioner Fixture`,
      severity: "high",
      source: "auto",
      review_state: "held",
    })
    .returning<Array<{ id: string }>>("id");

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

  RETRACTED_TEXT = renderClaim({
    subject_name: "Commissioner Withdrawn",
    action: "moved",
    matter: "Ordinance 9999",
  });
  const [retracted] = await db("minute_claims")
    .insert({
      meeting_id: publishedMeetingId,
      artifact_sha256: AGENDA_SHA,
      subject_name: "Commissioner Withdrawn",
      action: "moved",
      matter: "Ordinance 9999",
      quote: "Commissioner Withdrawn moved the motion.",
      quote_offset: 60,
      model: "test-model",
      prompt_version: "v0",
      status: "approved",
      rendered_text: RETRACTED_TEXT,
      render_sha256: renderSha256(RETRACTED_TEXT),
      render_version: RENDER_VERSION,
      approved_by: randomUUID(),
      approved_at: new Date(),
      retracted_at: new Date(),
      retracted_reason: "The minutes name a different member.",
    })
    .returning<Array<{ id: string }>>("id");

  const [member] = await db("members")
    .insert({
      jurisdiction_id: source.jurisdictionId,
      name: `${PREFIX} Commissioner`,
      title: "Commissioner",
      term_start: "2024-01-01",
    })
    .returning<Array<{ id: string }>>("id");

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
    publishedMeetingId,
    withheldMeetingId,
    artifactId,
    withheldArtifactId,
    documentId,
    withheldDocumentId,
    publishedFlagId: publishedFlag.id,
    heldFlagId: heldFlag.id,
    claimId: claim.id,
    retractedClaimId: retracted.id,
    memberId: member.id,
  };

  const j = source.jurisdictionId;
  for (const input of [
    { event_type: "meeting.published", subject_kind: "meeting" as const, subject_id: publishedMeetingId, severity: "info" as const },
    { event_type: "finding.published", subject_kind: "finding" as const, subject_id: publishedFlag.id, severity: "high" as const },
    { event_type: "claim.published", subject_kind: "claim" as const, subject_id: claim.id, severity: "medium" as const },
    { event_type: "document.published", subject_kind: "document" as const, subject_id: documentId, severity: "info" as const },
  ]) {
    const emitted = await emitEvent(db, { ...input, jurisdiction_id: j });
    createdEventIds.push(emitted.id);
  }

  // A real ops event, so its absence below is evidence.
  const ops = await emitEvent(db, {
    event_type: "ops.sweep_failed",
    subject_kind: "ops",
    jurisdiction_id: j,
    severity: "critical",
    dedupe_key: `${PREFIX}:ops:sweep_failed:1`,
    payload: { error: `the ${TERM} sweep failed` },
  });
  createdEventIds.push(ops.id);
});

after(async () => {
  await db("deliveries")
    .whereIn("dedupe_key", db("events").whereIn("id", createdEventIds).select("dedupe_key"))
    .del();
  await db("events").whereIn("id", createdEventIds).del();
  if (fixture !== undefined) {
    await db("minute_claims")
      .whereIn("id", [fixture.claimId, fixture.retractedClaimId])
      .del();
    await db("approval_requests")
      .whereIn("anomaly_flag_id", [fixture.publishedFlagId, fixture.heldFlagId])
      .del();
    await db("anomaly_flags")
      .whereIn("id", [fixture.publishedFlagId, fixture.heldFlagId])
      .del();
    await db("document_versions")
      .whereIn("meeting_document_id", [fixture.documentId, fixture.withheldDocumentId])
      .del();
    await db("meeting_documents")
      .whereIn("id", [fixture.documentId, fixture.withheldDocumentId])
      .del();
    await db("members").where({ id: fixture.memberId }).del();
  }
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([AGENDA_SHA, WITHHELD_SHA]);
});

beforeEach(() => {
  resetMcpRateLimit();
});

describe("the MCP endpoint is off unless an operator turns it on", () => {
  it("404s both paths with MCP_ENABLED unset", async () => {
    delete process.env.MCP_ENABLED;
    await request(app).get("/.well-known/mcp.json").expect(404);
    await request(app).get("/mcp").expect(404);
    await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(404);
  });

  it("404s on any value other than the exact string true", async () => {
    process.env.MCP_ENABLED = "1";
    try {
      await request(app).get("/.well-known/mcp.json").expect(404);
    } finally {
      delete process.env.MCP_ENABLED;
    }
  });
});

describe("the MCP transport", () => {
  const previousBase = process.env.PUBLIC_BASE_URL;

  before(() => {
    process.env.MCP_ENABLED = "true";
    process.env.PUBLIC_BASE_URL = BASE;
  });

  after(() => {
    delete process.env.MCP_ENABLED;
    if (previousBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBase;
  });

  it("initializes, echoing a protocol version it speaks", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })
      .expect(200);

    assert.equal(res.body.result.protocolVersion, "2024-11-05");
    assert.equal(res.body.result.serverInfo.name, "commissionwatch");
    assert.deepEqual(res.body.result.capabilities, { tools: { listChanged: false } });
    // The wall is stated to the model before it calls anything, so an absence is
    // reported as "nothing published" rather than as "nothing happened".
    assert.match(res.body.result.instructions, /published/);
  });

  it("answers with its newest version when asked for one it does not speak", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })
      .expect(200);
    assert.equal(res.body.result.protocolVersion, MCP_LATEST_PROTOCOL_VERSION);
    assert.ok((MCP_PROTOCOL_VERSIONS as readonly string[]).includes(MCP_LATEST_PROTOCOL_VERSION));
  });

  it("answers a notification with 202 and no body", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", method: "notifications/initialized" })
      .expect(202);
    assert.equal(res.text, "");
  });

  it("refuses a batch rather than fanning one token into many searches", async () => {
    const res = await request(app)
      .post("/mcp")
      .send([{ jsonrpc: "2.0", id: 1, method: "tools/list" }])
      .expect(400);
    assert.match(res.body.error.message, /Batched/);
  });

  it("405s the SSE half of the transport, because there is no session", async () => {
    const res = await request(app).get("/mcp").expect(405);
    assert.equal(res.headers.allow, "POST");
  });

  it("serves a discovery document naming the endpoint and the tools", async () => {
    const res = await request(app).get("/.well-known/mcp.json").expect(200);
    assert.equal(res.body.endpoint, `${BASE}/mcp`);
    assert.equal(res.body.authentication, "none");
    assert.equal(res.body.tools.length, MCP_TOOLS.length);
  });

  it("503s rather than publish a citation nobody can follow", async () => {
    delete process.env.PUBLIC_BASE_URL;
    try {
      await request(app).get("/.well-known/mcp.json").expect(503);
      await request(app)
        .post("/mcp")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        .expect(503);
    } finally {
      process.env.PUBLIC_BASE_URL = BASE;
    }
  });

  it("names every tool it implements and implements every tool it names", () => {
    assert.equal(toolsAreConsistent(), true);
  });

  it("refuses an unknown method and an unknown tool", async () => {
    const method = await handleMcpMessage(db, BASE, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list",
    });
    assert.ok(method !== null && "error" in method);
    assert.equal(method.error.code, -32601);

    const tool = await handleMcpMessage(db, BASE, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    assert.ok(tool !== null && "error" in tool);
    assert.equal(tool.error.code, -32602);
  });

  it("refuses malformed tool arguments as invalid params, not as a server error", async () => {
    for (const params of [
      { name: "get_meeting", arguments: { meeting_id: "not-a-uuid" } },
      { name: "get_source", arguments: { sha256: "nope" } },
      { name: "search_record", arguments: {} },
      { name: "recent_activity", arguments: { min_severity: "apocalyptic" } },
    ]) {
      const res: JsonRpcResponse | null = await handleMcpMessage(db, BASE, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params,
      });
      assert.ok(res !== null && "error" in res, `${params.name} did not refuse`);
      assert.equal(res.error.code, -32602);
    }
  });

  it("rate limits below the default public tier, because a tool call is a search", async () => {
    resetMcpRateLimit();
    let refused = 0;
    for (let i = 0; i < 65; i += 1) {
      const res = await request(app).get("/.well-known/mcp.json");
      if (res.status === 429) {
        refused += 1;
        assert.ok(res.headers["retry-after"], "a 429 with no Retry-After is an instruction to poll");
      }
    }
    assert.ok(refused > 0, "sixty-five requests a minute must not all be served");
  });
});

describe("the wall, on this consumer", () => {
  it("excludes ops events from recent_activity", async () => {
    const body = payload(await call("recent_activity", { limit: MCP_MAX_RESULTS }));
    const events = body.events as Array<{ urn: string; title: string; summary: string }>;
    assert.ok(events.length >= 4, "the fixture's public events are missing");
    for (const event of events) {
      assert.doesNotMatch(event.urn, /ops/);
    }
    assert.doesNotMatch(JSON.stringify(events), /sweep failed/);
  });

  it("gives every event an on-site link and a citation", async () => {
    const body = payload(await call("recent_activity", { limit: MCP_MAX_RESULTS }));
    const events = body.events as Array<{ url: string; citation: { url: string } }>;
    for (const event of events) {
      assert.ok(event.url.startsWith(BASE), `not absolute: ${event.url}`);
      assert.ok(event.citation.url.length > 0, "an entry with no citation must not be emitted");
    }
  });

  it("refuses an unpublished meeting without saying whether it exists", async () => {
    const meeting = await call("get_meeting", { meeting_id: fixture.withheldMeetingId });
    assert.equal(meeting.isError, true);
    const claims = await call("get_meeting_claims", { meeting_id: fixture.withheldMeetingId });
    assert.equal(claims.isError, true);

    const absent = await call("get_meeting", { meeting_id: randomUUID() });
    // Byte-identical to the withheld answer. Any difference is a way to
    // enumerate the withheld set one id at a time.
    assert.equal(absent.content[0].text, meeting.content[0].text);
  });

  it("keeps an unpublished meeting's text out of get_source", async () => {
    const withheld = await call("get_source", { sha256: WITHHELD_SHA });
    assert.equal(withheld.isError, true);

    const published = payload(await call("get_source", { sha256: AGENDA_SHA }));
    assert.equal(published.sha256, AGENDA_SHA);
    assert.match(String(published.text), new RegExp(TERM));
  });

  it("keeps an unpublished meeting out of search, and lets it in once published", async () => {
    const before = flatten(await call("search_record", { q: TERM }));
    assert.match(before, /Public phalaenoptilus rezone/);
    assert.doesNotMatch(before, /Withheld phalaenoptilus rezone/);

    await db("meetings").where({ id: fixture.withheldMeetingId }).update({ published_at: new Date() });
    try {
      const after = flatten(await call("search_record", { q: TERM }));
      assert.match(after, /Withheld phalaenoptilus rezone/);
    } finally {
      await db("meetings").where({ id: fixture.withheldMeetingId }).update({ published_at: null });
    }
  });

  it("keeps a held finding out of search while the published one beside it is in", async () => {
    const found = flatten(await call("search_record", { q: TERM }));
    assert.match(found, /Only 2 of 5 members present/);
    assert.doesNotMatch(found, /A held finding/);
  });

  it("returns an approved claim with its citation and a retracted one as a tombstone", async () => {
    const body = payload(await call("get_meeting_claims", { meeting_id: fixture.publishedMeetingId }));
    const claims = body.claims as Array<{
      id: string;
      text: string;
      artifact_sha256: string;
      url: string;
      source_url: string;
    }>;

    assert.equal(claims.length, 1, "the retracted claim must not render");
    assert.equal(claims[0].text, CLAIM_TEXT);
    assert.equal(claims[0].artifact_sha256, AGENDA_SHA);
    // A claim is not a page: the link is an anchor inside the meeting record.
    assert.equal(claims[0].url, `${BASE}/meetings/${fixture.publishedMeetingId}#claim-${claims[0].id}`);
    assert.match(claims[0].source_url, /offset=/);

    const tombstones = body.tombstones as Array<{ id: string; retracted_reason: string }>;
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0].id, fixture.retractedClaimId);
    // The withdrawal is visible; the withdrawn sentence is not asserted again.
    assert.doesNotMatch(JSON.stringify(claims), /Commissioner Withdrawn/);
  });

  it("carries the stored document's sha and fetch URL on a meeting", async () => {
    const body = payload(await call("get_meeting", { meeting_id: fixture.publishedMeetingId }));
    const documents = body.documents as Array<{ sha256: string | null; fetched_from: string | null }>;
    assert.equal(documents.length, 1);
    assert.equal(documents[0].sha256, AGENDA_SHA);
    assert.equal(documents[0].fetched_from, "https://example.invalid/mcp-agenda.pdf");

    const items = body.agenda_items as Array<{ title: string }>;
    assert.equal(items.length, 1);
    assert.match(items[0].title, /Public/);
  });

  it("counts an official over published meetings and says so", async () => {
    const body = payload(await call("get_official_votes", { official_id: fixture.memberId }));
    assert.equal(body.counted_over, "published meetings only");
    assert.equal((body.official as { id: string }).id, fixture.memberId);

    const missing = await call("get_official_votes", { official_id: randomUUID() });
    assert.equal(missing.isError, true);
  });

  it("caps what one call can pull back", async () => {
    const body = payload(await call("search_record", { q: TERM, limit: MCP_MAX_RESULTS + 500 }));
    assert.ok((body.results as unknown[]).length <= MCP_MAX_RESULTS);
  });

  it("builds a discovery document whose endpoint is absolute", () => {
    const doc = mcpDiscoveryDocument(BASE);
    assert.equal(doc.endpoint, `${BASE}/mcp`);
  });
});

/**
 * Closing the pool is what lets the process exit. A bare top-level `await`
 * would run before a single test did; it belongs in a file-scope `after`,
 * registered after the fixture teardown above so it runs second.
 */
after(async () => {
  await db.destroy();
});

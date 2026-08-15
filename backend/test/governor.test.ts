import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Must be set before any delivery code resolves the key, for `events.test.ts`'s
// reason: approving a claim emits an event, and the event spine pulls in the
// dispatcher's types and config at module load.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import db from "../src/config/database";
import { DEFAULT_MODEL, OpenRouterClient } from "../src/services/extraction/openrouter";
import { MATTER_WINDOW } from "../src/services/extraction/verify";
import {
  DEFAULT_GOVERNOR_MODEL,
  GovernorMisconfigured,
  assertDistinctModels,
  createGovernorClient,
  extractionModel,
  governorModel,
} from "../src/services/governor/model";
import {
  GOVERNOR_PROMPT_VERSION,
  judgeClaim,
  renderGovernorUser,
} from "../src/services/governor/judge";
import { GOVERNOR_INPUT_KEYS, GOVERNOR_WINDOW, buildGovernorInput, locateInWindow, parseGovernorVerdict, windowSha256 } from "../src/services/governor/verdict";
import {
  createGovernHandler,
  governArtifact,
  heldClaimsFor,
} from "../src/services/governor/stage";
import { governorBacklog, recordVerdict, toClaimVerdict } from "../src/services/governor/store";
import { BlockedError } from "../src/services/ingestion/queue";
import type { GovernContext } from "../src/services/ingestion/worker";
import {
  approveClaim,
  getClaimReview,
  listClaimQueue,
  listPublicClaims,
} from "../src/services/review/claims";
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
 * Pass 2: a second model, asked one question, with less information than the
 * first.
 *
 * `verify.ts` already stops fabricated text — it locates the quote in the
 * artifact bytes, proves the subject is named in it, and refuses motive
 * language. What it cannot decide is which of two names in one sentence an
 * action attaches to:
 *
 *   "Commissioner Sample moved to table the item; Commissioner Fixture seconded."
 *
 * A claim of `Fixture / moved` passes every mechanical check. That gap is the
 * governor's entire job, and these tests hold the properties that make handing
 * it to a model acceptable:
 *
 *  - the judge cannot be shown pass 1's reasoning, because the input type has
 *    no field it could arrive in;
 *  - it is a different model from pass 1, and startup refuses when it is not;
 *  - it must point at the bytes, and a reply whose citation is not in the window
 *    is **void** rather than a rejection — the claim ends up un-judged;
 *  - it cannot approve, cannot delete, and cannot hide. `supported: false` sorts
 *    a claim last and annotates it; the row is still there and a person still
 *    presses the button.
 *
 * Nothing here calls OpenRouter. The client is stubbed at `fetchImpl`, as
 * `extraction.test.ts` does.
 */

const PREFIX = "governor-test";

/** The sentence the whole feature exists for, in situ. */
const CONSENT =
  "Motion to approve Consent Items F.1 through F.22 as presented was made by " +
  "Commissioner Sample and seconded by Commissioner Fixture.";
const TABLING = "Commissioner Fixture moved to table Ordinance 2210 until the January meeting.";

const DOCUMENT_TEXT = [
  "MINUTES OF THE REGULAR MEETING",
  "The meeting was called to order at 6:00 p.m.",
  "C. Consent Agenda",
  CONSENT,
  "The motion passed 5-0.",
  "D. Action Items",
  TABLING,
  "There being no further business, the meeting adjourned at 8:14 p.m.",
].join("\n");

const CONSENT_OFFSET = DOCUMENT_TEXT.indexOf(CONSENT);
const TABLING_OFFSET = DOCUMENT_TEXT.indexOf(TABLING);

interface Fixture {
  commissionId: string;
  meetingId: string;
  artifactId: string;
  artifactSha: string;
  operatorId: string;
}

let fixture: Fixture;
const claimIds: string[] = [];
const extraMeetingIds: string[] = [];
let subjectCounter = 0;

interface ClaimOptions {
  meetingId?: string;
  subjectName?: string;
  action?: string;
  matter?: string | null;
  quote?: string;
  quoteOffset?: number;
}

async function createClaim(options: ClaimOptions = {}): Promise<string> {
  subjectCounter += 1;
  const [row] = await db("minute_claims")
    .insert({
      meeting_id: options.meetingId ?? fixture.meetingId,
      artifact_sha256: fixture.artifactSha,
      subject_name: options.subjectName ?? `Commissioner Fixture ${subjectCounter}`,
      action: options.action ?? "seconded",
      matter: options.matter === undefined ? "Consent Items F.1 through F.22" : options.matter,
      quote: options.quote ?? CONSENT,
      quote_offset: options.quoteOffset ?? CONSENT_OFFSET,
      model: "test-extraction-model",
      prompt_version: "governor-test-v1",
      status: "held",
    })
    .returning<Array<{ id: string }>>("id");
  claimIds.push(row.id);
  return row.id;
}

/** One OpenRouter reply, in the shape the endpoint actually sends. */
function completion(content: string, servedModel = "test/governor:free"): Response {
  return new Response(
    JSON.stringify({
      model: servedModel,
      choices: [{ message: { content }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * A governor client that answers from a script instead of the network.
 *
 * `maxRetries: 0` and a sleep that does not sleep, so the throttled path is
 * exercised in milliseconds rather than in the fourteen seconds the real backoff
 * would take.
 */
function stubClient(replies: Array<() => Response>): OpenRouterClient {
  let index = 0;
  return new OpenRouterClient({
    apiKey: "test-key",
    model: "test/governor:free",
    maxRetries: 0,
    sleep: async () => {},
    logger: { info: () => {}, warn: () => {} },
    fetchImpl: (async () => {
      const next = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return next();
    }) as unknown as typeof fetch,
  });
}

const SUPPORTED_REPLY = JSON.stringify({
  supported: true,
  unsupported_fragments: [],
  relied_on: [CONSENT],
  confidence: "high",
});

const REFUSED_REPLY = JSON.stringify({
  supported: false,
  unsupported_fragments: ["moved"],
  relied_on: [CONSENT],
  confidence: "high",
});

before(async () => {
  const source = await createSource(PREFIX);
  const artifactSha = sha256Of(`${PREFIX}-minutes`);
  const meetingId = await createMeeting(source.commissionId, { publishedAt: new Date() });
  const artifactId = await createArtifact(artifactSha, "https://example.invalid/minutes.pdf");
  await db("artifact_texts").insert({
    artifact_id: artifactId,
    text: DOCUMENT_TEXT,
    char_count: DOCUMENT_TEXT.length,
  });

  const email = `${PREFIX}@example.invalid`;
  await signInOperator(email, "Governor Test Operator");
  const operator = await db("operators").where({ email }).first<{ id: string }>("id");
  assert.ok(operator, "the suite operator was not created");

  fixture = {
    commissionId: source.commissionId,
    meetingId,
    artifactId,
    artifactSha,
    operatorId: operator.id,
  };
});

after(async () => {
  const subjectIds = [...claimIds, ...extraMeetingIds, fixture.meetingId];
  const events = await db("events")
    .whereIn("subject_id", subjectIds)
    .select<Array<{ id: string; dedupe_key: string }>>("id", "dedupe_key");
  if (events.length > 0) {
    await db("deliveries")
      .whereIn(
        "dedupe_key",
        events.map((row) => row.dedupe_key),
      )
      .del();
    await db("events")
      .whereIn(
        "id",
        events.map((row) => row.id),
      )
      .del();
  }

  // `claim_verdicts` cascades from `minute_claims`, which is the point of the
  // foreign key: a claim that goes takes its judgements with it.
  await db("minute_claims").whereIn("id", claimIds).del();
  await db("artifact_texts").where({ artifact_id: fixture.artifactId }).del();
  await db("meetings").whereIn("id", extraMeetingIds).del();
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([fixture.artifactSha]);
  await db("operators").where({ email: `${PREFIX}@example.invalid` }).del();
  await db.destroy();
});

/* ------------------------------------------------------------------------- */

describe("the judge is told nothing the record does not say", () => {
  it("has no field pass 1's reasoning could arrive in", () => {
    // Structural, not a comment. A judge shown the advocate's argument agrees
    // with it, so the enforcement has to be the shape of the type: adding a
    // `confidence` or a `reasoning` field to `GovernorInput` fails here.
    const input = buildGovernorInput(DOCUMENT_TEXT, {
      subject_name: "Commissioner Fixture",
      action: "seconded",
      matter: "Consent Items F.1 through F.22",
      quote: CONSENT,
      quote_offset: CONSENT_OFFSET,
    });

    assert.deepEqual(Object.keys(input), [...GOVERNOR_INPUT_KEYS]);
    for (const key of Object.keys(input)) {
      assert.doesNotMatch(
        key,
        /reason|rationale|thought|chain|confidence|score|explanation|extractor/i,
        `'${key}' is a channel for pass 1's reasoning`,
      );
    }
  });

  it("puts nothing in the prompt that is not in the input", () => {
    const input = buildGovernorInput(DOCUMENT_TEXT, {
      subject_name: "Commissioner Fixture",
      action: "seconded",
      matter: null,
      quote: CONSENT,
      quote_offset: CONSENT_OFFSET,
    });
    const rendered = renderGovernorUser(input);

    assert.ok(rendered.includes(input.window));
    assert.ok(rendered.includes("Commissioner Fixture"));
    // The extractor's own model id and prompt version are on the claim row and
    // stay there. Naming the model that proposed a claim to the model judging it
    // is the same leak as showing it the reasoning.
    assert.ok(!rendered.includes("test-extraction-model"));
    assert.ok(!rendered.includes(DEFAULT_MODEL));
  });

  it("reads exactly the window the matter check already uses", () => {
    // One constant. Two would eventually disagree and nobody would notice.
    assert.equal(GOVERNOR_WINDOW, MATTER_WINDOW);
    assert.equal(GOVERNOR_WINDOW, 2000);

    const long = `${"x".repeat(9000)}${CONSENT}${"y".repeat(9000)}`;
    const input = buildGovernorInput(long, {
      subject_name: "Commissioner Fixture",
      action: "seconded",
      matter: null,
      quote: CONSENT,
      quote_offset: 9000,
    });
    assert.equal(input.window_offset, 9000 - GOVERNOR_WINDOW);
    assert.equal(input.window.length, CONSENT.length + 2 * GOVERNOR_WINDOW);
    assert.ok(input.window.includes(CONSENT));
  });
});

describe("two pins, and they may not be the same pin", () => {
  it("refuses to run a governor that is the extractor", () => {
    // A model judging its own output is a rubber stamp: the second pass would
    // report nothing the first pass did not already believe, at twice the cost.
    assert.throws(
      () => assertDistinctModels(DEFAULT_MODEL, DEFAULT_MODEL),
      (error: unknown) => {
        assert.ok(error instanceof GovernorMisconfigured);
        assert.match(error.message, /same model as the extractor/);
        return true;
      },
    );
    // Trimmed, because these arrive from the environment.
    assert.throws(() => assertDistinctModels(" a:free", "a:free "), GovernorMisconfigured);
  });

  it("refuses at the point the client is built, not halfway through a batch", () => {
    const previous = process.env.GOVERNOR_MODEL;
    process.env.GOVERNOR_MODEL = extractionModel();
    try {
      assert.throws(() => createGovernorClient({ apiKey: "test-key" }), GovernorMisconfigured);
    } finally {
      if (previous === undefined) delete process.env.GOVERNOR_MODEL;
      else process.env.GOVERNOR_MODEL = previous;
    }
  });

  it("holds the governor pin to the free-models-only rule", () => {
    // The allowlist is the only thing between a typo and a bill, and it applies
    // to pass 2 exactly as it applies to pass 1.
    assert.throws(
      () => createGovernorClient({ apiKey: "test-key", model: "anthropic/claude-opus-4" }),
      /free models only/,
    );
  });

  it("ships a default governor that is not the default extractor", () => {
    assert.notEqual(DEFAULT_GOVERNOR_MODEL, DEFAULT_MODEL);
    assert.ok(DEFAULT_GOVERNOR_MODEL.endsWith(":free"));
    assert.notEqual(governorModel(), extractionModel());
  });
});

describe("a verdict must point at the bytes", () => {
  const window = DOCUMENT_TEXT;

  it("accepts a reply that cites wording the window contains", () => {
    const parsed = parseGovernorVerdict(SUPPORTED_REPLY, window);
    assert.ok(parsed.ok);
    assert.equal(parsed.verdict.supported, true);
    assert.equal(parsed.verdict.confidence, "high");
    assert.equal(parsed.verdict.relied_on.length, 1);
    // The span is located in the window, not arithmetic the model was trusted
    // with. It must slice back to the sentence it says it relied on.
    const span = parsed.verdict.relied_on[0];
    assert.equal(window.slice(span.start, span.end), CONSENT);
  });

  it("treats a refusal that names nothing as void, not as a rejection", () => {
    // The distinction the whole feature turns on. A judge that cannot say WHAT
    // is wrong has not judged, and reading its silence as a refusal would push
    // true claims to the bottom of an operator's queue on no evidence.
    const parsed = parseGovernorVerdict(
      JSON.stringify({
        supported: false,
        unsupported_fragments: [],
        relied_on: [CONSENT],
        confidence: "high",
      }),
      window,
    );
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, "no-unsupported-fragments");
  });

  it("voids a reply that relies on wording the window does not contain", () => {
    // Same failure as a hallucinated quote, one layer up. We do not trust the
    // extraction and we do not trust the judge either.
    const parsed = parseGovernorVerdict(
      JSON.stringify({
        supported: false,
        unsupported_fragments: ["moved"],
        relied_on: ["Commissioner Fixture moved to approve the consent agenda."],
        confidence: "high",
      }),
      window,
    );
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, "relied-on-not-in-window");
  });

  it("voids a reply that cites nothing at all", () => {
    const parsed = parseGovernorVerdict(
      JSON.stringify({
        supported: true,
        unsupported_fragments: [],
        relied_on: [],
        confidence: "low",
      }),
      window,
    );
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, "no-relied-on");
  });

  it("voids a reply that contradicts itself", () => {
    const parsed = parseGovernorVerdict(
      JSON.stringify({
        supported: true,
        unsupported_fragments: ["moved"],
        relied_on: [CONSENT],
        confidence: "high",
      }),
      window,
    );
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, "fragments-with-support");
  });

  it("voids prose, a bad confidence and a missing verdict separately", () => {
    // Closed reasons rather than one "unreadable", because the counts have to be
    // addable: "the model answers in prose" and "the model invents a confidence"
    // are different problems with different answers.
    const prose = parseGovernorVerdict("I think this is fine, honestly.", window);
    assert.ok(!prose.ok);
    assert.equal(prose.reason, "no-json");

    const confidence = parseGovernorVerdict(
      JSON.stringify({
        supported: true,
        unsupported_fragments: [],
        relied_on: [CONSENT],
        confidence: "certain",
      }),
      window,
    );
    assert.ok(!confidence.ok);
    assert.equal(confidence.reason, "bad-confidence");

    const missing = parseGovernorVerdict(
      JSON.stringify({ unsupported_fragments: [], relied_on: [CONSENT], confidence: "high" }),
      window,
    );
    assert.ok(!missing.ok);
    assert.equal(missing.reason, "bad-supported");
  });

  it("locates a citation whose whitespace differs from the document's", () => {
    // PDF text extraction reconstructs lines from glyph positions, so requiring
    // byte equality would void true citations for typography.
    const span = locateInWindow(window, CONSENT.replace(/ /g, "\n  "));
    assert.ok(span !== null);
    assert.equal(window.slice(span.start, span.end), CONSENT);
  });
});

describe("judging one claim", () => {
  const input = () =>
    buildGovernorInput(DOCUMENT_TEXT, {
      subject_name: "Commissioner Fixture",
      action: "seconded",
      matter: "Consent Items F.1 through F.22",
      quote: CONSENT,
      quote_offset: CONSENT_OFFSET,
    });

  it("returns a verdict and the reply that produced it", async () => {
    const outcome = await judgeClaim(stubClient([() => completion(SUPPORTED_REPLY)]), input());
    assert.equal(outcome.state, "judged");
    if (outcome.state !== "judged") return;
    assert.equal(outcome.verdict.supported, true);
    assert.equal(outcome.servedModel, "test/governor:free");
    // Verbatim, because the first time this project disagrees with a model the
    // question will be "what did it actually say".
    assert.equal(outcome.raw, SUPPORTED_REPLY);
  });

  it("reports a throttled claim as unreached, never as unsupported", async () => {
    const outcome = await judgeClaim(
      stubClient([() => new Response("rate limited", { status: 429 })]),
      input(),
    );
    assert.equal(outcome.state, "unreached");
    if (outcome.state !== "unreached") return;
    assert.equal(outcome.retryable, true);
  });
});

describe("a pass over one artifact", () => {
  it("judges every held claim and records what it found", async () => {
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    extraMeetingIds.push(meetingId);
    const good = await createClaim({ meetingId, subjectName: "Commissioner Fixture A" });
    const bad = await createClaim({
      meetingId,
      subjectName: "Commissioner Fixture B",
      action: "moved",
      quoteOffset: CONSENT_OFFSET,
    });

    const client = stubClient([
      () => completion(SUPPORTED_REPLY),
      () => completion(REFUSED_REPLY),
    ]);
    const tally = await governArtifact(db, client, {
      documentText: DOCUMENT_TEXT,
      meetingId,
      artifactSha256: fixture.artifactSha,
    });

    assert.equal(tally.claims, 2);
    assert.equal(tally.judged, 2);
    assert.equal(tally.unsupported, 1);

    const rows = await db("claim_verdicts")
      .whereIn("claim_id", [good, bad])
      .select<Array<Record<string, unknown>>>("*");
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.prompt_version, GOVERNOR_PROMPT_VERSION);
      // The model that ANSWERED, not the id requested — `minute_claims.model`
      // follows the same rule and for the same reason.
      assert.equal(row.model, "test/governor:free");
      assert.match(String(row.window_sha256), /^[0-9a-f]{64}$/);
    }

    // The governor cannot approve. Nothing it wrote touched the claim rows.
    const claims = await db("minute_claims")
      .whereIn("id", [good, bad])
      .select<Array<{ status: string }>>("status");
    assert.deepEqual(
      claims.map((row) => row.status),
      ["held", "held"],
    );
  });

  it("re-running over unchanged bytes with an unchanged model writes nothing", async () => {
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    extraMeetingIds.push(meetingId);
    const claimId = await createClaim({ meetingId, subjectName: "Commissioner Fixture C" });

    const run = () =>
      governArtifact(db, stubClient([() => completion(SUPPORTED_REPLY)]), {
        documentText: DOCUMENT_TEXT,
        meetingId,
        artifactSha256: fixture.artifactSha,
      });

    const first = await run();
    const second = await run();
    assert.equal(first.judged, 1);
    // Skipped before the call, not deduped after it: re-running the governor has
    // to be cheap enough to be an operator action.
    assert.equal(second.judged, 0);
    assert.equal(second.unchanged, 1);

    const rows = await db("claim_verdicts").where({ claim_id: claimId }).select("id");
    assert.equal(rows.length, 1);
  });

  it("counts a void reply and a throttled call as unjudged, and stores neither", async () => {
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    extraMeetingIds.push(meetingId);
    const voided = await createClaim({ meetingId, subjectName: "Commissioner Fixture D" });
    const throttled = await createClaim({
      meetingId,
      subjectName: "Commissioner Fixture E",
      quoteOffset: TABLING_OFFSET,
      quote: TABLING,
    });

    const client = stubClient([
      () =>
        completion(
          JSON.stringify({
            supported: false,
            unsupported_fragments: [],
            relied_on: [CONSENT],
            confidence: "high",
          }),
        ),
      () => new Response("rate limited", { status: 429 }),
    ]);
    const tally = await governArtifact(db, client, {
      documentText: DOCUMENT_TEXT,
      meetingId,
      artifactSha256: fixture.artifactSha,
    });

    assert.equal(tally.voided, 1);
    assert.equal(tally.unreached, 1);
    assert.equal(tally.judged, 0);
    const rows = await db("claim_verdicts").whereIn("claim_id", [voided, throttled]).select("id");
    assert.equal(rows.length, 0, "a void reply must leave no record of a judgement");
  });

  it("reads only held claims", async () => {
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    extraMeetingIds.push(meetingId);
    const held = await createClaim({ meetingId, subjectName: "Commissioner Fixture F" });
    const decided = await createClaim({ meetingId, subjectName: "Commissioner Fixture G" });
    await db("minute_claims").where({ id: decided }).update({ status: "rejected" });

    const claims = await heldClaimsFor(db, meetingId, fixture.artifactSha);
    assert.deepEqual(
      claims.map((claim) => claim.id),
      [held],
      "a claim an operator already decided is not the governor's business",
    );
  });

  it("blocks rather than retries when the deployment has no key", async () => {
    const context: GovernContext = {
      stage: "govern",
      jobId: "00000000-0000-4000-8000-000000000011",
      runId: "00000000-0000-4000-8000-000000000012",
      attempts: 1,
      db,
      signal: new AbortController().signal,
      enqueue: async () => {
        throw new Error("the govern stage enqueues nothing");
      },
      target: { sha256: fixture.artifactSha, meetingId: fixture.meetingId },
      artifact: {
        id: fixture.artifactId,
        sha256: fixture.artifactSha,
        storageKey: `artifacts/${fixture.artifactSha.slice(0, 2)}/${fixture.artifactSha}`,
        contentType: "application/pdf",
        sourceUrl: "https://example.invalid/minutes.pdf",
        byteSize: 16,
        fetchedAt: new Date(),
      },
      content: Buffer.from("%PDF-1.4 minutes"),
    };

    const handler = createGovernHandler({
      client: new OpenRouterClient({
        apiKey: "",
        model: "test/governor:free",
        logger: { info: () => {}, warn: () => {} },
      }),
    });

    // Five attempts would not conjure an API key, and "attempts exhausted" hides
    // the reason behind a retry count.
    await assert.rejects(
      () => handler(context),
      (error: unknown) => {
        assert.ok(error instanceof BlockedError);
        assert.match(error.message, /OPENROUTER_API_KEY/);
        return true;
      },
    );
  });
});

describe("storage is idempotent on the question, not on the answer", () => {
  it("inserts one row for one question asked twice", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Fixture H" });
    const window = buildGovernorInput(DOCUMENT_TEXT, {
      subject_name: "Commissioner Fixture H",
      action: "seconded",
      matter: null,
      quote: CONSENT,
      quote_offset: CONSENT_OFFSET,
    }).window;

    const input = {
      claimId,
      model: "test/governor:free",
      promptVersion: GOVERNOR_PROMPT_VERSION,
      verdict: {
        supported: true,
        unsupported_fragments: [],
        relied_on: [{ start: 0, end: 10 }],
        confidence: "high" as const,
      },
      windowSha256: windowSha256(window),
      raw: SUPPORTED_REPLY,
    };

    assert.equal(await recordVerdict(db, input), true);
    assert.equal(await recordVerdict(db, input), false);
    const rows = await db("claim_verdicts").where({ claim_id: claimId }).select("id");
    assert.equal(rows.length, 1);

    // A different window is a different question. If the county reissues its
    // minutes the old verdict is visibly stale rather than quietly reused.
    assert.equal(
      await recordVerdict(db, { ...input, windowSha256: windowSha256(`${window} revised`) }),
      true,
    );
    const after = await db("claim_verdicts").where({ claim_id: claimId }).select("id");
    assert.equal(after.length, 2);
  });
});

describe("what a verdict changes, and what it does not", () => {
  it("keeps a refused claim in the queue, last, and still decidable", async () => {
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    extraMeetingIds.push(meetingId);

    // Created first and cited earliest, so every other ordering key would put it
    // at the top. Only the verdict moves it.
    const refused = await createClaim({
      meetingId,
      subjectName: "Commissioner Fixture Refused",
      action: "moved",
      quoteOffset: CONSENT_OFFSET,
    });
    const supported = await createClaim({
      meetingId,
      subjectName: "Commissioner Fixture Supported",
      quoteOffset: CONSENT_OFFSET + 1,
    });
    const unjudged = await createClaim({
      meetingId,
      subjectName: "Commissioner Fixture Unjudged",
      quoteOffset: TABLING_OFFSET,
      quote: TABLING,
    });

    await governArtifact(
      db,
      stubClient([() => completion(REFUSED_REPLY), () => completion(SUPPORTED_REPLY)]),
      { documentText: DOCUMENT_TEXT, meetingId, artifactSha256: fixture.artifactSha },
    );
    // The third claim's reply never arrives, so it stays un-judged.
    await db("claim_verdicts").where({ claim_id: unjudged }).del();

    const listing = await listClaimQueue(db, { meeting_id: meetingId });
    const order = listing.data.map((item) => item.claim.id);
    assert.equal(order.length, 3, "a refused claim is not deleted and not hidden");
    assert.equal(order[order.length - 1], refused, "a refused claim does not sort last");
    assert.ok(order.indexOf(supported) < order.indexOf(refused));
    assert.ok(order.indexOf(unjudged) < order.indexOf(refused));

    const byId = new Map(listing.data.map((item) => [item.claim.id, item]));
    const refusedItem = byId.get(refused);
    assert.ok(refusedItem);
    assert.equal(refusedItem.governor?.state, "governor_rejected");
    // It points: the operator is shown what the window does not support.
    assert.deepEqual(refusedItem.governor?.unsupported_fragments, ["moved"]);
    // And it is still `held`, still approvable. The governor annotates and
    // orders human review; it never decides it.
    assert.equal(refusedItem.claim.status, "held");
    assert.equal(refusedItem.render.approvable, true);

    assert.equal(byId.get(supported)?.governor?.state, "supported");
  });

  it("labels an unjudged claim rather than dropping or approving it", async () => {
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    extraMeetingIds.push(meetingId);
    const claimId = await createClaim({ meetingId, subjectName: "Commissioner Fixture Unchecked" });

    const item = await getClaimReview(db, claimId);
    assert.ok(item);
    // `blocked` is not `pass`, and it is not `fail` either. Null is the label.
    assert.equal(item.governor, null);
    assert.equal(item.claim.status, "held");

    const listing = await listClaimQueue(db, { meeting_id: meetingId });
    assert.deepEqual(
      listing.data.map((entry) => entry.claim.id),
      [claimId],
    );
  });

  it("counts the backlog, because a silent one looks like an empty one", async () => {
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    extraMeetingIds.push(meetingId);

    const before = await governorBacklog(db);
    await createClaim({ meetingId, subjectName: "Commissioner Fixture Backlog" });
    const after = await governorBacklog(db);
    assert.equal(after, before + 1);

    const listing = await listClaimQueue(db, { meeting_id: meetingId });
    assert.equal(listing.counts.governor_unjudged, after);

    await governArtifact(db, stubClient([() => completion(SUPPORTED_REPLY)]), {
      documentText: DOCUMENT_TEXT,
      meetingId,
      artifactSha256: fixture.artifactSha,
    });
    assert.equal(await governorBacklog(db), before);
  });
});

describe("the pin the review screen approves", () => {
  it("shows the operator the exact sentence the public page renders", async () => {
    // The one test that keeps published-claim §4 honest. An operator approving
    // one string while the reader sees another makes the approval meaningless,
    // and a verdict attached to a sentence nobody approved is worse than none.
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    extraMeetingIds.push(meetingId);
    const claimId = await createClaim({
      meetingId,
      subjectName: "Commissioner Fixture Pinned",
      action: "seconded",
      matter: "Consent Items F.1 through F.22",
    });

    const review = await getClaimReview(db, claimId);
    assert.ok(review);
    const proposed = review.render.text;
    assert.ok(proposed !== null);

    await approveClaim(db, {
      claimId,
      reason: "Checked the minutes against the citation.",
      actor: { id: fixture.operatorId, email: `${PREFIX}@example.invalid` },
    });

    const published = await listPublicClaims(db, meetingId);
    assert.equal(published.claims.length, 1);
    assert.equal(published.claims[0].text, proposed);
  });
});


/**
 * `relied_on` indexes the governor's ±2,000-character window, and nothing
 * serves that window: the review screen shows ±500 characters and the artifact
 * viewer shows its own slice.
 *
 * The governor UI refused to draw those spans for exactly that reason, and it
 * was right — a consumer handed window-relative offsets and a different window
 * marks arbitrary characters *with the authority of a highlight*, which is worse
 * than marking nothing. `relied_on_document` re-bases them so any window can map
 * them, using the governor window's own deterministic start.
 */
describe("relied_on in document coordinates", () => {
  it("re-bases the spans by the governor window's start", () => {
    const quoteOffset = GOVERNOR_WINDOW + 500;
    const verdict = toClaimVerdict({
      governor_supported: false,
      governor_unsupported_fragments: JSON.stringify(["moved"]),
      governor_relied_on: JSON.stringify([{ start: 10, end: 20 }]),
      governor_confidence: "high",
      governor_model: "test/model:free",
      governor_prompt_version: "test.1",
      governor_window_sha256: "a".repeat(64),
      governor_created_at: new Date(0),
      quote_offset: quoteOffset,
    });

    assert.ok(verdict);
    // Window-relative offsets are untouched: they are what was located against
    // the judged bytes, and rewriting them would lose that.
    assert.deepEqual(verdict.relied_on, [{ start: 10, end: 20 }]);
    // Document-relative are those plus the window's start, which is
    // max(0, quote_offset - GOVERNOR_WINDOW) = 500 here.
    assert.deepEqual(verdict.relied_on_document, [{ start: 510, end: 520 }]);
  });

  /**
   * A quote near the top of a document has its window clamped at zero, so the
   * two coordinate systems coincide. Getting this wrong would shift every span
   * on every early-document claim by a constant nobody would notice.
   */
  it("clamps at the start of the document rather than going negative", () => {
    const verdict = toClaimVerdict({
      governor_supported: true,
      governor_unsupported_fragments: JSON.stringify([]),
      governor_relied_on: JSON.stringify([{ start: 4, end: 9 }]),
      governor_confidence: "medium",
      governor_model: "test/model:free",
      governor_prompt_version: "test.1",
      governor_window_sha256: "b".repeat(64),
      governor_created_at: new Date(0),
      quote_offset: 12,
    });

    assert.ok(verdict);
    assert.deepEqual(verdict.relied_on_document, [{ start: 4, end: 9 }]);
  });
});

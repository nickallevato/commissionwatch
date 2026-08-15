import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import {
  assertFreeModel,
  diagnoseEmptyCompletion,
  DEFAULT_MODEL,
  EmptyCompletionError,
  OpenRouterClient,
  OpenRouterError,
  readMessageText,
} from "../src/services/extraction/openrouter";
import {
  locateQuote,
  namesAnOfficial,
  subjectPerformedAction,
  verifiedMatter,
  verifyClaims,
  MIN_QUOTE_LENGTH,
} from "../src/services/extraction/verify";
import {
  chunkText,
  dedupeClaims,
  extractClaims,
  persistClaims,
  pruneDisallowedClaims,
  readClaims,
  PROMPT_VERSION,
  REPLY_SAMPLE_LENGTH,
  type ExtractionOutcome,
  type FailedChunk,
} from "../src/services/extraction/extractor";
import {
  asReason,
  classifyExtraction,
  CHUNK_FAILURE_REASONS,
  failRun,
  finishRun,
  isExtracting,
  listRuns,
  startRun,
  summariseFailures,
  toFailedChunk,
} from "../src/services/extraction/runs";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * The first feature in this project whose output is written by a language
 * model, and the guard rails that make that acceptable.
 *
 * The premise: **we do not trust the model, we test it against the bytes.** A
 * claim asserting that a named commissioner voted a particular way is the most
 * damaging thing CommissionWatch could get wrong, and no amount of prompt
 * quality is a defence — the prompt that behaves a hundred times invents a name
 * on the hundred-and-first. Locating the quotation in the stored document is a
 * defence, because a sentence that is not in the document cannot be found in
 * it.
 *
 * Most of what follows is therefore adversarial: the tests supply the output a
 * bad model would produce and assert that none of it survives.
 */

const PREFIX = "extraction-test";

/** A short set of minutes in the shape Bozeman's actually take. */
const MINUTES = `
CITY COMMISSION MINUTES
Tuesday, June 3, 2026

A. Call to Order
Mayor Terry Cunningham called the meeting to order at 6:00 p.m.

B. Consent Agenda
Commissioner Jennifer Madgic moved to approve the consent agenda as presented.
Commissioner Douglas Fischer seconded the motion.
The motion passed 5-0.

C. Action Items
C.1 Resolution 5512, Amending the Unified Development Code
Commissioner Emma Bode voted no on Resolution 5512.
Commissioner Jennifer Madgic voted yes on Resolution 5512.
Mayor Terry Cunningham was absent for the vote on Resolution 5512.
`.trim();

/** A failed chunk whose diagnosis is not the thing under test. */
const failedChunk = (index: number, error: string): FailedChunk => ({
  index,
  error,
  reason: "request-failed",
  finish_reason: null,
  native_finish_reason: null,
});

after(async () => {
  await cleanupByPrefix(PREFIX);
  await db.destroy();
});

describe("free models only, enforced in code", () => {
  it("refuses a model id that is not free", () => {
    // A configuration setting would express the operator's "free models"
    // instruction; it would not enforce it, and the failure mode of a mis-set
    // id is a bill rather than an error.
    assert.throws(
      () => assertFreeModel("anthropic/claude-opus-4"),
      /free models only/,
    );
  });

  it("accepts a free model", () => {
    assert.doesNotThrow(() => assertFreeModel("meta-llama/llama-3.3-70b-instruct:free"));
    assert.ok(DEFAULT_MODEL.endsWith(":free"), "the default model must itself be free");
  });

  it("refuses at construction, not at call time", () => {
    // So a misconfigured deployment fails when the client is built rather than
    // halfway through a batch of meetings.
    assert.throws(() => new OpenRouterClient({ model: "openai/gpt-4o" }), OpenRouterError);
  });

  it("treats an empty OPENROUTER_MODEL as unset, because Compose sets it empty", async () => {
    // Not a hypothetical. `- OPENROUTER_MODEL=${OPENROUTER_MODEL:-}` in
    // deploy/docker-compose.shared.yml puts an EMPTY STRING in the container
    // whenever the host has no value, and `??` passes an empty string straight
    // through. The documented default was therefore unreachable on precisely
    // the deployment it was written for, and the client threw
    // "Refusing to call ''" instead — a configuration bug wearing the costume
    // of the safety check.
    const previous = process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_MODEL = "";
    try {
      const client = new OpenRouterClient({ apiKey: "k" });
      assert.equal(client.model, DEFAULT_MODEL);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_MODEL;
      else process.env.OPENROUTER_MODEL = previous;
    }
  });

  it("still honours an explicitly set OPENROUTER_MODEL, and still checks it is free", () => {
    const previous = process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_MODEL = "  openai/gpt-4o  ";
    try {
      // Whitespace trimmed, and then refused on its merits — a padded id must
      // not slip past the free check by failing to match the suffix.
      assert.throws(() => new OpenRouterClient({ apiKey: "k" }), /free models only/);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_MODEL;
      else process.env.OPENROUTER_MODEL = previous;
    }
  });

  it("treats an empty OPENROUTER_API_KEY as unconfigured", () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "   ";
    try {
      assert.equal(new OpenRouterClient().configured, false);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("says so plainly when no key is configured, rather than pretending", async () => {
    const client = new OpenRouterClient({ apiKey: "", model: DEFAULT_MODEL });
    await assert.rejects(
      () => client.complete({ system: "s", user: "u" }),
      /OPENROUTER_API_KEY is not set/,
    );
  });
});

describe("the rate limit a free tier will actually produce", () => {
  it("retries a 429 and then succeeds", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: DEFAULT_MODEL,
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        if (calls < 3) return new Response("rate limited", { status: 429 });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "[]" } }] }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    const reply = await client.complete({ system: "s", user: "u" });
    assert.equal(reply.text, "[]");
    assert.equal(calls, 3);
    // The payload named no model, so the requested id is the honest record.
    assert.equal(reply.servedModel, DEFAULT_MODEL);
  });

  it("records the model that actually answered, not the one requested", async () => {
    // A router serves a different model per call. `minute_claims.model` exists
    // so a model that turns out to be bad can be found again, and it can only
    // do that if it names the model that wrote the row.
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: "openrouter/free",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            model: "cohere/north-mini-code:free",
            choices: [{ message: { content: "[]" } }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    const reply = await client.complete({ system: "s", user: "u" });
    assert.equal(reply.servedModel, "cohere/north-mini-code:free");
    assert.equal(client.model, "openrouter/free");
  });

  it("accepts the zero-priced router even though it has no ':free' suffix", () => {
    // `openrouter/free` prices prompt and completion at 0 but does not carry
    // the suffix. An explicit allowlist, so "is this free" stays one readable
    // decision rather than a looser rule that would also admit paid ids.
    assert.doesNotThrow(() => assertFreeModel("openrouter/free"));
    assert.throws(() => assertFreeModel("openrouter/auto"), /free models only/);
  });

  it("gives up loudly rather than returning an empty answer", async () => {
    // The important half. A throttled call that resolved to "no claims" would
    // record a meeting as having had no votes.
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: DEFAULT_MODEL,
      maxRetries: 1,
      sleep: async () => {},
      fetchImpl: (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    await assert.rejects(() => client.complete({ system: "s", user: "u" }), /rate-limited/);
  });

  it("reads nothing out of a malformed payload", () => {
    assert.equal(readMessageText({ choices: [] }), null);
    assert.equal(readMessageText({ choices: [{ message: {} }] }), null);
    assert.equal(readMessageText("not an object"), null);
    assert.equal(readMessageText({ choices: [{ message: { content: "ok" } }] }), "ok");
  });
});

describe("locating a quotation in the record", () => {
  it("finds a verbatim sentence and reports where it is", () => {
    const offset = locateQuote(MINUTES, "Commissioner Emma Bode voted no on Resolution 5512.");
    assert.ok(offset !== null);
    assert.ok(MINUTES.slice(offset).startsWith("Commissioner Emma Bode voted no"));
  });

  it("tolerates the whitespace that PDF extraction invents", () => {
    // `pdf-text.ts` rebuilds lines from positioned glyph runs, so a single
    // space can arrive as a newline. Rejecting a true citation over typography
    // would lose real evidence.
    const offset = locateQuote(MINUTES, "Commissioner  Douglas\n  Fischer   seconded the motion.");
    assert.ok(offset !== null, "whitespace variation should still match");
  });

  it("does not find a sentence the document does not contain", () => {
    assert.equal(
      locateQuote(MINUTES, "Commissioner Emma Bode voted yes on Resolution 5512."),
      null,
    );
  });
});

describe("what a bad model produces, and what survives it", () => {
  it("keeps a claim whose quotation is really there", () => {
    const { verified, rejected } = verifyClaims(MINUTES, [
      {
        subject_name: "Commissioner Emma Bode",
        action: "voted_no",
        matter: "Resolution 5512",
        quote: "Commissioner Emma Bode voted no on Resolution 5512.",
      },
    ]);
    assert.equal(rejected.length, 0);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].subject_name, "Commissioner Emma Bode");
    assert.ok(verified[0].quote_offset > 0);
  });

  it("rejects a fabricated quotation outright", () => {
    // The headline failure: a plausible sentence, a real person, a real
    // resolution — and the document never says it.
    const { verified, rejected } = verifyClaims(MINUTES, [
      {
        subject_name: "Commissioner Emma Bode",
        action: "voted_yes",
        matter: "Resolution 5512",
        quote: "Commissioner Emma Bode voted yes on Resolution 5512 after long deliberation.",
      },
    ]);
    assert.equal(verified.length, 0);
    assert.equal(rejected[0].reason, "quote-not-found");
  });

  it("rejects a real quotation attached to the wrong person", () => {
    // The subtlest one, and the most dangerous: the citation verifies, so the
    // check that looks most convincing passes, while the attribution is
    // invented.
    const { verified, rejected } = verifyClaims(MINUTES, [
      {
        subject_name: "Commissioner Emma Bode",
        action: "seconded",
        matter: "consent agenda",
        quote: "Commissioner Douglas Fischer seconded the motion.",
      },
    ]);
    assert.equal(verified.length, 0);
    assert.equal(rejected[0].reason, "subject-not-in-quote");
  });

  it("rejects a quotation too short to identify anything", () => {
    // "Yes." appears everywhere in a set of minutes. Locating it proves
    // nothing about which vote it belongs to — a check that passes and means
    // nothing is worse than no check.
    const { verified, rejected } = verifyClaims(MINUTES, [
      {
        subject_name: "Commissioner Emma Bode",
        action: "voted_no",
        matter: null,
        quote: "voted no",
      },
    ]);
    assert.equal(verified.length, 0);
    assert.equal(rejected[0].reason, "quote-too-short");
    assert.ok(MIN_QUOTE_LENGTH > 8);
  });

  it("rejects an action the schema does not name", () => {
    const { verified, rejected } = verifyClaims(MINUTES, [
      {
        subject_name: "Commissioner Emma Bode",
        action: "opposed_the_developers",
        matter: null,
        quote: "Commissioner Emma Bode voted no on Resolution 5512.",
      },
    ]);
    assert.equal(verified.length, 0);
    assert.equal(rejected[0].reason, "unknown-action");
  });

  it("rejects a claim that asserts a motive, however well cited", () => {
    // The project's oldest rule, applied to generated text. This one has a
    // genuine verbatim quote; it is refused for what it adds around it.
    const { verified, rejected } = verifyClaims(MINUTES, [
      {
        subject_name: "Commissioner Emma Bode",
        action: "voted_no",
        matter: "Resolution 5512, a corrupt giveaway to developers",
        quote: "Commissioner Emma Bode voted no on Resolution 5512.",
      },
    ]);
    assert.equal(verified.length, 0);
    assert.equal(rejected[0].reason, "asserts-motive");
  });

  it("stores the document's own text, not the model's rendering of it", () => {
    const { verified } = verifyClaims(MINUTES, [
      {
        subject_name: "Commissioner Douglas Fischer",
        action: "seconded",
        matter: "consent agenda",
        quote: "Commissioner   Douglas Fischer\nseconded the motion.",
      },
    ]);
    assert.equal(verified.length, 1);
    // What is kept is what the record says, at the offset in the record.
    assert.ok(MINUTES.includes(verified[0].quote));
  });
});

describe("reading a free model's reply", () => {
  it("finds the array inside the prose they add anyway", () => {
    const read = readClaims(
      'Sure! Here are the facts I found:\n```json\n[{"subject_name":"A","action":"moved"}]\n```\nHope that helps!',
    );
    assert.equal(read.ok, true);
    assert.equal(read.ok && read.claims.length, 1);
  });

  it("reports an empty array as an empty ANSWER, not as a failure", () => {
    // The model read the chunk and found nothing. That is a real result and
    // must stay distinct from the reply we could not read at all.
    const read = readClaims("[]");
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok && read.claims, []);
  });

  it("reports an unreadable reply as a FAILURE, never as an empty result", () => {
    // The defect this replaced, verbatim from production on 2026-08-11: a
    // reasoning model spent its whole token budget deliberating, was cut off
    // before emitting JSON, and did it on all nine chunks. Every layer passed
    // an empty list along and the run was recorded "succeeded" with 0 claims —
    // a set of minutes recording a 5-0 vote by name, reported as a meeting
    // where nothing happened.
    for (const reply of [
      "I could not find any votes in this document.",
      "We need to extract facts. Let's scan. Section A: Call to Order. Mayor Morri",
      "[{broken json",
      '{"subject_name":"A"}',
    ]) {
      const read = readClaims(reply);
      assert.equal(read.ok, false, `should have failed: ${reply.slice(0, 40)}`);
      if (!read.ok) {
        assert.ok(read.reason.length > 0);
        // The sample is what tells "answered in prose" apart from "truncated".
        assert.ok(read.sample.length > 0);
      }
    }
  });

  it("keeps a bounded sample of an unreadable reply", () => {
    const read = readClaims("x".repeat(5000));
    assert.equal(read.ok, false);
    assert.equal(read.ok === false && read.sample.length, REPLY_SAMPLE_LENGTH);
  });

  it("turns an unreadable chunk into a reported failure, not a silent zero", async () => {
    // The integration half: the extractor must surface it, since readClaims
    // returning a failure means nothing if the caller drops it.
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: DEFAULT_MODEL,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Let me think about this..." } }] }),
          { status: 200 },
        )) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    const outcome = await extractClaims(client, { documentText: MINUTES });
    assert.equal(outcome.proposed, 0);
    assert.equal(outcome.failedChunks.length, outcome.chunks);
    assert.match(outcome.failedChunks[0].error, /Unreadable reply/);
    // And therefore never "succeeded".
    assert.equal(classifyExtraction(outcome), "failed");
  });
});

describe("chunking a long document", () => {
  it("returns one chunk when the text already fits", () => {
    assert.deepEqual(chunkText("short", 6000), [{ text: "short", offset: 0 }]);
  });

  it("overlaps chunks so a sentence on a boundary is whole in one of them", () => {
    const text = "x".repeat(10_000);
    const chunks = chunkText(text, 6000);
    assert.ok(chunks.length > 1);
    assert.ok(chunks[1].offset < 6000, "chunks must overlap, not abut");
    assert.equal(chunks[0].offset, 0);
  });

  it("covers the whole document", () => {
    const text = "y".repeat(10_000);
    const chunks = chunkText(text, 6000);
    const last = chunks[chunks.length - 1];
    assert.equal(last.offset + last.text.length, text.length);
  });
});

describe("a whole extraction, end to end", () => {
  function clientReturning(reply: string): OpenRouterClient {
    return new OpenRouterClient({
      apiKey: "test-key",
      model: "test/model:free",
      sleep: async () => {},
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
          status: 200,
        })) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });
  }

  it("keeps the true claim and drops the invented one from the same reply", async () => {
    const outcome = await extractClaims(
      clientReturning(
        JSON.stringify([
          {
            subject_name: "Commissioner Emma Bode",
            action: "voted_no",
            matter: "Resolution 5512",
            quote: "Commissioner Emma Bode voted no on Resolution 5512.",
          },
          {
            subject_name: "Commissioner Emma Bode",
            action: "voted_yes",
            matter: "Resolution 5512",
            quote: "Commissioner Emma Bode enthusiastically supported Resolution 5512.",
          },
        ]),
      ),
      { documentText: MINUTES },
    );

    assert.equal(outcome.proposed, 2);
    assert.equal(outcome.result.verified.length, 1);
    assert.equal(outcome.result.rejected.length, 1);
    assert.equal(outcome.result.rejected[0].reason, "quote-not-found");
    assert.equal(outcome.prompt_version, PROMPT_VERSION);
  });

  it("reports a chunk that could not be called instead of counting it as empty", async () => {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: "test/model:free",
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    const outcome = await extractClaims(client, { documentText: MINUTES });
    assert.equal(outcome.result.verified.length, 0);
    assert.equal(outcome.failedChunks.length, 1, "a throttled chunk must be reported");
    assert.match(outcome.failedChunks[0].error, /rate-limited/);
  });

  it("persists verified claims held, never published", async () => {
    const { commissionId } = await createSource(PREFIX, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-06-03" });
    const sha = "e".repeat(64);

    const outcome = await extractClaims(
      clientReturning(
        JSON.stringify([
          {
            subject_name: "Commissioner Emma Bode",
            action: "voted_no",
            matter: "Resolution 5512",
            quote: "Commissioner Emma Bode voted no on Resolution 5512.",
          },
        ]),
      ),
      { documentText: MINUTES },
    );

    const written = await persistClaims(db, outcome, { meetingId, artifactSha256: sha });
    assert.equal(written, 1);

    const row = await db("minute_claims").where({ meeting_id: meetingId }).first();
    assert.ok(row);
    // Every row names a person, so every row is held. This is the invariant the
    // whole feature is built underneath.
    assert.equal(row.status, "held");
    assert.equal(row.subject_name, "Commissioner Emma Bode");
    assert.equal(row.artifact_sha256, sha);
    assert.ok(row.quote_offset > 0);

    // Re-running over the same bytes revises rather than accumulates: a retry
    // must not double the review queue.
    await persistClaims(db, outcome, { meetingId, artifactSha256: sha });
    const count = await db("minute_claims").where({ meeting_id: meetingId }).count({ n: "*" }).first();
    assert.equal(Number(count?.n), 1);
  });

  it("refuses at the database to store a citation with no offset", async () => {
    // The application always supplies one, and the schema is what makes that
    // true rather than customary.
    const { commissionId } = await createSource(`${PREFIX}-guard`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-06-04" });

    await assert.rejects(() =>
      db("minute_claims").insert({
        meeting_id: meetingId,
        artifact_sha256: "f".repeat(64),
        subject_name: "Commissioner Emma Bode",
        action: "voted_no",
        quote: "Commissioner Emma Bode voted no on Resolution 5512.",
        model: "test/model:free",
        prompt_version: PROMPT_VERSION,
        // quote_offset deliberately absent
      }),
    );
  });

  it("refuses at the database to store an empty quotation", async () => {
    const { commissionId } = await createSource(`${PREFIX}-empty`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-06-05" });

    await assert.rejects(
      () =>
        db("minute_claims").insert({
          meeting_id: meetingId,
          artifact_sha256: "a".repeat(64),
          subject_name: "Commissioner Emma Bode",
          action: "voted_no",
          quote: "   ",
          quote_offset: 0,
          model: "test/model:free",
          prompt_version: PROMPT_VERSION,
        }),
      /minute_claims_quote_check/,
    );
  });
});

describe("an extraction that outlives its request", () => {
  /**
   * The 504 that produced this suite: nine chunks against a free model take
   * minutes, nginx's proxy_read_timeout is 60 seconds, and the synchronous
   * route returned a bare HTML 504 while the work carried on server-side. From
   * the console that was indistinguishable from a meeting with no votes.
   */
  const outcome = (over: Partial<ExtractionOutcome> = {}): ExtractionOutcome => ({
    model: "test/model:free",
    served_models: ["test/model:free"],
    prompt_version: PROMPT_VERSION,
    chunks: 4,
    proposed: 0,
    result: { verified: [], rejected: [] },
    verified: [],
    failedChunks: [],
    ...over,
  });

  it("calls a run with no failed chunks succeeded", () => {
    assert.equal(classifyExtraction(outcome()), "succeeded");
  });

  it("calls a run partial when SOME chunks failed, even though claims were stored", () => {
    // Never "succeeded". Part of the document was never read, and a reviewer
    // looking at the claims list cannot see that from the claims alone.
    const partial = outcome({ failedChunks: [failedChunk(2, "429")] });
    assert.equal(classifyExtraction(partial), "partial");
  });

  it("calls a run failed when EVERY chunk failed", () => {
    // What happened live on 2026-08-11 when the model stopped being free.
    // There is no evidence the document was read at all, so this is not a
    // partial success with zero claims.
    const dead = outcome({
      chunks: 3,
      failedChunks: [
        failedChunk(0, "404 unavailable for free"),
        failedChunk(1, "404 unavailable for free"),
        failedChunk(2, "404 unavailable for free"),
      ],
    });
    assert.equal(classifyExtraction(dead), "failed");
  });

  it("records a run, its verbatim error, and reports it as in flight while running", async () => {
    const { commissionId } = await createSource(`${PREFIX}-runs`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-06-05" });

    const runId = await startRun(db, meetingId);
    assert.equal(await isExtracting(db, meetingId), true);

    await failRun(db, runId, new OpenRouterError("OpenRouter returned 404: no longer free", 404, false));

    assert.equal(await isExtracting(db, meetingId), false);
    const runs = await listRuns(db, meetingId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "failed");
    // Verbatim. A summarised error is an error nobody can act on.
    assert.match(runs[0].error ?? "", /no longer free/);
    assert.notEqual(runs[0].finished_at, null);
  });

  it("refuses at the database to leave a finished run without a finish time", async () => {
    const { commissionId } = await createSource(`${PREFIX}-finish`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-06-06" });

    // Without this constraint a crashed process leaves rows that read as
    // healthy in-progress work forever, and `isExtracting` would then refuse
    // every future extraction of that meeting with a 409.
    await assert.rejects(
      () =>
        db("extraction_runs").insert({
          meeting_id: meetingId,
          status: "succeeded",
          finished_at: null,
        }),
      /extraction_runs_finished_check/,
    );
  });

  it("stores the served models, so a router's claims stay traceable", async () => {
    const { commissionId } = await createSource(`${PREFIX}-served`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-06-07" });

    const runId = await startRun(db, meetingId);
    await finishRun(db, runId, {
      artifactSha256: "a".repeat(64),
      outcome: outcome({
        model: "openrouter/free",
        served_models: ["cohere/north-mini-code:free", "poolside/laguna-xs-2.1:free"],
        failedChunks: [failedChunk(1, "429")],
      }),
      stored: 0,
    });

    const runs = await listRuns(db, meetingId);
    assert.equal(runs[0].model, "openrouter/free");
    assert.deepEqual(runs[0].served_models, [
      "cohere/north-mini-code:free",
      "poolside/laguna-xs-2.1:free",
    ]);
    assert.equal(runs[0].status, "partial");
    assert.equal(runs[0].failed_chunks.length, 1);
  });
});

describe("the same claim found twice, because chunks overlap on purpose", () => {
  const claim = {
    subject_name: "Deputy Mayor Fischer",
    action: "moved" as const,
    matter: "Consent Items F.1 through F.22",
    quote:
      "Motion to approve Consent Items F.1 through F.22 as presented was made by Deputy Mayor Fischer",
    quote_offset: 1234,
    model: "test/model:free",
  };

  it("keeps one row per unique key", () => {
    assert.equal(dedupeClaims([claim, claim, claim]).length, 1);
  });

  it("keeps claims that differ in ANY part of the key", () => {
    // Two people can say the same sentence at different offsets, and one person
    // can move and second different matters. Only an exact key match collapses.
    const others = [
      claim,
      { ...claim, subject_name: "Commissioner Bode" },
      { ...claim, action: "seconded" as const },
      { ...claim, quote_offset: 9999 },
    ];
    assert.equal(dedupeClaims(others).length, 4);
  });

  it("stores a claim proposed by two overlapping chunks instead of losing every claim", async () => {
    // Production, 2026-08-11: the model extracted correctly and the whole
    // insert failed with "ON CONFLICT DO UPDATE command cannot affect row a
    // second time", so a run that had genuinely read the minutes stored zero
    // claims. CHUNK_OVERLAP makes this the normal case, not a rare one.
    const { commissionId } = await createSource(`${PREFIX}-dupes`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-07-14" });

    const outcome: ExtractionOutcome = {
      model: "test/model:free",
      served_models: ["test/model:free"],
      prompt_version: PROMPT_VERSION,
      chunks: 2,
      proposed: 2,
      result: { verified: [claim, claim], rejected: [] },
      verified: [claim, claim],
      failedChunks: [],
    };

    const stored = await persistClaims(db, outcome, {
      meetingId,
      artifactSha256: "a".repeat(64),
    });
    assert.equal(stored, 1);

    const rows = await db("minute_claims").where({ meeting_id: meetingId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "held");
  });

  it("still merges rather than duplicates when the extractor is re-run", async () => {
    const { commissionId } = await createSource(`${PREFIX}-rerun`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-07-15" });
    const outcome: ExtractionOutcome = {
      model: "test/model:free",
      served_models: ["test/model:free"],
      prompt_version: PROMPT_VERSION,
      chunks: 1,
      proposed: 1,
      result: { verified: [claim], rejected: [] },
      verified: [claim],
      failedChunks: [],
    };
    const opts = { meetingId, artifactSha256: "b".repeat(64) };

    await persistClaims(db, outcome, opts);
    await persistClaims(db, outcome, opts);

    const rows = await db("minute_claims").where({ meeting_id: meetingId });
    assert.equal(rows.length, 1);
  });
});

describe("who this project records, and who it does not", () => {
  const MINUTES_WITH_PUBLIC = [
    "Commissioner Bode moved to approve the resolution as presented.",
    "The motion was seconded by Deputy Mayor Fischer.",
    "A member of the public, Mark Campanelli, a Bogart Park resident living in the RA",
    "district, raised a question about short-term rentals.",
    "City Attorney Sullivan responded that the approach would be legally questionable.",
  ].join("\n");

  it("records a commissioner, a deputy mayor and a mayor", () => {
    for (const subject of ["Commissioner Bode", "Deputy Mayor Fischer", "Mayor Morrison"]) {
      assert.equal(namesAnOfficial(subject), true, subject);
    }
  });

  it("refuses a member of the public who spoke at public comment", () => {
    // Production, 2026-08-11: the first real extraction produced a claim about
    // a named resident with his neighbourhood in the quote. Public comment is
    // public record, but accumulating a searchable file on residents who turn
    // up to speak is a different and much worse thing than holding elected
    // officials to account.
    assert.equal(namesAnOfficial("Mark Campanelli"), false);

    const result = verifyClaims(MINUTES_WITH_PUBLIC, [
      {
        subject_name: "Mark Campanelli",
        action: "spoke",
        matter: "short-term rentals",
        quote:
          "A member of the public, Mark Campanelli, a Bogart Park resident living in the RA",
      },
    ]);
    assert.equal(result.verified.length, 0);
    assert.equal(result.rejected[0].reason, "not-an-official");
  });

  it("refuses staff, who are officials but are not members of the commission", () => {
    assert.equal(namesAnOfficial("City Attorney Sullivan"), false);
    assert.equal(namesAnOfficial("City Manager Winn"), false);
  });

  it("refuses a bare surname, since the office is what identifies a member", () => {
    assert.equal(namesAnOfficial("Fischer"), false);
    assert.equal(namesAnOfficial("Bode"), false);
  });

  it("requires the office to LEAD the name", () => {
    // "a resident who used to be a commissioner" must not qualify.
    assert.equal(namesAnOfficial("a resident who used to be a commissioner"), false);
  });
});

describe("the matter, held to the same standard as the citation", () => {
  const DOC = [
    "F. Consent Agenda",
    "Motion to approve Consent Items F.1 through F.22 as presented was made by",
    "Deputy Mayor Fischer and seconded by Commissioner Bode. The motion carried 5-0.",
    "(Deputy Mayor Fischer - Aye; Commissioner Bode - Aye)",
    "x".repeat(4000),
    "H.1 Parking amendment project report for Application 26307",
    "Commissioner Bode moved to adopt the findings presented in the parking amendment",
    "project report for Application 26307.",
  ].join("\n");

  it("keeps a matter found beside its citation", () => {
    const offset = DOC.indexOf("Deputy Mayor Fischer and seconded");
    assert.equal(
      verifiedMatter(DOC, "Consent Items F.1 through F.22 as presented", offset),
      "Consent Items F.1 through F.22 as presented",
    );
  });

  it("drops a matter that belongs to a different agenda item", () => {
    // The exact production defect: a verified quotation, "Deputy Mayor Fischer
    // - Aye" inside the consent vote, carrying a matter about a parking
    // amendment four thousand characters away. Right person, right action,
    // verbatim citation, invented context.
    const offset = DOC.indexOf("(Deputy Mayor Fischer - Aye");
    assert.equal(
      verifiedMatter(DOC, "the findings presented in the parking amendment", offset),
      null,
    );
  });

  it("drops a matter the document does not contain at all", () => {
    assert.equal(verifiedMatter(DOC, "a bond issue that was never discussed", 0), null);
  });

  it("drops the matter but KEEPS the claim, because the fact is still true", async () => {
    // Losing the context of a true fact is a small harm. Asserting the wrong
    // context is a large one. So an unverifiable matter must not take the
    // verified vote down with it.
    const result = verifyClaims(DOC, [
      {
        subject_name: "Commissioner Bode",
        action: "seconded",
        matter: "the findings presented in the parking amendment",
        quote: "Deputy Mayor Fischer and seconded by Commissioner Bode. The motion carried 5-0.",
      },
    ]);
    assert.equal(result.verified.length, 1);
    assert.equal(result.verified[0].matter, null);
    assert.equal(result.verified[0].subject_name, "Commissioner Bode");
  });
});

describe("cleaning up claims a policy change forbade", () => {
  it("removes a held claim about a non-official, and keeps the officials", async () => {
    // The claim about a member of the public was stored before the rule existed.
    // A merge cannot remove it — it is simply never proposed again — so without
    // pruning it would outlive the decision to stop recording the public.
    const { commissionId } = await createSource(`${PREFIX}-prune`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-07-16" });
    const sha = "c".repeat(64);

    await db("minute_claims").insert([
      {
        meeting_id: meetingId, artifact_sha256: sha, subject_name: "Mark Campanelli",
        action: "spoke", quote: "A member of the public, Mark Campanelli, raised a question.",
        quote_offset: 10, model: "test/model:free", prompt_version: PROMPT_VERSION, status: "held",
      },
      {
        meeting_id: meetingId, artifact_sha256: sha, subject_name: "Commissioner Bode",
        action: "moved", quote: "Commissioner Bode moved to approve the resolution as presented.",
        quote_offset: 200, model: "test/model:free", prompt_version: PROMPT_VERSION, status: "held",
      },
    ]);

    const pruned = await pruneDisallowedClaims(db, { meetingId, artifactSha256: sha });
    assert.equal(pruned, 1);

    const left = await db("minute_claims").where({ meeting_id: meetingId });
    assert.equal(left.length, 1);
    assert.equal(left[0].subject_name, "Commissioner Bode");
  });

  it("never deletes a claim an operator has already ruled on", async () => {
    // Approved or rejected carries a human decision. Erasing it to tidy up
    // after a policy change would be destroying the review record itself.
    const { commissionId } = await createSource(`${PREFIX}-prune-keep`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-07-17" });
    const sha = "d".repeat(64);

    await db("minute_claims").insert({
      meeting_id: meetingId, artifact_sha256: sha, subject_name: "Mark Campanelli",
      action: "spoke", quote: "A member of the public, Mark Campanelli, raised a question.",
      quote_offset: 10, model: "test/model:free", prompt_version: PROMPT_VERSION,
      status: "rejected",
    });

    assert.equal(await pruneDisallowedClaims(db, { meetingId, artifactSha256: sha }), 0);
    assert.equal((await db("minute_claims").where({ meeting_id: meetingId })).length, 1);
  });
});

describe("a reply cut off by the token ceiling", () => {
  /**
   * Production, 2026-08-11: three of nine chunks were cut mid-string. Each had
   * already emitted several complete, correct claims, and all of them were
   * discarded — real recorded votes lost for a reason with nothing to do with
   * the record.
   */
  const TRUNCATED = `[
  {
    "subject_name": "Commissioner Sweeney",
    "action": "moved",
    "matter": "H.2 Ordinance Provisional Adoption",
    "quote": "Commissioner Sweeney moved to provisionally adopt the ordinance as presented."
  },
  {
    "subject_name": "Commissioner Bode",
    "action": "seconded",
    "matter": "H.2 Ordinance Provisional Adoption",
    "quote": "The motion was seconded by Commissioner Bode."
  },
  {
    "subject_name": "Deputy Mayor Fischer",
    "action": "voted_yes",
    "matter": "H.2 Ordinance Provisional Ad`;

  it("recovers the complete claims that came before the cut", () => {
    const read = readClaims(TRUNCATED);
    assert.equal(read.ok, true);
    assert.equal(read.ok && read.claims.length, 2);
    assert.equal(read.ok && read.truncated, true);
  });

  it("does not invent the claim that was interrupted", () => {
    const read = readClaims(TRUNCATED);
    assert.ok(read.ok);
    if (read.ok) {
      const subjects = read.claims.map((c) => c.subject_name);
      assert.deepEqual(subjects, ["Commissioner Sweeney", "Commissioner Bode"]);
      assert.ok(!subjects.includes("Deputy Mayor Fischer"));
    }
  });

  it("is not fooled by braces inside a quoted string", () => {
    const tricky = '[{"subject_name":"Commissioner Bode","action":"moved","quote":"He said {not json} \\" here"}';
    const read = readClaims(tricky);
    assert.equal(read.ok, true);
    assert.equal(read.ok && read.claims.length, 1);
  });

  it("still fails when the cut came before any complete claim", () => {
    const read = readClaims('[\n  {\n    "subject_name": "Commissioner Bo');
    assert.equal(read.ok, false);
    assert.equal(read.ok === false && /cut off before a single complete claim/.test(read.reason), true);
  });

  it("marks a whole reply as not truncated", () => {
    const read = readClaims('[{"subject_name":"Commissioner Bode","action":"moved"}]');
    assert.equal(read.ok && read.truncated, false);
  });

  it("reports a truncated chunk so the run cannot read as fully examined", async () => {
    // The salvage must not launder a partial read into a clean one: the tail of
    // that chunk genuinely was never seen.
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: DEFAULT_MODEL,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: TRUNCATED } }] }), {
          status: 200,
        })) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    const outcome = await extractClaims(client, { documentText: MINUTES });
    assert.ok(outcome.proposed > 0, "salvaged claims are still proposed");
    assert.equal(outcome.failedChunks.length, outcome.chunks);
    assert.match(outcome.failedChunks[0].error, /Truncated reply/);
    assert.notEqual(classifyExtraction(outcome), "succeeded");
  });
});

describe("a 200 that carries no answer, and what it was hiding", () => {
  /**
   * The branch this suite exists for. Until 2026-08-14 every one of these threw
   * the single string "OpenRouter returned no message content", not retryable,
   * with no diagnosis — and roughly a fifth of every document went unread
   * through it. The payload was carrying the answer the whole time in fields
   * the reader discarded.
   *
   * Every case here is a stubbed payload. Nothing in this file calls the API.
   */
  const completion = (choice: Record<string, unknown>): unknown => ({
    id: "gen-1",
    model: "test/model:free",
    choices: [choice],
  });

  it("names truncation when the ceiling was exhausted before any text", () => {
    const diagnosis = diagnoseEmptyCompletion(
      completion({ finish_reason: "length", message: { role: "assistant", content: "" } }),
    );
    assert.equal(diagnosis.reason, "truncated");
    assert.equal(diagnosis.finishReason, "length");
    // The one member of the taxonomy where another attempt could work — a
    // smaller chunk would fit. Splitting is NOT built; this records that it is
    // the fix, it does not perform one.
    assert.equal(diagnosis.retryable, true);
    assert.match(diagnosis.message, /ceiling was exhausted/);
  });

  it("reads a provider's own native reason when the normalised one is absent", () => {
    // Google says MAX_TOKENS, Anthropic says max_tokens, and OpenRouter's
    // normalisation of finish_reason is not guaranteed for every provider.
    const diagnosis = diagnoseEmptyCompletion(
      completion({ native_finish_reason: "MAX_TOKENS", message: { content: null } }),
    );
    assert.equal(diagnosis.reason, "truncated");
    assert.equal(diagnosis.nativeFinishReason, "MAX_TOKENS");
  });

  it("names a refusal, and refuses to call it retryable", () => {
    // Entirely plausible for minutes that name people in a dispute, and it
    // needs a completely different answer from truncation: no ceiling, no wait
    // and no retry produces an extraction from a model that declined.
    const diagnosis = diagnoseEmptyCompletion(
      completion({ finish_reason: "content_filter", message: { content: "" } }),
    );
    assert.equal(diagnosis.reason, "refused");
    assert.equal(diagnosis.retryable, false);
    assert.match(diagnosis.message, /content filter, not a size limit/);
  });

  it("tells 'nothing answered' apart from 'something answered with nothing'", () => {
    assert.equal(diagnoseEmptyCompletion({ choices: [] }).reason, "no-choices");
    assert.equal(diagnoseEmptyCompletion({ model: "x" }).reason, "no-choices");
    assert.equal(
      diagnoseEmptyCompletion(completion({ finish_reason: "stop", message: { content: "" } })).reason,
      "empty-content",
    );
  });

  it("reads the error body out of an HTTP 200", () => {
    // OpenRouter answers 200 with an error object for several upstream
    // failures, and that is exactly the shape that reached the old branch —
    // where the upstream's own explanation was thrown away unread.
    const diagnosis = diagnoseEmptyCompletion({
      error: { message: "Provider returned error", code: 429 },
    });
    assert.equal(diagnosis.reason, "upstream-error");
    assert.equal(diagnosis.upstreamCode, 429);
    assert.equal(diagnosis.upstreamError, "Provider returned error");
    // The upstream says whether waiting helps.
    assert.equal(diagnosis.retryable, true);
  });

  it("does not call a permanent upstream error retryable", () => {
    // A 404 for a model that stopped being free is not transient, and llama-3.3
    // did precisely this mid-project.
    const diagnosis = diagnoseEmptyCompletion({
      error: { message: "No endpoints found for meta-llama/llama-3.3-70b-instruct:free", code: "404" },
    });
    assert.equal(diagnosis.reason, "upstream-error");
    assert.equal(diagnosis.upstreamCode, 404);
    assert.equal(diagnosis.retryable, false);
  });

  it("prefers the error body over the missing choices it comes with", () => {
    // A 200-with-error usually carries no choices at all. Reporting that as
    // "no choices" would bury the sentence saying why.
    const diagnosis = diagnoseEmptyCompletion({
      choices: [],
      error: { message: "Rate limit exceeded", code: 429 },
    });
    assert.equal(diagnosis.reason, "upstream-error");
  });

  it("names a model that spent its budget deliberating", () => {
    // The measured failure that pinned this project to a non-reasoning model:
    // the whole budget goes to the reasoning channel and `content` is empty,
    // even though the request sets reasoning.enabled false.
    const diagnosis = diagnoseEmptyCompletion(
      completion({
        finish_reason: "stop",
        message: { content: "", reasoning: "Let me work through the minutes..." },
      }),
    );
    assert.equal(diagnosis.reason, "reasoning-only");
    assert.equal(diagnosis.retryable, false);
  });

  it("classifies a malformed payload instead of throwing a TypeError at it", () => {
    // Every field may be absent. A reader that asserts the shape turns a bad
    // response into a stack trace with no diagnosis in it at all.
    for (const payload of [
      "not an object",
      null,
      42,
      [],
      { choices: "no" },
      { choices: [null] },
      { choices: [42] },
      { choices: [{}] },
      { choices: [{ message: null }] },
      { error: "a string, not an object" },
    ]) {
      const diagnosis = diagnoseEmptyCompletion(payload);
      assert.ok(diagnosis.reason.length > 0, JSON.stringify(payload));
      assert.ok(diagnosis.message.length > 0, JSON.stringify(payload));
    }
    assert.equal(diagnoseEmptyCompletion("not an object").reason, "malformed-payload");
    assert.equal(diagnoseEmptyCompletion({ choices: [42] }).reason, "malformed-payload");
    // An array IS an object to `typeof`, and it is not a completion.
    assert.equal(diagnoseEmptyCompletion([]).reason, "malformed-payload");
  });

  it("throws the diagnosis out of the client, not a bare sentence", async () => {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: DEFAULT_MODEL,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            model: "test/model:free",
            choices: [{ finish_reason: "content_filter", message: { content: "" } }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    await assert.rejects(
      () => client.complete({ system: "s", user: "u" }),
      (error: unknown) => {
        assert.ok(error instanceof EmptyCompletionError);
        assert.ok(error instanceof OpenRouterError, "still an OpenRouterError to older callers");
        assert.equal(error.diagnosis.reason, "refused");
        assert.equal(error.retryable, false);
        assert.equal(error.status, 200);
        return true;
      },
    );
  });

  it("treats a whitespace-only reply as no content, and says why", async () => {
    // It used to pass through as a string and fail one layer down as "the reply
    // contained no JSON array", losing the finish_reason that says whether it
    // was cut off or refused. Same silence, further from the evidence.
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: DEFAULT_MODEL,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "   \n" } }] }),
          { status: 200 },
        )) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    await assert.rejects(
      () => client.complete({ system: "s", user: "u" }),
      (error: unknown) => {
        assert.ok(error instanceof EmptyCompletionError);
        assert.equal(error.diagnosis.reason, "truncated");
        return true;
      },
    );
  });

  it("carries the diagnosis into failed_chunks structurally, not as prose", async () => {
    // The whole point. `failed_chunks` has to be tallyable without parsing
    // English out of an error string.
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: DEFAULT_MODEL,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "content_filter",
                native_finish_reason: "SAFETY",
                message: { content: "" },
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    const outcome = await extractClaims(client, { documentText: MINUTES });
    assert.equal(outcome.failedChunks.length, outcome.chunks);
    assert.equal(outcome.failedChunks[0].reason, "refused");
    assert.equal(outcome.failedChunks[0].finish_reason, "content_filter");
    assert.equal(outcome.failedChunks[0].native_finish_reason, "SAFETY");

    const summary = summariseFailures(outcome.chunks, outcome.failedChunks);
    assert.equal(summary.unread_fraction, 1);
    assert.equal(summary.refused, true);
    assert.equal(summary.by_reason.refused, outcome.chunks);
    // Unchanged by the taxonomy: a document where every chunk went unread is
    // `failed`, whatever the reason. Refusal is visible in the summary, not in
    // a fifth status the CHECK constraint does not permit.
    assert.equal(classifyExtraction(outcome), "failed");
  });

  it("still labels a chunk the call never reached as request-failed", async () => {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: "test/model:free",
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
      logger: { info: () => {}, warn: () => {} },
    });

    const outcome = await extractClaims(client, { documentText: MINUTES });
    assert.equal(outcome.failedChunks[0].reason, "request-failed");
    assert.equal(outcome.failedChunks[0].finish_reason, null);
  });
});

describe("counting what went unread, from the row alone", () => {
  it("knows every reason it can be asked to read back", () => {
    // `asReason` narrows a jsonb string with a switch; this walks the typed
    // table of reasons through it so the two lists cannot drift apart.
    for (const reason of Object.keys(CHUNK_FAILURE_REASONS)) {
      assert.equal(asReason(reason), reason, reason);
    }
    assert.equal(asReason("invented-by-a-future-version"), null);
    assert.equal(asReason(7), null);
  });

  it("reads a row written before the taxonomy existed without inventing a reason", () => {
    // Rows already in production carry `{ index, error }` and nothing else.
    // They are `unclassified`, which is the truth about them — and is why
    // widening this jsonb column needed no migration.
    const legacy = toFailedChunk({ index: 3, error: "OpenRouter returned no message content" });
    assert.ok(legacy !== null);
    assert.equal(legacy?.reason, null);
    assert.equal(legacy?.finish_reason, null);

    const summary = summariseFailures(9, legacy === null ? [] : [legacy]);
    assert.equal(summary.by_reason.unclassified, 1);
    assert.equal(summary.refused, false);
  });

  it("drops an entry that is not a failed chunk at all", () => {
    // The column is jsonb: what comes back is whatever was written, and
    // asserting the shape rather than checking it is how a cast becomes a
    // runtime bug typechecking cannot catch.
    assert.equal(toFailedChunk(null), null);
    assert.equal(toFailedChunk("429"), null);
    assert.equal(toFailedChunk({ error: "no index" }), null);
    assert.equal(toFailedChunk({ index: 1 }), null);
  });

  it("answers 'what fraction went unread, and why' without a log", () => {
    const summary = summariseFailures(9, [
      { index: 0, error: "e", reason: "truncated", finish_reason: "length", native_finish_reason: null },
      { index: 1, error: "e", reason: "truncated", finish_reason: "length", native_finish_reason: null },
      { index: 2, error: "e", reason: "refused", finish_reason: "content_filter", native_finish_reason: null },
    ]);
    assert.equal(summary.failed, 3);
    assert.equal(summary.chunks, 9);
    assert.equal(summary.unread_fraction, 0.333);
    assert.deepEqual(summary.by_reason, { truncated: 2, refused: 1 });
    assert.equal(summary.refused, true);
  });

  it("does not divide by a chunk count of zero", () => {
    assert.equal(summariseFailures(0, []).unread_fraction, 0);
  });

  it("round-trips the diagnosis through the database and back out", async () => {
    const { commissionId } = await createSource(`${PREFIX}-diagnosis`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-06-08" });

    const runId = await startRun(db, meetingId);
    await finishRun(db, runId, {
      artifactSha256: "b".repeat(64),
      outcome: {
        model: "test/model:free",
        served_models: ["test/model:free"],
        prompt_version: PROMPT_VERSION,
        chunks: 4,
        proposed: 0,
        result: { verified: [], rejected: [] },
        verified: [],
        failedChunks: [
          {
            index: 1,
            error: "The model refused this chunk (finish_reason 'content_filter').",
            reason: "refused",
            finish_reason: "content_filter",
            native_finish_reason: "SAFETY",
          },
          {
            index: 2,
            error: "The model emitted no text and stopped on finish_reason 'length'.",
            reason: "truncated",
            finish_reason: "length",
            native_finish_reason: null,
          },
        ],
      },
      stored: 0,
    });

    const [run] = await listRuns(db, meetingId);
    assert.equal(run.failed_chunks.length, 2);
    assert.equal(run.failed_chunks[0].reason, "refused");
    assert.equal(run.failed_chunks[0].native_finish_reason, "SAFETY");
    assert.equal(run.failed_chunks[1].reason, "truncated");
    assert.equal(run.failed_chunks[1].native_finish_reason, null);
    // Two of four chunks unread, and the row says which fault each was.
    assert.equal(run.failure_summary.unread_fraction, 0.5);
    assert.deepEqual(run.failure_summary.by_reason, { refused: 1, truncated: 1 });
    // "This document could not be read by the model" is now a statable fact.
    assert.equal(run.failure_summary.refused, true);
    // Some chunks failed, not all: still partial, exactly as before.
    assert.equal(run.status, "partial");
  });

  it("summarises a run that never failed a chunk as nothing unread", async () => {
    const { commissionId } = await createSource(`${PREFIX}-clean`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-06-09" });

    const runId = await startRun(db, meetingId);
    await finishRun(db, runId, {
      artifactSha256: "c".repeat(64),
      outcome: {
        model: "test/model:free",
        served_models: ["test/model:free"],
        prompt_version: PROMPT_VERSION,
        chunks: 3,
        proposed: 0,
        result: { verified: [], rejected: [] },
        verified: [],
        failedChunks: [],
      },
      stored: 0,
    });

    const [run] = await listRuns(db, meetingId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.failure_summary.unread_fraction, 0);
    assert.deepEqual(run.failure_summary.by_reason, {});
    assert.equal(run.failure_summary.refused, false);
  });
});

describe("which of two named officials actually did it", () => {
  /**
   * The canonical minutes sentence, and the defect it produced in production
   * on 2026-08-11. Fischer MOVED and Bode SECONDED, but a claim saying Fischer
   * seconded passed every check then in place: the quotation is verbatim, the
   * person is real, and the sentence does name Fischer. The stored claims held
   * the true second and the false one, equally well cited.
   */
  const BOTH_NAMED =
    "Motion to approve Consent Items F.1 through F.22 as presented was made by " +
    "Deputy Mayor Fischer and seconded by Commissioner Bode.";

  const ROLL_CALL =
    "The motion carried 5-0. (Deputy Mayor Fischer – Aye; Commissioner Bode – Aye; " +
    "Commissioner Sweeney – Aye; Commissioner Madgic – Aye; Mayor Morrison – Aye)";

  it("attributes the second to the official beside the word 'seconded'", () => {
    assert.equal(subjectPerformedAction(BOTH_NAMED, "Commissioner Bode", "seconded"), true);
    assert.equal(subjectPerformedAction(BOTH_NAMED, "Deputy Mayor Fischer", "seconded"), false);
  });

  it("attributes the motion to the official beside 'was made by'", () => {
    assert.equal(subjectPerformedAction(BOTH_NAMED, "Deputy Mayor Fischer", "moved"), true);
    assert.equal(subjectPerformedAction(BOTH_NAMED, "Commissioner Bode", "moved"), false);
  });

  it("rejects an action the citation carries no cue for at all", () => {
    // The second production case: `Fischer [seconded]` cited to a vote line.
    const voteLine = "Deputy Mayor Fischer – Aye; Commissioner Bode – Aye";
    assert.equal(subjectPerformedAction(voteLine, "Deputy Mayor Fischer", "seconded"), false);
  });

  it("still reads every vote out of a roll call", () => {
    // The rule must not cost us the thing the feature is for. Each name has its
    // own "Aye" beside it, so all five resolve.
    for (const who of [
      "Deputy Mayor Fischer",
      "Commissioner Bode",
      "Commissioner Sweeney",
      "Commissioner Madgic",
      "Mayor Morrison",
    ]) {
      assert.equal(subjectPerformedAction(ROLL_CALL, who, "voted_yes"), true, who);
    }
  });

  it("leaves a sentence naming one official alone", () => {
    // Nothing to confuse, and the subject check already proved they are in it.
    const single = "Commissioner Bode moved to approve the resolution as presented.";
    assert.equal(subjectPerformedAction(single, "Commissioner Bode", "moved"), true);
    assert.equal(subjectPerformedAction(single, "Commissioner Bode", "recused"), true);
  });

  it("gives 'spoke' to the official the sentence leads with", () => {
    // Speech has no closed cue list, so the minutes' own convention is used:
    // "Commissioner Bode asked about X".
    const twoSpeakers =
      "Commissioner Sweeney inquired about verification, and Commissioner Bode agreed.";
    assert.equal(subjectPerformedAction(twoSpeakers, "Commissioner Sweeney", "spoke"), true);
    assert.equal(subjectPerformedAction(twoSpeakers, "Commissioner Bode", "spoke"), false);
  });

  it("rejects the false second end to end, and keeps the true one", () => {
    const doc = `F. Consent Agenda\n${BOTH_NAMED}\n${ROLL_CALL}`;
    const result = verifyClaims(doc, [
      { subject_name: "Commissioner Bode", action: "seconded", matter: null, quote: BOTH_NAMED },
      { subject_name: "Deputy Mayor Fischer", action: "seconded", matter: null, quote: BOTH_NAMED },
      { subject_name: "Deputy Mayor Fischer", action: "moved", matter: null, quote: BOTH_NAMED },
    ]);

    assert.equal(result.verified.length, 2);
    assert.deepEqual(
      result.verified.map((claim) => `${claim.subject_name}:${claim.action}`).sort(),
      ["Commissioner Bode:seconded", "Deputy Mayor Fischer:moved"],
    );
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, "wrong-role-in-quote");
  });
});

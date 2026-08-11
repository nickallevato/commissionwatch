import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import {
  assertFreeModel,
  DEFAULT_MODEL,
  OpenRouterClient,
  OpenRouterError,
  readMessageText,
} from "../src/services/extraction/openrouter";
import {
  locateQuote,
  verifyClaims,
  MIN_QUOTE_LENGTH,
} from "../src/services/extraction/verify";
import {
  chunkText,
  extractClaims,
  persistClaims,
  readClaims,
  PROMPT_VERSION,
  REPLY_SAMPLE_LENGTH,
  type ExtractionOutcome,
} from "../src/services/extraction/extractor";
import {
  classifyExtraction,
  failRun,
  finishRun,
  isExtracting,
  listRuns,
  startRun,
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
    const partial = outcome({ failedChunks: [{ index: 2, error: "429" }] });
    assert.equal(classifyExtraction(partial), "partial");
  });

  it("calls a run failed when EVERY chunk failed", () => {
    // What happened live on 2026-08-11 when the model stopped being free.
    // There is no evidence the document was read at all, so this is not a
    // partial success with zero claims.
    const dead = outcome({
      chunks: 3,
      failedChunks: [
        { index: 0, error: "404 unavailable for free" },
        { index: 1, error: "404 unavailable for free" },
        { index: 2, error: "404 unavailable for free" },
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
        failedChunks: [{ index: 1, error: "429" }],
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

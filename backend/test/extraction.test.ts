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
} from "../src/services/extraction/extractor";
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
    assert.equal(reply, "[]");
    assert.equal(calls, 3);
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
    const claims = readClaims(
      'Sure! Here are the facts I found:\n```json\n[{"subject_name":"A","action":"moved"}]\n```\nHope that helps!',
    );
    assert.equal(claims.length, 1);
  });

  it("yields nothing from an unreadable reply rather than guessing", () => {
    assert.deepEqual(readClaims("I could not find any votes in this document."), []);
    assert.deepEqual(readClaims("[{broken json"), []);
    assert.deepEqual(readClaims('{"subject_name":"A"}'), []);
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

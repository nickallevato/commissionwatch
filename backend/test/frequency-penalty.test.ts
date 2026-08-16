import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FREQUENCY_PENALTY,
  OpenRouterClient,
  resolveFrequencyPenalty,
} from "../src/services/extraction/openrouter";

/**
 * The frequency-penalty knob, and the property that makes it safe to add.
 *
 * A fifth of extraction chunks end `repetition-truncated`. The request asks for
 * `temperature: 0` and sends no repetition penalty, which is the textbook
 * configuration for a degenerate repetition loop: greedy decoding makes a
 * repeating cycle the most probable continuation of itself, so nothing breaks
 * it until `max_tokens` does.
 *
 * The knob exists so that can be *measured* rather than argued about. The
 * central assertion here is therefore not that the penalty works — nothing in a
 * unit test can show that — but that **turning it off leaves the request
 * byte-identical to what it was before the knob existed**. Without that
 * property, adding the option would silently invalidate every truncation
 * measurement already recorded in `docs/STATUS.md`, because those numbers would
 * then describe a configuration nobody had run.
 */

const SILENT = { warn: () => {} };

function collectingLogger(): { warn(message: string): void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message: string) => messages.push(message), messages };
}

/** A fetch stand-in that records the request body it was handed. */
function captureFetch(): { impl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "[]" } }],
        model: "test/model:free",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

async function bodySentWith(frequencyPenalty: number | undefined): Promise<Record<string, unknown>> {
  const { impl, bodies } = captureFetch();
  const client = new OpenRouterClient({
    apiKey: "test-key",
    model: "test/model:free",
    fetchImpl: impl,
    frequencyPenalty,
    logger: { info: () => {}, warn: () => {} },
  });
  await client.complete({ system: "s", user: "u" });
  const parsed: unknown = JSON.parse(bodies[0]);
  assert.ok(
    typeof parsed === "object" && parsed !== null,
    "the captured request body did not parse as an object — the capture is broken, " +
      "and a broken capture must not read as a pass.",
  );
  return parsed as Record<string, unknown>;
}

describe("resolveFrequencyPenalty", () => {
  it("defaults to the documented default when nothing is set", () => {
    assert.equal(resolveFrequencyPenalty(undefined, undefined, SILENT), DEFAULT_FREQUENCY_PENALTY);
  });

  it("reads a valid environment value", () => {
    assert.equal(resolveFrequencyPenalty(undefined, "0.4", SILENT), 0.4);
    assert.equal(resolveFrequencyPenalty(undefined, "-2", SILENT), -2);
    assert.equal(resolveFrequencyPenalty(undefined, "2", SILENT), 2);
  });

  it("prefers an explicit option over the environment", () => {
    assert.equal(resolveFrequencyPenalty(0.7, "0.1", SILENT), 0.7);
  });

  it("falls back to the default on a value outside -2..2, and says so", () => {
    for (const raw of ["3", "-5", "banana", "", "NaN"]) {
      const logger = collectingLogger();
      assert.equal(
        resolveFrequencyPenalty(undefined, raw === "" ? undefined : raw, logger),
        DEFAULT_FREQUENCY_PENALTY,
        `"${raw}" should not have been accepted`,
      );
      if (raw !== "") {
        assert.equal(
          logger.messages.length,
          1,
          `a rejected value must be disclosed, not swallowed: "${raw}" produced no warning. ` +
            "An operator who mistypes this and is told nothing reads a comparison that " +
            "never ran as though it had.",
        );
      }
    }
  });

  it("falls back to the default on an out-of-range explicit option, and says so", () => {
    const logger = collectingLogger();
    assert.equal(resolveFrequencyPenalty(9, undefined, logger), DEFAULT_FREQUENCY_PENALTY);
    assert.equal(logger.messages.length, 1);
  });
});

describe("the request body the client actually sends", () => {
  it("omits frequency_penalty entirely at the default", async () => {
    const body = await bodySentWith(undefined);
    assert.equal(
      "frequency_penalty" in body,
      false,
      "at the default the key must be ABSENT, not present-and-zero. Every truncation " +
        "measurement in docs/STATUS.md was taken without this field; sending " +
        "frequency_penalty: 0 would make those numbers describe a request nobody ran.",
    );
  });

  it("still sends temperature 0 — the knob does not replace determinism", async () => {
    const body = await bodySentWith(undefined);
    assert.equal(
      body.temperature,
      0,
      "temperature 0 is load-bearing: this is an extraction task with a right answer, " +
        "and a project that cannot reproduce its own output cannot defend it. The " +
        "frequency penalty exists precisely so the repetition loop can be broken " +
        "WITHOUT sampling.",
    );
  });

  it("sends the value when one is set", async () => {
    const body = await bodySentWith(0.5);
    assert.equal(body.frequency_penalty, 0.5);
    assert.equal(body.temperature, 0, "setting the penalty must not disturb temperature");
  });

  it("omits it again when explicitly set to zero", async () => {
    const body = await bodySentWith(0);
    assert.equal(
      "frequency_penalty" in body,
      false,
      "an explicit 0 means the same thing as unset: today's request, unchanged.",
    );
  });
});

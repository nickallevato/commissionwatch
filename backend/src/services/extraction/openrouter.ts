/**
 * OpenRouter, restricted to free models by construction.
 *
 * The operator's instruction was "free models" and the budget is zero. A
 * configuration setting would express that; it would not enforce it, and the
 * failure mode of a mis-set model id is a bill rather than an error. So the
 * restriction lives here: `assertFreeModel` refuses any model id that does not
 * carry OpenRouter's `:free` suffix, it runs before the request is built, and
 * there is no flag to switch it off. Charging this project money requires
 * editing this file, which is exactly the amount of friction the decision
 * deserves.
 *
 * Free models are rate-limited and sometimes unavailable, so the failures worth
 * handling here are 429 and 5xx. Both back off and retry; neither is silently
 * swallowed. An extraction that could not run is reported as not having run —
 * `blocked` is not `pass`, the same rule the ingestion verification agents use.
 */

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/**
 * Why a 200 response carried no usable assistant text.
 *
 * Added because roughly a fifth of every document was going unread through a
 * single branch that threw "OpenRouter returned no message content" — a string
 * that says nothing, is not retryable, and lands in `extraction_runs.failed_chunks`
 * where nobody can tally it. The completions payload carries the answer in
 * fields the old code discarded, and these are the answers it can carry.
 *
 * A closed union rather than free-form text so the counts can be added up
 * without parsing prose. "What fraction of this document went unread, and why"
 * has to be answerable from the run row.
 *
 *   upstream-error     HTTP 200 with a top-level `error` object. OpenRouter
 *                      does this for several upstream failures, and it is
 *                      exactly the shape that reached the old branch.
 *   truncated          finish_reason "length" with no text: the ceiling was
 *                      exhausted before the model wrote anything.
 *   refused            finish_reason "content_filter". For minutes naming
 *                      people in a dispute this is entirely plausible, and it
 *                      needs a completely different answer from truncation.
 *   reasoning-only     the model wrote to `message.reasoning` and left
 *                      `content` empty, despite reasoning being disabled in
 *                      the request. Same visible symptom, different cause.
 *   no-choices         `choices` absent, not an array, or empty. Nothing
 *                      answered at all, as opposed to something answering
 *                      with nothing.
 *   malformed-payload  the body is not the documented shape. Classified
 *                      rather than thrown as a TypeError.
 *   empty-content      a choice, finishing normally, with no text in it.
 */
export type EmptyCompletionReason =
  | "upstream-error"
  | "truncated"
  | "refused"
  | "reasoning-only"
  | "no-choices"
  | "malformed-payload"
  | "empty-content";

export interface EmptyCompletionDiagnosis {
  reason: EmptyCompletionReason;
  /** `choices[0].finish_reason` as sent, or null if absent or not a string. */
  finishReason: string | null;
  /** `choices[0].native_finish_reason` — provider-specific, often more precise. */
  nativeFinishReason: string | null;
  /** The top-level error's message and code, when the body carried one. */
  upstreamError: string | null;
  upstreamCode: number | null;
  retryable: boolean;
  /** One line naming what was actually seen. Becomes the thrown message. */
  message: string;
}

/**
 * An empty completion, carrying its diagnosis.
 *
 * A subclass so the extractor can widen `failed_chunks` structurally instead of
 * regex-ing the message text back apart.
 */
export class EmptyCompletionError extends OpenRouterError {
  constructor(
    readonly diagnosis: EmptyCompletionDiagnosis,
    status: number | null,
  ) {
    super(diagnosis.message, status, diagnosis.retryable);
    this.name = "EmptyCompletionError";
  }
}

/** The suffix OpenRouter puts on its no-cost models. */
export const FREE_SUFFIX = ":free";

/**
 * Zero-cost ids that do not carry the `:free` suffix.
 *
 * Exactly one so far: `openrouter/free` is OpenRouter's free-only router, and
 * its listing prices both prompt and completion at 0. An allowlist rather than
 * a looser suffix rule, because "does this id cost money" must stay a decision
 * someone made deliberately and can read in one place.
 */
export const FREE_ALLOWLIST: readonly string[] = ["openrouter/free"];

/**
 * Refuse anything that would cost money.
 *
 * Exported and tested on its own because it is the only thing standing between
 * a typo and a bill. It has already earned its keep: on 2026-08-11 Meta's
 * llama-3.3-70b stopped being free, OpenRouter answered 404 pointing at the
 * paid slug, and this refused to follow it.
 */
export function assertFreeModel(model: string): void {
  if (model.endsWith(FREE_SUFFIX) || FREE_ALLOWLIST.includes(model)) return;
  throw new OpenRouterError(
    `Refusing to call '${model}': CommissionWatch extraction runs on free models only, ` +
      `so a model id must end in '${FREE_SUFFIX}' or be one of: ${FREE_ALLOWLIST.join(", ")}. ` +
      "This is enforced in code, not configuration.",
    null,
    false,
  );
}

/**
 * The default extraction model.
 *
 * **Must not be a reasoning model.** That is the whole selection criterion and
 * it was learned the expensive way: `nemotron-3-super-120b` spent its entire
 * budget thinking aloud and never emitted JSON at all — 27,000 characters of
 * deliberation at 6,000 tokens, 209 seconds per chunk, zero claims on nine
 * chunks of a set of minutes that plainly records a 5-0 vote by name.
 *
 * Measured on that same real chunk, 2026-08-11, with reasoning disabled:
 *
 *   nvidia/nemotron-3-nano-30b-a3b:free   36.5s   25 claims   valid JSON
 *   cohere/north-mini-code:free           43.6s   17 claims   valid JSON
 *   poolside/laguna-s-2.1:free            71.7s   31 claims   valid JSON
 *   inclusionai/ling-3.0-tiny:free         7.8s    0 claims   prose, no JSON
 *   nvidia/nemotron-3-super-120b:free    209.5s    0 claims   prose, no JSON
 *
 * Pinned rather than routed via `openrouter/free`: that router served four
 * different models across four identical calls, one a content-safety classifier
 * that could not do the task. Inconsistent coverage across a document is worse
 * here than an outage, because it leaves no trace.
 *
 * When this one stops being free — and it will, llama-3.3 did it mid-project —
 * the failure is loud: every chunk fails, `stored` is 0, and the run is recorded
 * `failed` rather than reported as a meeting where nothing happened.
 */
export const DEFAULT_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";

/**
 * Reply ceiling.
 *
 * Raised twice, both times on evidence. 2048 failed silently: a model that
 * thinks before answering exhausted it mid-thought, so the reply contained no
 * JSON and the chunk read as empty. 3000 then truncated three of nine chunks
 * mid-string on a dense document — the array opened, emitted several complete
 * claims, and was cut off. 8000 is sized for the worst chunk observed, and
 * truncation is now both salvaged and reported rather than silently lost.
 */
export const DEFAULT_MAX_TOKENS = 8000;

/**
 * Frequency penalty, off by default — the knob that makes the repetition
 * question measurable without changing today's behaviour.
 *
 * ## Why this exists
 *
 * A fifth of extraction chunks end `repetition-truncated`: the model was
 * looping when `max_tokens` stopped it. `docs/STATUS.md` records the
 * measurement (5 of 24 chunks unread, every one of them `truncated-reply`) and
 * notes that extraction is **not scheduled** because of it.
 *
 * The request below asks for `temperature: 0` and sends no repetition or
 * frequency penalty at all, and that combination is the textbook recipe for
 * degenerate repetition. At temperature zero the model takes the
 * highest-probability token at every step, so once the output enters a
 * repeating cycle there is no stochastic path out of it — the cycle is, by
 * construction, the most probable continuation of itself. It repeats until the
 * ceiling truncates the reply. That is precisely the observed signature.
 *
 * ## Why the fix is not simply "raise the temperature"
 *
 * Temperature zero is not an oversight here; it is load-bearing. This is an
 * extraction task with a right answer, and a transparency project that cannot
 * reproduce its own output cannot defend it. Sampling would break the loop and
 * cost determinism, which is the wrong trade for this codebase.
 *
 * A frequency penalty breaks the cycle **without** giving up greedy decoding:
 * it reshapes the scores by how often a token has already appeared, so the run
 * stays deterministic and reproducible while a repeated token stops being the
 * argmax forever.
 *
 * ## Why it defaults to zero
 *
 * Because nothing has been measured yet, and this project does not change model
 * behaviour by reasoning. **At `0` the field is omitted from the request
 * entirely**, so the bytes sent are identical to before this knob existed and
 * the existing loss measurement stays a statement about the same
 * configuration. Set `EXTRACTION_FREQUENCY_PENALTY` to run the comparison.
 * `docs/superpowers/specs/2026-08-16-repetition-truncation-design.md` is the
 * experiment this is for.
 */
export const DEFAULT_FREQUENCY_PENALTY = 0;

export interface OpenRouterOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Injected in tests so a retry path does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  logger?: { info(message: string): void; warn(message: string): void };
  /**
   * Overrides `EXTRACTION_FREQUENCY_PENALTY`. See
   * {@link DEFAULT_FREQUENCY_PENALTY}.
   */
  frequencyPenalty?: number;
}

export interface CompletionRequest {
  system: string;
  user: string;
  /** Ceiling on the reply. Defaults to DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  /**
   * The model that actually answered, as OpenRouter reported it. Equals the
   * requested id for a pinned model; differs per call behind a router.
   */
  servedModel: string;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An environment variable that is present but empty is absent.
 *
 * `??` does not cover this, and Docker Compose makes it the *normal* case, not
 * an edge one: `- OPENROUTER_MODEL=${OPENROUTER_MODEL:-}` sets the variable in
 * the container to the empty string whenever the host has no value for it. So
 * `process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL` yielded "" on every
 * deployment that had not set a model, `assertFreeModel("")` threw, and the
 * documented default was unreachable in production while passing every test.
 */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve the frequency penalty from an explicit option or the environment.
 *
 * Every unusable value resolves to {@link DEFAULT_FREQUENCY_PENALTY} — which is
 * today's behaviour — and says so through the logger. The alternative, throwing,
 * would let a typo in one environment variable take extraction down entirely;
 * the alternative to *disclosing*, silently falling back, would leave an
 * operator reading a comparison that never ran with the setting they thought
 * they had set.
 *
 * The accepted range is OpenAI's and OpenRouter's: −2 to 2 inclusive. A value
 * outside it is a mistake, not a stronger opinion.
 */
export function resolveFrequencyPenalty(
  option: number | undefined,
  raw: string | undefined,
  logger: { warn(message: string): void },
): number {
  if (option !== undefined) {
    if (!Number.isFinite(option) || option < -2 || option > 2) {
      logger.warn(
        `EXTRACTION_FREQUENCY_PENALTY option ${String(option)} is outside the accepted ` +
          `range -2..2; using ${DEFAULT_FREQUENCY_PENALTY} instead.`,
      );
      return DEFAULT_FREQUENCY_PENALTY;
    }
    return option;
  }
  if (raw === undefined) return DEFAULT_FREQUENCY_PENALTY;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < -2 || parsed > 2) {
    logger.warn(
      `EXTRACTION_FREQUENCY_PENALTY="${raw}" is not a number in -2..2; using ` +
        `${DEFAULT_FREQUENCY_PENALTY} instead, which is the behaviour every prior ` +
        `extraction measurement was taken under.`,
    );
    return DEFAULT_FREQUENCY_PENALTY;
  }
  return parsed;
}

export class OpenRouterClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: { info(message: string): void; warn(message: string): void };
  readonly frequencyPenalty: number;

  constructor(options: OpenRouterOptions = {}) {
    this.model = options.model ?? envValue("OPENROUTER_MODEL") ?? DEFAULT_MODEL;
    // Before anything else, and in the constructor rather than at call time, so
    // a misconfigured deployment fails when the client is built rather than
    // halfway through a batch.
    assertFreeModel(this.model);

    this.apiKey = options.apiKey ?? envValue("OPENROUTER_API_KEY") ?? "";
    this.baseUrl = options.baseUrl ?? envValue("OPENROUTER_BASE_URL") ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
    };
    this.frequencyPenalty = resolveFrequencyPenalty(
      options.frequencyPenalty,
      envValue("EXTRACTION_FREQUENCY_PENALTY"),
      this.logger,
    );
  }

  get configured(): boolean {
    return this.apiKey !== "";
  }

  /**
   * One completion. Returns the assistant's text AND the model that produced it.
   *
   * `servedModel` is not the same as `this.model` and that is the point.
   * `openrouter/free` is a router: it picks a different free model per call, and
   * on 2026-08-11 four consecutive calls were served by four different models,
   * one of which was a content-safety classifier that could not do the task.
   * Recording only what we *asked* for would put "openrouter/free" on every row
   * while several different models actually wrote them, and `minute_claims.model`
   * exists precisely so a model that turns out to be bad can be found again.
   *
   * Retries 429 and 5xx with a widening delay. A free model under load answers
   * 429 routinely, and treating that as a failure would make the extractor look
   * broken when it is only queued.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.configured) {
      throw new OpenRouterError(
        "OPENROUTER_API_KEY is not set, so no extraction was attempted.",
        null,
        false,
      );
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            // OpenRouter asks callers to identify themselves. This project
            // names itself to the county's web server; it can name itself here.
            "HTTP-Referer": "https://commissionwatch.bmux.sh",
            "X-Title": "CommissionWatch",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            // Reasoning off. A model that narrates its deliberation spends the
            // token budget on prose and emits no JSON — measured, not feared.
            reasoning: { enabled: false },
            // Deterministic as the endpoint allows. This is an extraction task
            // with a right answer, not a writing task.
            temperature: 0,
            // Spread, not a plain property, so that at the default of 0 the key
            // is ABSENT rather than present-and-zero. The request is then byte
            // for byte what it was before this knob existed, which is what lets
            // the existing truncation measurements keep describing the
            // configuration they were actually taken under. See
            // DEFAULT_FREQUENCY_PENALTY.
            ...(this.frequencyPenalty === 0
              ? {}
              : { frequency_penalty: this.frequencyPenalty }),
          }),
        });
      } catch (error) {
        if (attempt > this.maxRetries) {
          throw new OpenRouterError(
            `OpenRouter unreachable after ${attempt} attempts: ${String(error)}`,
            null,
            true,
          );
        }
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt > this.maxRetries) {
          throw new OpenRouterError(
            `OpenRouter returned ${response.status} after ${attempt} attempts. ` +
              "Free models are rate-limited; nothing was extracted.",
            response.status,
            true,
          );
        }
        this.logger.warn(
          `OpenRouter ${response.status} on attempt ${attempt}; backing off (free tier).`,
        );
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new OpenRouterError(
          `OpenRouter returned ${response.status}: ${body.slice(0, 400)}`,
          response.status,
          false,
        );
      }

      const payload: unknown = await response.json();
      const text = readMessageText(payload);
      // Whitespace-only counts as no content. It used to pass through as a
      // string, fail in `readClaims` as "the reply contained no JSON array",
      // and lose the finish_reason that says whether it was cut off or refused
      // — the same silence one layer further down.
      if (text === null || text.trim() === "") {
        throw new EmptyCompletionError(diagnoseEmptyCompletion(payload), response.status);
      }
      return { text, servedModel: readServedModel(payload) ?? this.model };
    }
  }

  private backoffMs(attempt: number): number {
    // 2s, 4s, 8s. Free-tier limits are per-minute, so short waits are pointless.
    return Math.min(2000 * 2 ** (attempt - 1), 30_000);
  }
}

/**
 * The model OpenRouter says served this response, or null.
 *
 * Null is not an error — it means the endpoint did not say, and the caller
 * falls back to the model it requested. Inventing a value here would be worse
 * than admitting the request's own id is the best record we have.
 */
export function readServedModel(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const model = payload.model;
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  return trimmed === "" ? null : trimmed;
}

/** A non-empty trimmed string, or null. Every field of the payload may be absent. */
function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** An HTTP-ish code out of an upstream error body, which sends it as either type. */
function readCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The finish reasons providers actually send for a cut-off reply.
 *
 * OpenAI's own value is `length`; Google sends `MAX_TOKENS`, Anthropic
 * `max_tokens`, and OpenRouter passes those through in
 * `native_finish_reason` while normalising `finish_reason`. Matched on both
 * because the normalisation is not guaranteed for every provider.
 */
function meansTruncated(finish: string | null, native: string | null): boolean {
  const values = [finish, native].filter((v): v is string => v !== null).map((v) => v.toLowerCase());
  return values.some((v) => v === "length" || v.includes("max_token") || v.includes("truncat"));
}

/** Ditto for a refusal: `content_filter` normalised, `SAFETY`/`BLOCKLIST` native. */
function meansRefused(finish: string | null, native: string | null): boolean {
  const values = [finish, native].filter((v): v is string => v !== null).map((v) => v.toLowerCase());
  return values.some(
    (v) => v.includes("content_filter") || v.includes("safety") || v.includes("blocklist"),
  );
}

/**
 * Name what went wrong, from fields the old code threw away.
 *
 * Order matters. The top-level `error` is read first because a 200-with-error
 * body usually carries no `choices` at all, and reporting that as "no choices"
 * would hide the upstream message that says why.
 *
 * Retryability is decided here rather than left blanket-false, because at least
 * one member of the taxonomy is genuinely worth another attempt and one is
 * genuinely not. **Nothing in this file acts on the flag yet** — no caller reads
 * `OpenRouterError.retryable` today — so this classifies without changing what
 * happens. Splitting a truncated chunk into smaller ones is the obvious fix for
 * `truncated` and it is NOT built; the flag records that a retry could work, it
 * does not perform one.
 */
export function diagnoseEmptyCompletion(payload: unknown): EmptyCompletionDiagnosis {
  const build = (
    reason: EmptyCompletionReason,
    message: string,
    retryable: boolean,
    fields: Partial<EmptyCompletionDiagnosis> = {},
  ): EmptyCompletionDiagnosis => ({
    reason,
    finishReason: null,
    nativeFinishReason: null,
    upstreamError: null,
    upstreamCode: null,
    ...fields,
    message,
    retryable,
  });

  if (isRecord(payload) && isRecord(payload.error)) {
    const upstreamError = readString(payload.error.message) ?? "no message given";
    const upstreamCode = readCode(payload.error.code);
    // The upstream says whether waiting helps: 429 and 5xx do, a 402 or a 404
    // for a model that stopped being free never will.
    const retryable = upstreamCode !== null && (upstreamCode === 429 || upstreamCode >= 500);
    return build(
      "upstream-error",
      `OpenRouter answered HTTP 200 with an error body (code ${upstreamCode ?? "absent"}): ${upstreamError}`,
      retryable,
      { upstreamError, upstreamCode },
    );
  }

  if (!isRecord(payload)) {
    return build(
      "malformed-payload",
      "OpenRouter returned a body that is not a JSON object, so no completion could be read from it.",
      false,
    );
  }

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return build(
      "no-choices",
      "OpenRouter returned no choices at all — nothing answered, as distinct from something " +
        "answering with nothing.",
      false,
    );
  }

  const first: unknown = choices[0];
  if (!isRecord(first)) {
    return build(
      "malformed-payload",
      "OpenRouter returned a choice that is not an object, so no completion could be read from it.",
      false,
    );
  }

  const finishReason = readString(first.finish_reason);
  const nativeFinishReason = readString(first.native_finish_reason);
  const fields = { finishReason, nativeFinishReason };
  const seen = `finish_reason '${finishReason ?? "absent"}', native_finish_reason '${nativeFinishReason ?? "absent"}'`;

  if (meansTruncated(finishReason, nativeFinishReason)) {
    return build(
      "truncated",
      `The model emitted no text and stopped on ${seen}: the reply ceiling was exhausted before ` +
        "any content was written. This chunk was not read. Chunk splitting is not built.",
      true,
      fields,
    );
  }

  if (meansRefused(finishReason, nativeFinishReason)) {
    return build(
      "refused",
      `The model refused this chunk (${seen}). This is a content filter, not a size limit — ` +
        "a retry or a larger ceiling will not produce an answer.",
      false,
      fields,
    );
  }

  const message = isRecord(first.message) ? first.message : null;
  if (message !== null && readString(message.reasoning) !== null) {
    return build(
      "reasoning-only",
      `The model wrote only to the reasoning channel and left content empty (${seen}), although ` +
        "the request disables reasoning. Its whole budget went on deliberation.",
      false,
      fields,
    );
  }

  return build(
    "empty-content",
    `The model finished normally on ${seen} having emitted no content.`,
    false,
    fields,
  );
}

/** The assistant text, or null if the payload is not the shape we expect. */
export function readMessageText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  return typeof content === "string" ? content : null;
}

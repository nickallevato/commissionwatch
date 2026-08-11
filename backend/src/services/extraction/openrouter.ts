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
 * Pinned to a specific model rather than to `openrouter/free`, on evidence
 * gathered 2026-08-11: the router served four different models across four
 * calls on the same input, one of them a content-safety classifier that
 * returned nothing usable, and another that missed a claim its siblings caught.
 * Inconsistent coverage across a document is worse for this project than an
 * outage, because it is invisible. This model returned all five claims with all
 * five citations verbatim.
 *
 * When it too stops being free — and it will — the failure is loud: every chunk
 * fails, `stored` is 0, and nothing is silently asserted about the meeting.
 */
export const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

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
}

export interface CompletionRequest {
  system: string;
  user: string;
  /** Ceiling on the reply. Free models are small; a runaway reply is a hang. */
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

export class OpenRouterClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: { info(message: string): void; warn(message: string): void };

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
            max_tokens: request.maxTokens ?? 2048,
            // Deterministic as the endpoint allows. This is an extraction task
            // with a right answer, not a writing task.
            temperature: 0,
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
      if (text === null) {
        throw new OpenRouterError("OpenRouter returned no message content", response.status, false);
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

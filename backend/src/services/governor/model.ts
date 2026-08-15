import {
  DEFAULT_MODEL,
  OpenRouterClient,
  assertFreeModel,
  type OpenRouterOptions,
} from "../extraction/openrouter";

/**
 * Two pins, and the refusal to let them be the same one.
 *
 * A model judging its own output is a rubber stamp. That is not a stylistic
 * worry: pass 1 and pass 2 asked the same question of the same weights would
 * agree by construction, the governor would approve everything the extractor
 * proposed, and the project would have bought a second API bill for a constant
 * `true`. So the extraction pin and the governor pin are separate, and a
 * deployment that sets them equal does not start the governor at all.
 *
 * Both go through `assertFreeModel`. The operator's decision was "prototype and
 * dev with free only and eventually move to more in production", so the
 * allowlist stays and the model is a swappable pin rather than a hardcode —
 * changing it is an environment variable, removing the free-only rule is an edit
 * to `openrouter.ts`, which is the amount of friction that decision deserves.
 */

export class GovernorMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernorMisconfigured";
  }
}

/**
 * The default governor model.
 *
 * Chosen by probing what OpenRouter actually serves on 2026-08-15, not from a
 * list. Fifteen ids carried the `:free` suffix; five were unusable for this task
 * before any judgement quality came into it, and that is most of the selection:
 *
 *   openai/gpt-oss-20b:free          HTTP 400 "Reasoning is mandatory for this
 *   liquid/lfm-2.5-2.6b:free         endpoint and cannot be disabled". The
 *                                    request disables reasoning for
 *                                    `DEFAULT_MODEL`'s measured reason.
 *   google/gemma-4-31b-it:free       HTTP 429 upstream on every attempt, both
 *   google/gemma-4-26b-a4b-it:free   models, across two probes minutes apart.
 *   nvidia/nemotron-3.5-content-safety:free  a classifier, not a judge.
 *
 * The rest were asked the exact question this feature exists for, against a
 * window containing the sentence that motivated it — *"Motion ... was made by
 * Commissioner Sample and seconded by Commissioner Fixture"* — in four cases:
 * the true second, the false `Fixture / moved`, the true `Sample / moved`, and a
 * vote nobody cast. Correct means the verdict matched the record; well-formed
 * means the reply parsed AND every sentence it said it relied on was found in
 * the window:
 *
 *   nvidia/nemotron-nano-9b-v2:free      20/20 correct  19/20 well-formed  ~270ms
 *   cohere/north-mini-code:free           3/4  correct   4/4  well-formed  ~435ms
 *   nvidia/nemotron-3.5-lightning:free    2/4  correct   4/4  well-formed  ~1040ms
 *   poolside/laguna-xs-2.1:free           2/4  correct   4/4  well-formed  ~255ms
 *
 * The three that lost all failed the same case, and it is the revealing one:
 * asked whether *"seconded by Commissioner Fixture"* supports `Fixture /
 * seconded`, they answered no and named "seconded" as the unsupported fragment.
 * A judge that refuses true attributions is worse here than no judge, because
 * `supported: false` is what pushes a claim to the bottom of an operator's
 * queue. Only the pinned model separated the two names in that sentence, and it
 * did so on five consecutive runs.
 *
 * The one non-well-formed reply cited a sentence that did not resolve in the
 * window. That is the void path working: the claim was left un-judged rather
 * than judged on a citation nobody could check.
 *
 * Same vendor as `DEFAULT_MODEL`, different model and a different generation —
 * Nemotron Nano 9B V2 against Nemotron 3 Nano 30B A3B. Worth stating plainly
 * rather than implying independence the measurement does not establish: what is
 * enforced below is that the two ids differ, which is what stops a literal
 * self-review. Shared training lineage is a weaker form of the same correlation
 * and the free tier does not currently offer a way around it — every other free
 * model that could hold the format either refused true claims or would not serve
 * the request at all. Revisit when the allowlist widens.
 */
export const DEFAULT_GOVERNOR_MODEL = "nvidia/nemotron-nano-9b-v2:free";

/**
 * An environment variable that is present but empty is absent.
 *
 * `openrouter.ts` learned this the hard way and the same trap applies here:
 * `- GOVERNOR_MODEL=${GOVERNOR_MODEL:-}` in a compose file sets the variable to
 * the empty string on every deployment that has no value for it, so `??` yields
 * "" and the documented default becomes unreachable in production while passing
 * every test.
 */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The pin pass 1 runs on. Read the same way `OpenRouterClient` reads it. */
export function extractionModel(): string {
  return envValue("OPENROUTER_MODEL") ?? DEFAULT_MODEL;
}

/** The pin pass 2 runs on. */
export function governorModel(): string {
  return envValue("GOVERNOR_MODEL") ?? DEFAULT_GOVERNOR_MODEL;
}

/**
 * Refuse a governor that is the extractor.
 *
 * Exported and tested on its own because it is the only thing standing between a
 * copied environment variable and a pipeline whose second opinion is its first
 * opinion. Compared after trimming, since the values arrive from the environment
 * and `"model "` and `"model"` are the same rubber stamp.
 */
export function assertDistinctModels(extraction: string, governor: string): void {
  if (extraction.trim() !== governor.trim()) return;
  throw new GovernorMisconfigured(
    `Refusing to run the governor on '${governor}': it is the same model as the extractor. ` +
      "A model judging its own output agrees with it, so the second pass would report " +
      "nothing the first pass did not already believe. Set GOVERNOR_MODEL to a different " +
      `free model — the default is '${DEFAULT_GOVERNOR_MODEL}'.`,
  );
}

/**
 * The governor's client, or a refusal to build one.
 *
 * Both checks run in the constructor path rather than at call time, for
 * `OpenRouterClient`'s reason: a misconfigured deployment must fail when the
 * client is built, not halfway through a batch of claims about named people.
 */
export function createGovernorClient(options: OpenRouterOptions = {}): OpenRouterClient {
  const governor = options.model ?? governorModel();
  assertFreeModel(governor);
  assertDistinctModels(extractionModel(), governor);
  return new OpenRouterClient({ ...options, model: governor });
}

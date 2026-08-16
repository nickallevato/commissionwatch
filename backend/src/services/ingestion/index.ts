import type { Knex } from "knex";
import { createAdapterRegistry, type AdapterRegistry } from "./adapters/registry";
import { createBozemanGranicusAdapter } from "./adapters/bozeman-granicus";
import { createGallatinCivicPlusAdapter } from "./adapters/gallatin-civicplus";
import { createMtCersAdapter } from "./adapters/mt-cers";
import { createArtifactStore, createIngestionHandlers, type ArtifactWriter } from "./handlers";
import { IngestionQueue } from "./queue";
import { registerSources, type RegisteredSource } from "./registration";
import { SourceScheduler, schedulerEnabled } from "./scheduler";
import { IngestionWorker } from "./worker";
import { downloadDocument, uploadDocument } from "../storage";
import { OpenRouterClient, OpenRouterError } from "../extraction/openrouter";
import { createExtractHandler, EXTRACT_CONCURRENCY } from "../extraction/stage";
import { createGovernorClient, GovernorMisconfigured } from "../governor/model";
import { createGovernHandler, GOVERN_CONCURRENCY } from "../governor/stage";
import { CensusGeocoder } from "../locate/census";
import { createLocateHandler, LOCATE_CONCURRENCY } from "../locate/stage";
import { logger as structuredLogger } from "../logging/logger";

/**
 * Assembles the ingestion stack.
 *
 * One place where the adapters are chosen, the queue and worker are built and
 * the scheduler is handed both — so `index.ts` stays a list of things that
 * start, and a test can construct exactly the same stack with a fake adapter.
 */

/**
 * Every adapter this build knows how to run.
 *
 * Registering one does not sweep anything: `registerSources` creates every
 * `ingestion_sources` row **disabled**, so a new jurisdiction reaching
 * production is a row an operator can see and switch on, never a crawl that
 * started because a container did.
 */
export function createDefaultRegistry(): AdapterRegistry {
  return createAdapterRegistry([
    createBozemanGranicusAdapter(),
    createGallatinCivicPlusAdapter(),
    createMtCersAdapter(),
  ]);
}

/** MinIO, behind the narrow port the fetch handler actually needs. */
export const minioArtifactWriter: ArtifactWriter = {
  async write(key, bytes, contentType) {
    await uploadDocument(key, Buffer.from(bytes), contentType ?? "application/octet-stream");
  },
};

/**
 * Stages the standing worker is allowed to claim.
 *
 * `fetch` and `discover` are deliberately absent. They are the only stages that
 * reach the network, and a loop that starts with the process would let a
 * crash-looping container become a crawl of a county web server — the exact
 * thing `SourceScheduler.start()` refuses to do by never sweeping on start.
 * Network work stays sweep-driven, which is to say operator-driven.
 *
 * `fetch` has since been given a standing loop of its own — see `FETCH_STAGES`
 * — because sweep-driven fetching could not keep up with sweep-driven
 * discovery. That loop is **off unless an operator sets a flag**, and it is a
 * separate worker, so the sentence above stays true of *this* one: the
 * stationary loop still cannot reach the network, in any deployment.
 */
export const STATIONARY_STAGES = ["parse", "analyze"] as const;

/**
 * The one networked stage a standing loop may claim, when an operator says so.
 *
 * **Why this exists.** `fetch` was drained only inside a sweep, and a sweep is
 * boxed at fifteen minutes. Bozeman's `robots.txt` publishes `Crawl-delay: 10`,
 * which we honour, so a sweep can fetch about **ninety documents a night**. On
 * 2026-08-16 the queue held **1,639 pending fetches**, the oldest three days
 * old, and a nightly sweep was discovering hundreds more meetings each run.
 *
 * That is not a slow archive, it is one that **cannot converge**: intake
 * structurally exceeds drain, so the backlog grows no matter how long it runs.
 * Eighteen nights of fetching to clear a backlog that a single sweep adds to.
 *
 * The fix is not to fetch faster — the crawl-delay is a published commitment
 * and stays exactly as it is. It is to stop stopping. At the same ten seconds,
 * a loop that runs all day does what a fifteen-minute box does in a night,
 * ninety-six times over, and the backlog clears in hours.
 */
export const FETCH_STAGES = ["fetch"] as const;

/**
 * Whether the standing fetch loop runs. **Off unless an operator turns it on.**
 *
 * Every other loop in this file is gated on `schedulerEnabled` and nothing
 * else, because none of them can reach the network. This one can, and enabling
 * it changes what a third party sees from us: not the request *rate*, which is
 * unchanged and still `Crawl-delay: 10`, but the daily *volume* — from a
 * quarter-hour of fetching a night to as much as the backlog holds.
 *
 * That is the operator's decision about this project's footprint against a
 * county's vendor, not a default worth inheriting from a code change. So it
 * ships dark, exactly like alert delivery, and the console says which it is.
 */
/**
 * How long the fetch loop waits after boot before claiming anything.
 *
 * The crash-loop objection in `STATIONARY_STAGES` is real and this is the
 * answer to it. A politeness delay is held *per process*, so it is reset by a
 * restart — a container restarting every few seconds would issue a request per
 * boot with no delay between them, which is precisely the crawl that comment
 * refuses. A minute of silence at startup makes a crash-loop quieter than a
 * healthy process rather than louder, and costs a working deployment one
 * minute, once.
 */
export const FETCH_LOOP_START_DELAY_MS = 60_000;

export function fetchWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FETCH_WORKER_ENABLED;
  if (raw === undefined || raw === "") return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * `extract` gets a worker of its own, not a seat on the stationary one.
 *
 * Two reasons. A set of minutes is minutes of sequential model calls, and on a
 * shared loop with `batchSize: 1` it would stall every parse behind it. And the
 * free tier is rate-limited per minute, so extraction needs its own low
 * concurrency knob — `EXTRACT_CONCURRENCY` — rather than inheriting whatever
 * suits parsing.
 *
 * It is still a post-`fetch` stage: content address in, no URL anywhere, so
 * running it from boot cannot turn a restart into a crawl.
 */
export const EXTRACT_STAGES = ["extract"] as const;

/**
 * `govern` gets its own loop too, for `EXTRACT_STAGES`' reasons and one more.
 *
 * The governor calls a *different* model from the extractor — that is the point
 * of it — but both calls go out on this project's single API key, and a governor
 * sharing the extraction loop would take turns with the pass that feeds it.
 * Separate loops, separate concurrency knobs, and a governor outage that leaves
 * extraction untouched.
 */
export const GOVERN_STAGES = ["govern"] as const;

/**
 * `locate` gets its own loop, for `EXTRACT_STAGES`' reasons and one more.
 *
 * The geocoder is a free public service with published rate limits, and the
 * politeness interval lives inside `CensusGeocoder` — one client, one loop, one
 * request at a time. Sharing the extraction worker would put two geocoders
 * behind one interval and quietly double the rate.
 *
 * Still a post-`fetch` stage: content address in, no URL anywhere, so running it
 * from boot cannot turn a restart into a crawl of a county web server. The one
 * host it can reach is the geocoder its handler was constructed with.
 */
export const LOCATE_STAGES = ["locate"] as const;

export interface IngestionStack {
  registry: AdapterRegistry;
  queue: IngestionQueue;
  worker: IngestionWorker;
  /** Polls `parse` and `analyze` from boot. Never claims a networked stage. */
  stationaryWorker: IngestionWorker;
  /** Polls `extract` from boot, one job at a time. */
  extractionWorker: IngestionWorker;
  /**
   * Polls `govern` from boot, or `null` when the pins are misconfigured.
   *
   * Null rather than a worker that throws: a governor whose model equals the
   * extractor's, or whose pin is not free, must not run — but that is a reason
   * to have no second opinion, not a reason to take the site down. The jobs are
   * held in `blocked` with "no handler registered for stage 'govern'", which is
   * visible in the console and reversible once the environment is fixed.
   */
  governorWorker: IngestionWorker | null;
  /** Polls `locate` from boot, one job at a time. */
  locateWorker: IngestionWorker;
  /**
   * Polls `fetch` from boot **only when an operator has enabled it**.
   *
   * Built either way so the console can report it as off rather than absent:
   * a capability that exists and is switched off is a different fact from one
   * that was never built, and this project publishes the difference.
   */
  fetchWorker: IngestionWorker;
  scheduler: SourceScheduler;
}

export interface BuildOptions {
  registry?: AdapterRegistry;
  artifacts?: ArtifactWriter;
  read?: (key: string) => Promise<Buffer>;
  enabled?: boolean;
  /** How far back a sweep's `discover` looks. Defaults to the scheduler's own. */
  lookbackDays?: number;
}

export function buildIngestionStack(db: Knex, options: BuildOptions = {}): IngestionStack {
  const registry = options.registry ?? createDefaultRegistry();
  const queue = new IngestionQueue(db);
  const worker = new IngestionWorker(db, queue, {
    handlers: createIngestionHandlers({
      db,
      registry,
      artifacts: options.artifacts ?? minioArtifactWriter,
      logger: {
        info: (message) => structuredLogger.info(message, { service: "ingestion-handlers" }),
        warn: (message) => structuredLogger.warn(message, { service: "ingestion-handlers" }),
      },
    }),
    artifacts: createArtifactStore(options.read ?? downloadDocument),
    // One job at a time: the adapter serialises its own requests anyway, and a
    // wider batch would only make the politeness delay look like slowness.
    batchSize: 1,
  });
  /**
   * The standing worker, restricted to the stages that touch nothing.
   *
   * A separate instance from `worker` rather than a flag on it, because the two
   * have genuinely different jobs: `worker` is driven by a sweep and may claim
   * any stage including `fetch`; this one polls from boot and must never be
   * able to. `parse` and `analyze` receive a content address and no URL, and a
   * context with no fetcher — so there is nothing in scope for this loop to
   * dereference, which is what makes running it from boot safe.
   */
  const stationaryWorker = new IngestionWorker(db, queue, {
    handlers: createIngestionHandlers({
      db,
      registry,
      artifacts: options.artifacts ?? minioArtifactWriter,
      logger: {
        info: (message) => structuredLogger.info(message, { service: "ingestion-handlers" }),
        warn: (message) => structuredLogger.warn(message, { service: "ingestion-handlers" }),
      },
    }),
    artifacts: createArtifactStore(options.read ?? downloadDocument),
    batchSize: 1,
    stages: STATIONARY_STAGES,
    // Longer than the sweep worker's: this loop lives for the life of the
    // process, and polling an empty table every second forever is a query per
    // second for nothing.
    idleDelayMs: 5000,
  });
  /**
   * The extraction loop.
   *
   * Its handler is built here rather than in `createIngestionHandlers` because
   * it needs an OpenRouter client and no other stage does — and a client
   * constructed in the shared factory would be built by every test that builds
   * handlers. Unconfigured, the handler blocks its jobs with "OPENROUTER_API_KEY
   * is not set", which is the honest state of that deployment rather than a
   * crash.
   */
  const extractionWorker = new IngestionWorker(db, queue, {
    handlers: { extract: createExtractHandler({ client: new OpenRouterClient() }) },
    artifacts: createArtifactStore(options.read ?? downloadDocument),
    batchSize: EXTRACT_CONCURRENCY,
    stages: EXTRACT_STAGES,
    idleDelayMs: 5000,
  });
  /**
   * The governor loop, or nothing at all.
   *
   * `createGovernorClient` is the startup refusal: it asserts the pin is free
   * and that it is not the extractor's, in the constructor path rather than at
   * call time, so a deployment that copied one environment variable into the
   * other finds out here instead of after a batch of rubber-stamped claims. The
   * refusal is caught because a bad governor pin is a reason to run without a
   * second opinion, not a reason for the API to fail to boot.
   */
  let governorWorker: IngestionWorker | null = null;
  try {
    const governor = createGovernorClient();
    governorWorker = new IngestionWorker(db, queue, {
      handlers: { govern: createGovernHandler({ client: governor }) },
      artifacts: createArtifactStore(options.read ?? downloadDocument),
      batchSize: GOVERN_CONCURRENCY,
      stages: GOVERN_STAGES,
      idleDelayMs: 5000,
    });
  } catch (error) {
    // Both refusals land here: the two pins being equal, and a pin that would
    // cost money. `assertFreeModel` throws the second one.
    if (!(error instanceof GovernorMisconfigured) && !(error instanceof OpenRouterError)) {
      throw error;
    }
    // Loud, and it names the fix. A governor that quietly does not exist is the
    // same failure as a backlog nobody counts.
    structuredLogger.error("Ingestion: the governor will not run", {
      service: "ingestion",
      reason: error.message,
    });
  }
  /**
   * The location loop.
   *
   * Its geocoder is built here for the reason the extraction handler's client
   * is: it is the only stage that needs one, and a client constructed in the
   * shared handler factory would be built by every test that builds handlers.
   * `CensusGeocoder` needs no key and no configuration, so unlike the governor
   * there is no misconfiguration to refuse at startup — the failure it can have
   * is the service being unreachable, and that is a retry, not a boot decision.
   */
  const locateWorker = new IngestionWorker(db, queue, {
    handlers: { locate: createLocateHandler({ geocoder: new CensusGeocoder() }) },
    artifacts: createArtifactStore(options.read ?? downloadDocument),
    batchSize: LOCATE_CONCURRENCY,
    stages: LOCATE_STAGES,
    idleDelayMs: 5000,
  });
  /**
   * The standing fetch loop.
   *
   * Its own instance rather than a stage added to `stationaryWorker`, for the
   * reason that comment gives: the standing worker's safety property is that it
   * *cannot* dereference anything, and adding `fetch` to it would delete that
   * property for every deployment rather than the ones that opted in. Keeping
   * them separate means the sentence "this loop cannot reach the network"
   * stays true of the loop it was written about.
   *
   * `batchSize: 1` because the transport serialises per host anyway — a wider
   * batch would queue jobs behind the same ten-second delay and only make the
   * politeness look like slowness.
   */
  const fetchWorker = new IngestionWorker(db, queue, {
    handlers: createIngestionHandlers({
      db,
      registry,
      artifacts: options.artifacts ?? minioArtifactWriter,
      logger: {
        info: (message) => structuredLogger.info(message, { service: "ingestion-fetch" }),
        warn: (message) => structuredLogger.warn(message, { service: "ingestion-fetch" }),
      },
    }),
    artifacts: createArtifactStore(options.read ?? downloadDocument),
    batchSize: 1,
    stages: FETCH_STAGES,
    idleDelayMs: 5000,
  });
  const scheduler = new SourceScheduler(db, {
    queue,
    worker,
    registry,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.lookbackDays === undefined ? {} : { lookbackDays: options.lookbackDays }),
  });
  return {
    registry,
    queue,
    worker,
    stationaryWorker,
    extractionWorker,
    governorWorker,
    locateWorker,
    fetchWorker,
    scheduler,
  };
}

/**
 * Ensures the rows a registered adapter needs, then starts the scheduler.
 *
 * Registration is safe on every boot and touches no network. New sources are
 * created **disabled**: nothing sweeps because a container started, only
 * because an operator said so and a cron tick arrived.
 */
export async function startIngestion(
  db: Knex,
  stack: IngestionStack,
): Promise<RegisteredSource[]> {
  const registered = await registerSources(db, stack.registry, {
    expectedIntervalHours: 24 * 7,
  });
  for (const source of registered) {
    if (source.created) {
      structuredLogger.info("Ingestion: registered source, disabled", {
        service: "ingestion",
        adapterKey: source.adapterKey,
        sourceId: source.sourceId,
        detail: "enable it and set cron_expression in ingestion_sources when you want it to sweep",
      });
    }
  }
  /**
   * Anything left `running` by the process this one replaced.
   *
   * A claim is only reversible by the worker that made it, so a deploy in the
   * middle of a job strands that row forever. Recovering at boot is what makes
   * "the queue is restart-safe" true rather than merely intended — and it is
   * the reason extraction belongs on the queue at all, since an extract job
   * holds its claim for minutes and is the likeliest thing to be in flight when
   * a deploy lands.
   */
  const recovered = await stack.queue.recoverStalled();
  if (recovered > 0) {
    structuredLogger.info("Ingestion: requeued job(s) abandoned by a stopped worker", {
      service: "ingestion",
      recovered,
    });
  }

  /**
   * The same recovery for run rows, which the job-level one never covered.
   *
   * A deploy mid-sweep left `ingestion_runs` rows `running` forever, so the
   * sources screen reported a sweep in progress for a process that had been
   * replaced hours earlier. Requeuing the jobs without closing the run fixed the
   * work and left the reporting wrong.
   */
  const closedRuns = await stack.scheduler.recoverAbandonedRuns();
  if (closedRuns > 0) {
    structuredLogger.info("Ingestion: closed run(s) abandoned by a stopped process", {
      service: "ingestion",
      closedRuns,
    });
  }

  await stack.scheduler.start();

  /**
   * Turn the queue continuously, not only inside a sweep.
   *
   * `IngestionWorker` has had a poll loop since it was written and nothing ever
   * called it — `index.ts` referenced `worker.stop()` on shutdown and
   * `worker.start()` nowhere. So the only thing that ever drained the queue was
   * `SourceScheduler.drain()`, which runs inside a sweep and gives up at the
   * sweep deadline.
   *
   * Two consequences, both seen in production on 2026-08-10:
   *
   *  - **Re-parse did nothing observable.** It enqueues `parse` jobs and
   *    answers 202, and with no worker running they sat `pending` until the
   *    next sweep. The button reported success and produced silence.
   *  - **A time-boxed sweep left its remainder frozen.** Bozeman's first sweep
   *    fetched 89 documents and stopped with 250 fetches and 89 parses queued.
   *    Those are stored bytes needing no network — parse touches nothing
   *    outside — and nothing was going to run them for a day.
   *
   * Started here rather than in `index.ts` so the queue and the cron arm
   * together: both are "ingestion is live", and a deployment with one and not
   * the other is the state that produced the confusion above.
   *
   * It claims `parse` and `analyze` only — see `STATIONARY_STAGES`. Those two
   * cannot reach the network, so this loop cannot turn a restart into a crawl,
   * and the boot-safety rule that `SourceScheduler.start()` enforces stays
   * intact. Fetching remains sweep-driven.
   *
   * Gated on the same flag as the scheduler: a test process that quietly ran
   * handlers against its own fixtures would make suites depend on timing they
   * never asked for.
   *
   * Not awaited: `start()` resolves only when the loop winds down at shutdown.
   */
  if (schedulerEnabled()) {
    void stack.stationaryWorker.start().catch((error: unknown) => {
      structuredLogger.error("Ingestion: parse/analyze worker loop stopped", { service: "ingestion", error });
    });
    // Same gate, same reasoning, its own loop: without it an operator's
    // "extract" button would enqueue a job nothing ever claims — which is the
    // failure re-parse had for a day, reported as success and producing silence.
    void stack.extractionWorker.start().catch((error: unknown) => {
      structuredLogger.error("Ingestion: extract worker loop stopped", { service: "ingestion", error });
    });
    // Third loop, same gate. Absent when the governor pins are misconfigured —
    // see `buildIngestionStack` — in which case govern jobs are held in
    // `blocked` and say so, rather than disappearing.
    //
    // NOTE FOR THE SHUTDOWN PATH: `src/index.ts` stops the other two loops on
    // SIGTERM and does not yet stop this one. It needs
    // `ingestion.governorWorker?.stop();` beside them.
    if (stack.governorWorker !== null) {
      void stack.governorWorker.start().catch((error: unknown) => {
        structuredLogger.error("Ingestion: govern worker loop stopped", { service: "ingestion", error });
      });
    }
    // Fourth loop, same gate. Without it a queued `locate` job would sit
    // `pending` forever and `places` would stay empty while the console reported
    // the enqueue as a success — which is exactly the failure re-parse had for a
    // day.
    //
    // NOTE FOR THE SHUTDOWN PATH: `src/index.ts` needs
    // `ingestion.locateWorker.stop();` beside the other two, and
    // `ingestion.governorWorker?.stop();` which is still missing.
    void stack.locateWorker.start().catch((error: unknown) => {
      structuredLogger.error("Ingestion: locate worker loop stopped", { service: "ingestion", error });
    });

    /**
     * The fetch loop, behind its own gate as well as this one.
     *
     * Both states are logged, and the off state is logged at `info` rather than
     * silently skipped: an operator reading boot output should be able to see
     * that the loop exists and is off, because the failure this whole change
     * addresses was a backlog nothing was draining and nothing saying so.
     */
    if (fetchWorkerEnabled()) {
      structuredLogger.info("Ingestion: standing fetch loop is ON", {
        service: "ingestion",
        detail: "FETCH_WORKER_ENABLED is set; fetch drains continuously at each adapter's published crawl-delay",
      });
      const timer = setTimeout(() => {
        void stack.fetchWorker.start().catch((error: unknown) => {
          structuredLogger.error("Ingestion: fetch worker loop stopped", { service: "ingestion", error });
        });
      }, FETCH_LOOP_START_DELAY_MS);
      // Unref'd so the delay cannot hold a shutdown open for a minute, and
      // cannot keep a short-lived process alive waiting to start crawling.
      timer.unref();
    } else {
      structuredLogger.info("Ingestion: standing fetch loop is OFF", {
        service: "ingestion",
        detail: "set FETCH_WORKER_ENABLED=true to drain fetch continuously; without it fetch runs only inside a sweep's 15-minute window",
      });
    }
  }

  return registered;
}

export { schedulerEnabled, SourceScheduler };
export * from "./registration";

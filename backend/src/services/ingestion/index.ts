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
import { OpenRouterClient } from "../extraction/openrouter";
import { createExtractHandler, EXTRACT_CONCURRENCY } from "../extraction/stage";

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
 */
export const STATIONARY_STAGES = ["parse", "analyze"] as const;

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

export interface IngestionStack {
  registry: AdapterRegistry;
  queue: IngestionQueue;
  worker: IngestionWorker;
  /** Polls `parse` and `analyze` from boot. Never claims a networked stage. */
  stationaryWorker: IngestionWorker;
  /** Polls `extract` from boot, one job at a time. */
  extractionWorker: IngestionWorker;
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
      logger: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
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
      logger: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
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
  const scheduler = new SourceScheduler(db, {
    queue,
    worker,
    registry,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.lookbackDays === undefined ? {} : { lookbackDays: options.lookbackDays }),
  });
  return { registry, queue, worker, stationaryWorker, extractionWorker, scheduler };
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
      console.log(
        `Ingestion: registered source ${source.adapterKey} (${source.sourceId}), disabled — ` +
          "enable it and set cron_expression in ingestion_sources when you want it to sweep",
      );
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
    console.log(`Ingestion: requeued ${recovered} job(s) abandoned by a stopped worker`);
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
      console.error("Ingestion: parse/analyze worker loop stopped", error);
    });
    // Same gate, same reasoning, its own loop: without it an operator's
    // "extract" button would enqueue a job nothing ever claims — which is the
    // failure re-parse had for a day, reported as success and producing silence.
    void stack.extractionWorker.start().catch((error: unknown) => {
      console.error("Ingestion: extract worker loop stopped", error);
    });
  }

  return registered;
}

export { schedulerEnabled, SourceScheduler };
export * from "./registration";

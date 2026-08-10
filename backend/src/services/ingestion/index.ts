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

export interface IngestionStack {
  registry: AdapterRegistry;
  queue: IngestionQueue;
  worker: IngestionWorker;
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
  const scheduler = new SourceScheduler(db, {
    queue,
    worker,
    registry,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.lookbackDays === undefined ? {} : { lookbackDays: options.lookbackDays }),
  });
  return { registry, queue, worker, scheduler };
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
  await stack.scheduler.start();
  return registered;
}

export { schedulerEnabled, SourceScheduler };
export * from "./registration";

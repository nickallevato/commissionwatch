import app from "./app";
import db from "./config/database";
import { NotificationService } from "./services/notification";
import { EmailDeliveryService } from "./services/email-delivery";
import { DigestScheduler } from "./services/digest-scheduler";
import { registerDigestStatus } from "./routes/health";
import { operatorAuthService } from "./middleware/requireOperator";
import { buildIngestionStack, startIngestion } from "./services/ingestion";
import { registerPressroomStack } from "./routes/admin/pressroom";
import { DeliveryDispatcher } from "./services/delivery/dispatcher";
import { EventDrain } from "./services/events/drain";
import { PrerenderConsumer } from "./services/prerender/consumer";
import { DisputeMailer, ensureDisputeReplyChannel } from "./services/dispute-notifications";
import { FeatureRegistry, setFeatureRegistry } from "./services/features/registry";
import { ExportSnapshotScheduler } from "./services/export/snapshot-scheduler";
import { SessionSweepScheduler } from "./services/auth/session-sweep";
import { logger } from "./services/logging/logger";

const PORT = process.env.PORT || 3001;

const emailService = new EmailDeliveryService(db);
const notificationService = new NotificationService(db, (ids) => emailService.sendImmediateAlerts(ids));
const digestScheduler = new DigestScheduler(db, emailService);
const ingestion = buildIngestionStack(db);

registerDigestStatus(() => digestScheduler.getStatus());

// The console's two action routes — "sweep now" and "re-parse" — need the live
// queue and scheduler. Handed over here rather than imported there, so the
// route module stays constructible in a test that has Postgres and no MinIO.
registerPressroomStack({ queue: ingestion.queue, scheduler: ingestion.scheduler });

// Consumed once: a no-op when the table already holds an operator, so it is
// safe on every boot. A failure is logged, not fatal — a running site nobody
// can sign into beats a site that will not start.
operatorAuthService()
  .seedFirstOperator()
  .catch((err: unknown) => logger.error("Operator seed failed", { error: err }));

/**
 * The delivery dispatcher, constructed by a running server for the first time.
 *
 * It has existed since it was written — 643 lines of durable, batching,
 * consent-gating delivery — and its only callers were a hand-run script and the
 * test suite. Nothing in production ever built one, so every channel it can
 * drive was reachable only by a person on the host.
 *
 * The drain is what feeds it: `events` rows are written only for objects that
 * are already public, so a consumer reading events needs no publication check of
 * its own. The `event_drain` feature is off, so this ships **dark** — it starts,
 * logs that it is disabled, and sends nothing. That is deliberate: the loop runs
 * in production over an empty `channel_routes` table before any channel is
 * routed, which is the cheapest possible way to find out it works.
 */
// The `direct` transport: one message, to one address, supplied per send and
// held nowhere at rest. It exists because a disputant is not a subscriber —
// they went through no consent flow and there is no address to store — and
// because `services/disputes.ts` guaranteed for months that a dispute produced
// "no email to anyone", which read from the disputant's side as silence.
/**
 * The feature registry, installed before anything reads a flag.
 *
 * Built here rather than inside `services/features/registry.ts` for the reason
 * that file states: a service in this codebase takes its `Knex` from its caller,
 * and importing `config/database` from the flag module would open a pool the
 * moment anything imported a flag check — including a test with no database.
 * `src/index.ts` is the one place that already owns the live handle.
 *
 * Installed **above** the drain and the consumer, because both read their switch
 * in their constructor. Started immediately so the poller is armed and the first
 * refresh is in flight; `start()` awaits nothing and throws nothing, so a backend
 * that cannot reach Postgres still binds its port and resolves every key through
 * env and default — which is off unless a legacy variable says otherwise.
 *
 * `stop()` is in `shutdown` with the other pollers. The interval is `unref`'d, so
 * it would not by itself hold the loop open, but a timer still firing while the
 * pool is being destroyed logs a refresh failure on the way out and that reads in
 * the deploy log like a fault when it is a shutdown.
 */
const features = new FeatureRegistry(db);
setFeatureRegistry(features);
features.start();

const dispatcher = new DeliveryDispatcher(db, { direct: new DisputeMailer(db) });
const eventDrain = new EventDrain(db, { dispatcher });

// The prerender consumer writes a static, self-contained copy of every public
// page for readers that do not run JavaScript. It reads the same `events` table
// the drain does but never writes `dispatched_at` — that column is the drain's,
// and a second writer would steal events from it. Off unless the `prerender`
// feature is on, which the console can now do without a redeploy.
const prerender = new PrerenderConsumer(db);

/**
 * The dated export archive's scheduler, and the reason it lives here.
 *
 * The archive shipped with a writer nothing called: `npm run export:snapshot` is
 * a command a human has to remember, so the archive would have held one
 * snapshot — taken the day it was tested — and answered 404 for every other
 * date. Publication state is a single mutable column, so a day nobody recorded
 * can never be reconstructed; a missed day is missed permanently.
 *
 * It is a loop here rather than a stage in the ingestion queue because a
 * snapshot is not per-document work and has no `ingestion_sources` row: the
 * queue's stages carry a `run_id` and an artifact, and `SourceScheduler` takes
 * its cadence from a source's `cron_expression` and locks per source id. Giving
 * the archive a fake source row to hang a cron on would put a thing that is not
 * an ingestion source into the table the public status page reads. What it
 * actually is, is the same shape as the two loops above — a capability gated on a
 * feature key, re-read per cycle — so it is built and started in the same place,
 * for the same reasons, with the same failure behaviour.
 *
 * Off unless `dated_export_archive` is on, and every skipped cycle lands in
 * `export_snapshot_runs` so a dark loop is visibly dark rather than silent.
 */
const exportSnapshots = new ExportSnapshotScheduler(db);

/**
 * Sweeps `operator_sessions` rows past their absolute expiry.
 *
 * `sweepExpiredSessions` existed since it was written and nothing called it —
 * not an auth bypass (`validateSession` already refuses an expired row at
 * use), but unbounded growth in a table holding session tokens. See
 * `services/auth/session-sweep.ts` for the reasoning; this is the fourth loop
 * on the pattern the drain, the prerender consumer and the export scheduler
 * already use.
 */
const sessionSweep = new SessionSweepScheduler(operatorAuthService());

const server = app.listen(PORT, () => {
  logger.info("CommissionWatch backend listening", { port: PORT });
  digestScheduler.start();

  // The scheduler registers its sources and arms its cron jobs. It deliberately
  // does NOT sweep here: the first execution of any source is its first cron
  // tick, so a crash-looping container cannot turn into a crawl of a county web
  // server. A failure to arm is logged and not fatal — a site that serves the
  // records it already has beats a site that will not start.
  startIngestion(db, ingestion).catch((err: unknown) =>
    logger.error("Ingestion start failed", { error: err }),
  );

  // Both loops arm their timer unconditionally and re-read their flag per cycle,
  // so an operator turning one on from the console gets it within one interval
  // rather than on the next deploy. Each cycle is a no-op while its feature is
  // off — nothing claimed, nothing written, no cursor advanced — and the drain
  // decides that itself rather than making every caller remember to ask.
  eventDrain.start();

  // As above, and it throws rather than emitting localhost canonicals if
  // PUBLIC_BASE_URL is missing.
  prerender.start();

  // And the third loop on that pattern. It arms its timer and takes nothing
  // here: the first snapshot is the first tick, so a crash-looping container
  // cannot turn a boot into a full read of every dataset.
  exportSnapshots.start();

  // The session sweep. No feature flag to re-read — see the header in
  // session-sweep.ts for why this one has nothing to gate — and, like the
  // three loops above, it arms its timer and removes nothing on this tick;
  // the first sweep is the first interval, not the first boot.
  sessionSweep.start();

  // Without this row a dispute event resolves to nothing and the ledger stays
  // `queued` — the reply is composed, recorded, and never handed to anything.
  // It must be `audience: 'ops'` and `owner_kind: 'direct'`: migration 088's
  // trigger refuses a `dispute.*` route on a public channel, and either
  // attribute alone leaves the event unroutable or routable to a webhook.
  // Nothing sends regardless until the `event_drain` feature is on.
  ensureDisputeReplyChannel(db).catch((err: unknown) =>
    logger.error("Dispute reply channel setup failed", { error: err }),
  );
});

function shutdown() {
  logger.info("Shutting down gracefully...");
  digestScheduler.stop();
  ingestion.scheduler.stop();
  ingestion.worker.stop();
  ingestion.stationaryWorker.stop();
  ingestion.extractionWorker.stop();
  // Optional: a misconfigured governor pin yields a null worker rather than
  // failing the boot, because a second-opinion pass is not worth refusing to
  // serve the archive over.
  ingestion.governorWorker?.stop();
  ingestion.locateWorker.stop();
  eventDrain.stop();
  prerender.stop();
  exportSnapshots.stop();
  sessionSweep.stop();
  features.stop();
  server.close(() => {
    // `flushAll` sends whatever is buffered in the dispatcher's batching window
    // and was written for exactly this moment. It had never been called by a
    // running server, because no running server had ever built a dispatcher —
    // so a deploy during a batch window silently dropped it. Awaited before the
    // pool closes, since flushing needs the database.
    dispatcher
      .flushAll()
      .catch((err: unknown) => logger.error("Delivery flush on shutdown failed", { error: err }))
      .finally(() => {
        void db.destroy().then(() => process.exit(0));
      });
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export {
  notificationService,
  emailService,
  digestScheduler,
  ingestion,
  dispatcher,
  eventDrain,
  prerender,
  exportSnapshots,
  sessionSweep,
  features,
};

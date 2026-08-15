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
  .catch((err) => console.error("Operator seed failed", err));

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

const server = app.listen(PORT, () => {
  console.log(`CommissionWatch backend listening on port ${PORT}`);
  digestScheduler.start();

  // The scheduler registers its sources and arms its cron jobs. It deliberately
  // does NOT sweep here: the first execution of any source is its first cron
  // tick, so a crash-looping container cannot turn into a crawl of a county web
  // server. A failure to arm is logged and not fatal — a site that serves the
  // records it already has beats a site that will not start.
  startIngestion(db, ingestion).catch((err) => console.error("Ingestion start failed", err));

  // Both loops arm their timer unconditionally and re-read their flag per cycle,
  // so an operator turning one on from the console gets it within one interval
  // rather than on the next deploy. Each cycle is a no-op while its feature is
  // off — nothing claimed, nothing written, no cursor advanced — and the drain
  // decides that itself rather than making every caller remember to ask.
  eventDrain.start();

  // As above, and it throws rather than emitting localhost canonicals if
  // PUBLIC_BASE_URL is missing.
  prerender.start();

  // Without this row a dispute event resolves to nothing and the ledger stays
  // `queued` — the reply is composed, recorded, and never handed to anything.
  // It must be `audience: 'ops'` and `owner_kind: 'direct'`: migration 088's
  // trigger refuses a `dispute.*` route on a public channel, and either
  // attribute alone leaves the event unroutable or routable to a webhook.
  // Nothing sends regardless until the `event_drain` feature is on.
  ensureDisputeReplyChannel(db).catch((err: unknown) =>
    console.error("Dispute reply channel setup failed", err),
  );
});

function shutdown() {
  console.log("Shutting down gracefully...");
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
  features.stop();
  server.close(() => {
    // `flushAll` sends whatever is buffered in the dispatcher's batching window
    // and was written for exactly this moment. It had never been called by a
    // running server, because no running server had ever built a dispatcher —
    // so a deploy during a batch window silently dropped it. Awaited before the
    // pool closes, since flushing needs the database.
    dispatcher
      .flushAll()
      .catch((err: unknown) => console.error("Delivery flush on shutdown failed", err))
      .finally(() => {
        void db.destroy().then(() => process.exit(0));
      });
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { notificationService, emailService, digestScheduler, ingestion, dispatcher, eventDrain, prerender, features };

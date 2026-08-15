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
 * its own. `EVENT_DRAIN_ENABLED` is unset, so this ships **dark** — it starts,
 * logs that it is disabled, and sends nothing. That is deliberate: the loop runs
 * in production over an empty `channel_routes` table before any channel is
 * routed, which is the cheapest possible way to find out it works.
 */
const dispatcher = new DeliveryDispatcher(db);
const eventDrain = new EventDrain(db, { dispatcher });

const server = app.listen(PORT, () => {
  console.log(`CommissionWatch backend listening on port ${PORT}`);
  digestScheduler.start();

  // The scheduler registers its sources and arms its cron jobs. It deliberately
  // does NOT sweep here: the first execution of any source is its first cron
  // tick, so a crash-looping container cannot turn into a crawl of a county web
  // server. A failure to arm is logged and not fatal — a site that serves the
  // records it already has beats a site that will not start.
  startIngestion(db, ingestion).catch((err) => console.error("Ingestion start failed", err));

  // No-op unless EVENT_DRAIN_ENABLED is set; the drain decides that itself
  // rather than making every caller remember to ask.
  eventDrain.start();
});

function shutdown() {
  console.log("Shutting down gracefully...");
  digestScheduler.stop();
  ingestion.scheduler.stop();
  ingestion.worker.stop();
  ingestion.stationaryWorker.stop();
  ingestion.extractionWorker.stop();
  eventDrain.stop();
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

export { notificationService, emailService, digestScheduler, ingestion, dispatcher, eventDrain };

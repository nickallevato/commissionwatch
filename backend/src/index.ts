import app from "./app";
import db from "./config/database";
import { NotificationService } from "./services/notification";
import { EmailDeliveryService } from "./services/email-delivery";
import { DigestScheduler } from "./services/digest-scheduler";
import { registerDigestStatus } from "./routes/health";
import { operatorAuthService } from "./middleware/requireOperator";
import { buildIngestionStack, startIngestion } from "./services/ingestion";
import { registerPressroomStack } from "./routes/admin/pressroom";

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

const server = app.listen(PORT, () => {
  console.log(`CommissionWatch backend listening on port ${PORT}`);
  digestScheduler.start();

  // The scheduler registers its sources and arms its cron jobs. It deliberately
  // does NOT sweep here: the first execution of any source is its first cron
  // tick, so a crash-looping container cannot turn into a crawl of a county web
  // server. A failure to arm is logged and not fatal — a site that serves the
  // records it already has beats a site that will not start.
  startIngestion(db, ingestion).catch((err) => console.error("Ingestion start failed", err));
});

function shutdown() {
  console.log("Shutting down gracefully...");
  digestScheduler.stop();
  ingestion.scheduler.stop();
  ingestion.worker.stop();
  server.close(() => {
    db.destroy().then(() => process.exit(0));
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { notificationService, emailService, digestScheduler, ingestion };

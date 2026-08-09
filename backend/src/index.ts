import app from "./app";
import db from "./config/database";
import { NotificationService } from "./services/notification";
import { EmailDeliveryService } from "./services/email-delivery";
import { DigestScheduler } from "./services/digest-scheduler";
import { registerDigestStatus } from "./routes/health";
import { operatorAuthService } from "./middleware/requireOperator";

const PORT = process.env.PORT || 3001;

const emailService = new EmailDeliveryService(db);
const notificationService = new NotificationService(db, (ids) => emailService.sendImmediateAlerts(ids));
const digestScheduler = new DigestScheduler(db, emailService);

registerDigestStatus(() => digestScheduler.getStatus());

// Consumed once: a no-op when the table already holds an operator, so it is
// safe on every boot. A failure is logged, not fatal — a running site nobody
// can sign into beats a site that will not start.
operatorAuthService()
  .seedFirstOperator()
  .catch((err) => console.error("Operator seed failed", err));

const server = app.listen(PORT, () => {
  console.log(`CommissionWatch backend listening on port ${PORT}`);
  digestScheduler.start();
});

function shutdown() {
  console.log("Shutting down gracefully...");
  digestScheduler.stop();
  server.close(() => {
    db.destroy().then(() => process.exit(0));
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { notificationService, emailService, digestScheduler };

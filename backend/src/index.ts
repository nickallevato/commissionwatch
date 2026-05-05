import app from "./app";
import db from "./config/database";
import { NotificationService } from "./services/notification";
import { EmailDeliveryService } from "./services/email-delivery";
import { DigestScheduler } from "./services/digest-scheduler";

const PORT = process.env.PORT || 3001;

const emailService = new EmailDeliveryService(db);
const notificationService = new NotificationService(db, (ids) => emailService.sendImmediateAlerts(ids));
const digestScheduler = new DigestScheduler(db, emailService);

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

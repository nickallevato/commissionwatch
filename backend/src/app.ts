import express, { type Request } from "express";
import cors, { type CorsOptions, type CorsOptionsDelegate } from "cors";
import helmet from "helmet";
import healthRouter from "./routes/health";
import versionRouter from "./routes/version";
import jurisdictionsRouter from "./routes/jurisdictions";
import meetingsRouter from "./routes/meetings";
import membersRouter from "./routes/members";
import votesRouter from "./routes/votes";
import anomaliesRouter from "./routes/anomalies";
import ingestionRouter from "./routes/ingestion";
import subscriptionsRouter from "./routes/subscriptions";
import notificationsRouter from "./routes/notifications";
import alertsRouter from "./routes/alerts";
import smsRouter from "./routes/sms";
import adminRouter from "./routes/admin";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

/**
 * Origins permitted to make credentialed requests to /api/admin. Comma
 * separated in ADMIN_ORIGINS. The Vite dev server is included by default so
 * local development needs no configuration.
 */
const ADMIN_ORIGINS = (
  process.env.ADMIN_ORIGINS ?? "https://commissionwatch.bmux.sh,http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

/**
 * Two policies, one middleware.
 *
 * The public read-only API stays open to any origin — open data is the point.
 * The admin surface takes an explicit allowlist and `credentials: true`,
 * because it carries a session cookie, and `origin: *` with credentials is
 * both forbidden by the CORS spec and unsafe. Until A1 there was nothing to
 * steal; there is now.
 *
 * A delegate rather than two `app.use(cors())` calls: the second would
 * overwrite the first's headers and silently reopen the admin surface.
 */
const corsDelegate: CorsOptionsDelegate<Request> = (req, callback) => {
  const options: CorsOptions = req.path.startsWith("/api/admin")
    ? { origin: ADMIN_ORIGINS, credentials: true }
    : { origin: "*" };
  callback(null, options);
};

app.use(helmet());
app.use(cors(corsDelegate));
app.use(express.json());

app.use("/api/health", healthRouter);
app.use("/api/version", versionRouter);
app.use("/api/jurisdictions", jurisdictionsRouter);
app.use("/api/meetings", meetingsRouter);
app.use("/api/members", membersRouter);
app.use("/api/votes", votesRouter);
app.use("/api/anomalies", anomaliesRouter);
app.use("/api/ingestion", ingestionRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/notifications", notificationsRouter);
// The unified self-serve alerts surface. /api/subscriptions above is the
// legacy email-only one, retained read-only for one release per B-e.
app.use("/api/alerts", alertsRouter);
// Twilio posts form-encoded, not JSON, so this router needs its own parser.
app.use("/api/sms", express.urlencoded({ extended: false }), smsRouter);
app.use("/api/admin", adminRouter);

app.use(errorHandler);

export default app;

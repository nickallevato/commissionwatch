import express, { type Request } from "express";
import cors, { type CorsOptions, type CorsOptionsDelegate } from "cors";
import helmet from "helmet";
import healthRouter from "./routes/health";
import versionRouter from "./routes/version";
import jurisdictionsRouter from "./routes/jurisdictions";
import meetingsRouter from "./routes/meetings";
import membersRouter from "./routes/members";
import officialsRouter from "./routes/officials";
import votesRouter from "./routes/votes";
import mattersRouter from "./routes/matters";
import anomaliesRouter from "./routes/anomalies";
import ingestionRouter from "./routes/ingestion";
import subscriptionsRouter from "./routes/subscriptions";
import notificationsRouter from "./routes/notifications";
import alertsRouter from "./routes/alerts";
import smsRouter from "./routes/sms";
import searchRouter from "./routes/search";
import publicRecordsRouter from "./routes/public-records";
import correctionsRouter from "./routes/corrections";
import dataRouter from "./routes/data";
import metricsRouter from "./routes/metrics";
import discordRouter from "./routes/discord";
import placesRouter from "./routes/places";
import sourceRouter from "./routes/source";
import transcriptsRouter from "./routes/transcripts";
import feedRouter from "./routes/feed";
import sitemapRouter from "./routes/sitemap";
import calendarRouter from "./routes/calendar";
import adminRouter from "./routes/admin";
import { publicRateLimit } from "./services/rate-limit";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

/**
 * Exactly one proxy: Caddy, on the shared host, in front of this container.
 *
 * Without this, `req.ip` is Caddy's address and every reader on the internet
 * looks like one client — which would make B3's per-client dispute limit a
 * single shared bucket that the first submitter of the hour empties for
 * everybody. With it, Express takes the rightmost `X-Forwarded-For` entry,
 * which is the one Caddy appended, so a client that writes its own header
 * cannot displace its real address. The number is `1` and not `true` for that
 * reason: `true` trusts the whole chain, including anything the client wrote.
 */
app.set("trust proxy", 1);

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

/**
 * Before the body parsers, after CORS.
 *
 * After CORS so a preflight is answered rather than counted — a browser that
 * cannot read the 429 it got for an OPTIONS request reports a CORS error, which
 * sends the reader looking in entirely the wrong place. Before `express.json()`
 * because there is no reason to read and parse a body belonging to a request
 * that is about to be refused.
 *
 * See `services/rate-limit.ts` for the tiers, the numbers, and the note that
 * this is in-process memory rather than a distributed limit.
 */
app.use(publicRateLimit);

app.use(express.json());

app.use("/api/health", healthRouter);
app.use("/api/version", versionRouter);
app.use("/api/jurisdictions", jurisdictionsRouter);
app.use("/api/meetings", meetingsRouter);
app.use("/api/members", membersRouter);
// The reader's view of one official: voting record, attendance, patterns and
// the donor overlay. Published records only, filtered in services/officials.ts.
app.use("/api/officials", officialsRouter);
app.use("/api/votes", votesRouter);
app.use("/api/anomalies", anomaliesRouter);
// Matters — the subject of decision behind the per-meeting agenda item, so
// "what happened to it?" has something to answer it. Derived from
// `agenda_items`, published record only, state computed at read time.
app.use("/api/matters", mattersRouter);
// P6 · full-text search. Public and unauthenticated like the rest of the read
// API, and restricted to published records inside the service.
app.use("/api/search", searchRouter);
// P7 · the public-records request generator, unauthenticated. It drafts letter
// text and writes nothing — no database row, and nothing is ever transmitted.
app.use("/api/public-records", publicRecordsRouter);
// B3 · the public corrections log, and the dispute route. Unauthenticated, and
// the only unauthenticated write in the product — see routes/corrections.ts.
app.use("/api/corrections", correctionsRouter);
// The bulk export. Unauthenticated, no key: "here is what the record shows" is
// only checkable if you can get the record. Published rows only — every query
// routes through services/publication.ts, and data-export.test.ts walks all ten
// datasets in both directions.
app.use("/api/data", dataRouter);

// Site root, not /api — a crawler looks for /sitemap.xml and nowhere else.
// `frontend/nginx.conf` has an exact-match location proxying it here.
// The feeds own their own paths, so no prefix. Served from the site root like
// the sitemap, because that is where a reader's client looks for them.
app.use(feedRouter);
app.use("/sitemap.xml", sitemapRouter);
// The public meeting calendar and the per-jurisdiction iCal feeds. Published
// meetings only; a meeting with no published time is an all-day event rather
// than an appointment at midnight.
// This project's own numbers, on the same terms it demands of others. Public
// and unauthenticated for the reason `/status` is: it describes this site's
// collection, not anybody's record.
app.use("/api/metrics", metricsRouter);
// The other end of every citation: a stored document at its content address.
// Public, and walled to documents on a published meeting.
// Stage 1 of the map: points and radius, on earthdistance rather than PostGIS,
// which is unavailable in the deployed image. Read-only — places are written by
// extraction and by operator action, and a public write endpoint here would be
// the defect that once left POST /api/anomalies unauthenticated.
app.use("/api/places", placesRouter);
app.use("/api/source", sourceRouter);
// Transcript coverage: how much of the archive has captions, how much the
// custodian published nothing for, and how much we could not fetch. Those are
// three different facts and the page has to be able to say which.
app.use("/api/transcripts", transcriptsRouter);
app.use("/api/calendar", calendarRouter);
app.use("/api/ingestion", ingestionRouter);
// The legacy email-only subscription and notification routers, now operator-
// only apart from the two token-scoped links a subscriber follows out of their
// own mail. Both join `alert_subscriptions` and select the subscriber's email,
// and unauthenticated they were a paginated dump of the one piece of reader PII
// this project holds. Readers use /api/alerts below; nothing in the frontend
// calls either of these.
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/notifications", notificationsRouter);
// The unified self-serve alerts surface, scoped by the management token from
// the subscriber's own email.
app.use("/api/alerts", alertsRouter);
// Twilio posts form-encoded, not JSON, so this router needs its own parser.
app.use("/api/sms", express.urlencoded({ extended: false }), smsRouter);
// BEFORE the admin router, which ends in a guarded catch-all 404 — anything
// mounted at /api/admin/* after it is unreachable. The router applies
// requireOperator itself, so the placement is safe as well as necessary.
app.use("/api/admin/discord", discordRouter);
app.use("/api/admin", adminRouter);

app.use(errorHandler);

export default app;

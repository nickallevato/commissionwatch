import { Router, Request } from "express";
import db from "../config/database";
import { requireOperator } from "../middleware/requireOperator";

const router = Router();

/**
 * Operator-only, all of it.
 *
 * Every route here joins `alert_subscriptions` and selects the subscriber's
 * email, and none of them is scoped by a token the caller had to be sent.
 * Unauthenticated, `GET /api/notifications` with no filter at all was a
 * paginated dump of the subscriber list — the one piece of reader PII the
 * project holds — and `PATCH /read-all` let anyone mark another reader's mail
 * read. The self-serve surface is `/api/alerts`, which is scoped by the
 * management token from the subscriber's own email; this router is the legacy
 * one and its only remaining caller is the operator.
 */
router.use(requireOperator);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_SEVERITIES = ["low", "medium", "high", "critical"];

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

interface NotificationsQuery {
  email?: string;
  subscription_id?: string;
  jurisdiction_id?: string;
  severity?: string;
  read?: string;
  limit?: string;
  offset?: string;
}

router.get("/", async (req: Request<unknown, unknown, unknown, NotificationsQuery>, res, next) => {
  try {
    const { email, subscription_id, jurisdiction_id, severity, read: readFilter, limit: rawLimit, offset: rawOffset } = req.query;

    if (email && !EMAIL_RE.test(email))
      throw badRequest("Invalid email format");
    if (subscription_id && !UUID_RE.test(subscription_id))
      throw badRequest("Invalid subscription_id format");
    if (jurisdiction_id && !UUID_RE.test(jurisdiction_id))
      throw badRequest("Invalid jurisdiction_id format");
    if (severity && !VALID_SEVERITIES.includes(severity))
      throw badRequest(`Invalid severity (expected: ${VALID_SEVERITIES.join(", ")})`);
    if (readFilter !== undefined && readFilter !== "true" && readFilter !== "false")
      throw badRequest("Invalid read filter (expected: true or false)");

    const limit = Math.min(Math.max(parseInt(rawLimit || "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(rawOffset || "0", 10) || 0, 0);

    const query = db("notifications")
      .join("alert_subscriptions", "notifications.subscription_id", "alert_subscriptions.id")
      .join("anomaly_flags", "notifications.anomaly_flag_id", "anomaly_flags.id");

    if (email) query.where("alert_subscriptions.email", email);
    if (subscription_id) query.where("notifications.subscription_id", subscription_id);
    if (jurisdiction_id) query.where("alert_subscriptions.jurisdiction_id", jurisdiction_id);
    if (severity) query.where("notifications.severity", severity);
    if (readFilter !== undefined) query.where("notifications.read", readFilter === "true");

    const countResult = await query.clone().count("notifications.id as total").first();
    const total = Number(countResult?.total ?? 0);

    const data = await query.clone()
      .select(
        "notifications.id",
        "notifications.subscription_id",
        "notifications.anomaly_flag_id",
        "notifications.severity",
        "notifications.read",
        "notifications.email_status",
        "notifications.created_at",
        "anomaly_flags.flag_type",
        "anomaly_flags.description as anomaly_description",
        "anomaly_flags.meeting_id",
        "alert_subscriptions.email",
        "alert_subscriptions.jurisdiction_id",
      )
      .orderBy("notifications.created_at", "desc")
      .limit(limit)
      .offset(offset);

    res.json({ data, total });
  } catch (err) {
    next(err);
  }
});

router.get("/count", async (req: Request<unknown, unknown, unknown, { email?: string; subscription_id?: string }>, res, next) => {
  try {
    const { email, subscription_id } = req.query;

    if (!email && !subscription_id)
      throw badRequest("Either email or subscription_id is required");
    if (email && !EMAIL_RE.test(email))
      throw badRequest("Invalid email format");
    if (subscription_id && !UUID_RE.test(subscription_id))
      throw badRequest("Invalid subscription_id format");

    const query = db("notifications")
      .join("alert_subscriptions", "notifications.subscription_id", "alert_subscriptions.id")
      .where("notifications.read", false);

    if (email) query.where("alert_subscriptions.email", email);
    if (subscription_id) query.where("notifications.subscription_id", subscription_id);

    const result = await query.count("notifications.id as count").first();

    res.json({ unread: Number(result?.count ?? 0) });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/read", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid notification ID format");

    const [updated] = await db("notifications")
      .where({ id })
      .update({ read: true })
      .returning(["id", "read"]);

    if (!updated) {
      res.status(404).json({ error: "Notification not found", statusCode: 404 });
      return;
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

interface ReadAllBody {
  email?: string;
  subscription_id?: string;
}

router.patch("/read-all", async (req: Request<unknown, unknown, ReadAllBody>, res, next) => {
  try {
    const { email, subscription_id } = req.body;

    if (!email && !subscription_id)
      throw badRequest("Either email or subscription_id is required");
    if (email && !EMAIL_RE.test(email))
      throw badRequest("Invalid email format");
    if (subscription_id && !UUID_RE.test(subscription_id))
      throw badRequest("Invalid subscription_id format");

    const query = db("notifications").where("read", false);

    if (subscription_id) {
      query.where("subscription_id", subscription_id);
    } else if (email) {
      query.whereIn(
        "subscription_id",
        db("alert_subscriptions").select("id").where({ email }),
      );
    }

    const count = await query.update({ read: true });

    res.json({ updated: count });
  } catch (err) {
    next(err);
  }
});

export default router;

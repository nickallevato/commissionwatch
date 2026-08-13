import { Router, Request } from "express";
import crypto from "node:crypto";
import db from "../config/database";
import { requireOperator } from "../middleware/requireOperator";

const router = Router();

/**
 * The legacy email-only subscription router. `/api/alerts` replaced it and is
 * the surface a reader uses; this one is retained for the operator.
 *
 * Everything that reads or writes a subscriber row now requires an operator
 * session, because nothing here proves the caller owns the row it names.
 * Unauthenticated, `GET /` was a paginated dump of every subscriber's email
 * address, `POST /` returned the `verify_token` in its own response — so a
 * stranger could subscribe an address and verify it without the owner ever
 * seeing a message — and `DELETE /:id` took an id that `GET /` had just
 * handed out.
 *
 * The two token routes below stay open. A verification or unsubscribe link is
 * followed by someone holding a 32-byte secret that only reached them by mail,
 * and an unsubscribe that demands a login is an unsubscribe that does not work.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

function notFound(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 404;
  return err;
}

function conflict(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 409;
  return err;
}

interface SubscriptionsQuery {
  email?: string;
  jurisdiction_id?: string;
  limit?: string;
  offset?: string;
}

router.get("/", requireOperator, async (req: Request<unknown, unknown, unknown, SubscriptionsQuery>, res, next) => {
  try {
    const { email, jurisdiction_id, limit: rawLimit, offset: rawOffset } = req.query;

    if (email && !EMAIL_RE.test(email))
      throw badRequest("Invalid email format");
    if (jurisdiction_id && !UUID_RE.test(jurisdiction_id))
      throw badRequest("Invalid jurisdiction_id format");

    const limit = Math.min(Math.max(parseInt(rawLimit || "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(rawOffset || "0", 10) || 0, 0);

    const query = db("alert_subscriptions");

    if (email) query.where({ email });
    if (jurisdiction_id) query.where({ jurisdiction_id });

    const countResult = await query.clone().count("* as total").first();
    const total = Number(countResult?.total ?? 0);

    const data = await query
      .select("id", "email", "jurisdiction_id", "email_enabled", "digest_only", "verified", "created_at", "updated_at")
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset);

    res.json({ data, total });
  } catch (err) {
    next(err);
  }
});

interface CreateSubscriptionBody {
  email?: string;
  jurisdiction_id?: string;
  email_enabled?: boolean;
  digest_only?: boolean;
}

router.post("/", requireOperator, async (req: Request<unknown, unknown, CreateSubscriptionBody>, res, next) => {
  try {
    const { email: rawEmail, jurisdiction_id, email_enabled, digest_only } = req.body;

    if (!rawEmail || typeof rawEmail !== "string" || !EMAIL_RE.test(rawEmail.trim()))
      throw badRequest("Valid email is required");
    if (!jurisdiction_id || !UUID_RE.test(jurisdiction_id))
      throw badRequest("Valid jurisdiction_id is required");

    const email = rawEmail.trim().toLowerCase();

    const jurisdiction = await db("jurisdictions").where({ id: jurisdiction_id }).first();
    if (!jurisdiction) throw badRequest("Jurisdiction not found");

    const existing = await db("alert_subscriptions")
      .where({ email, jurisdiction_id })
      .first();
    if (existing) throw conflict("Subscription already exists for this email and jurisdiction");

    const verify_token = crypto.randomBytes(32).toString("hex");
    const unsubscribe_token = crypto.randomBytes(32).toString("hex");

    const [subscription] = await db("alert_subscriptions")
      .insert({
        email,
        jurisdiction_id,
        email_enabled: email_enabled ?? true,
        digest_only: digest_only ?? false,
        verify_token,
        unsubscribe_token,
      })
      .returning(["id", "email", "jurisdiction_id", "email_enabled", "digest_only", "verified", "created_at"]);

    // Not `verify_token`. The token's whole job is to prove the person holding
    // it reads the mailbox, which it cannot do if the response that creates it
    // also prints it.
    res.status(201).json(subscription);
  } catch (err) {
    next(err);
  }
});

router.get("/verify/:token", async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!token || token.length !== 64) throw badRequest("Invalid verification token");

    const subscription = await db("alert_subscriptions")
      .where({ verify_token: token })
      .first();

    if (!subscription) {
      res.status(404).json({ error: "Invalid or expired verification token", statusCode: 404 });
      return;
    }

    if (subscription.verified) {
      res.json({ message: "Subscription already verified" });
      return;
    }

    await db("alert_subscriptions")
      .where({ id: subscription.id })
      .update({ verified: true, updated_at: db.fn.now() });

    res.json({ message: "Subscription verified successfully" });
  } catch (err) {
    next(err);
  }
});

router.get("/unsubscribe/:token", async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!token || token.length !== 64) throw badRequest("Invalid unsubscribe token");

    const [subscription] = await db("alert_subscriptions")
      .where({ unsubscribe_token: token })
      .update({ email_enabled: false, updated_at: db.fn.now() })
      .returning(["id", "email", "jurisdiction_id", "email_enabled"]);

    if (!subscription) throw notFound("Invalid unsubscribe token");

    res.json({ message: "Successfully unsubscribed from email alerts", subscription });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requireOperator, async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid subscription ID format");

    const subscription = await db("alert_subscriptions")
      .select("id", "email", "jurisdiction_id", "email_enabled", "digest_only", "verified", "created_at", "updated_at")
      .where({ id })
      .first();

    if (!subscription) {
      res.status(404).json({ error: "Subscription not found", statusCode: 404 });
      return;
    }

    res.json(subscription);
  } catch (err) {
    next(err);
  }
});

interface UpdateSubscriptionBody {
  email_enabled?: boolean;
  digest_only?: boolean;
}

router.patch("/:id", requireOperator, async (req: Request<{ id: string }, unknown, UpdateSubscriptionBody>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid subscription ID format");

    const { email_enabled, digest_only } = req.body;
    const updates: Record<string, unknown> = { updated_at: db.fn.now() };

    if (typeof email_enabled === "boolean") updates.email_enabled = email_enabled;
    if (typeof digest_only === "boolean") updates.digest_only = digest_only;

    if (Object.keys(updates).length === 1) throw badRequest("No valid fields to update");

    const [updated] = await db("alert_subscriptions")
      .where({ id })
      .update(updates)
      .returning(["id", "email", "jurisdiction_id", "email_enabled", "digest_only", "verified", "updated_at"]);

    if (!updated) {
      res.status(404).json({ error: "Subscription not found", statusCode: 404 });
      return;
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireOperator, async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid subscription ID format");

    const deleted = await db("alert_subscriptions").where({ id }).del();
    if (!deleted) {
      res.status(404).json({ error: "Subscription not found", statusCode: 404 });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;

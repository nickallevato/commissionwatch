import { Router, Request } from "express";
import db from "../config/database";
import { detectAnomalies, detectAnomaliesBatch } from "../services/anomaly-detection";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_FLAG_TYPES = [
  "emergency_session",
  "closed_door_vote",
  "last_minute_agenda_change",
  "quorum_issue",
  "unanimous_controversial",
  "missing_minutes",
];
const VALID_SEVERITIES = ["low", "medium", "high", "critical"];

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

interface AnomaliesQuery {
  meeting_id?: string;
  flag_type?: string;
  severity?: string;
  limit?: string;
  offset?: string;
}

router.get("/", async (req: Request<unknown, unknown, unknown, AnomaliesQuery>, res, next) => {
  try {
    const { meeting_id, flag_type, severity, limit: rawLimit, offset: rawOffset } = req.query;

    if (meeting_id && !UUID_RE.test(meeting_id))
      throw badRequest("Invalid meeting_id format");
    if (flag_type && !VALID_FLAG_TYPES.includes(flag_type))
      throw badRequest("Invalid flag_type");
    if (severity && !VALID_SEVERITIES.includes(severity))
      throw badRequest("Invalid severity");

    const limit = Math.min(Math.max(parseInt(rawLimit || "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(rawOffset || "0", 10) || 0, 0);

    const query = db("anomaly_flags");

    if (meeting_id) query.where({ meeting_id });
    if (flag_type) query.where({ flag_type });
    if (severity) query.where({ severity });

    const countResult = await query.clone().count("* as total").first();
    const total = Number(countResult?.total ?? 0);

    const data = await query
      .select("*")
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset);

    res.json({ data, total });
  } catch (err) {
    next(err);
  }
});

interface DetectBatchBody {
  commission_id?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.post("/detect-batch", async (req: Request<unknown, unknown, DetectBatchBody>, res, next) => {
  try {
    const { commission_id, date_from, date_to, limit } = req.body;

    if (commission_id && !UUID_RE.test(commission_id))
      throw badRequest("Invalid commission_id format");
    if (date_from && !DATE_RE.test(date_from))
      throw badRequest("Invalid date_from format (expected YYYY-MM-DD)");
    if (date_to && !DATE_RE.test(date_to))
      throw badRequest("Invalid date_to format (expected YYYY-MM-DD)");

    const result = await detectAnomaliesBatch(db, { commission_id, date_from, date_to, limit });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid anomaly flag ID format");

    const flag = await db("anomaly_flags").where({ id }).first();
    if (!flag) {
      res.status(404).json({ error: "Anomaly flag not found", statusCode: 404 });
      return;
    }

    res.json(flag);
  } catch (err) {
    next(err);
  }
});

interface CreateAnomalyBody {
  meeting_id?: string;
  flag_type?: string;
  description?: string;
  severity?: string;
  metadata?: Record<string, unknown> | null;
}

router.post("/", async (req: Request<unknown, unknown, CreateAnomalyBody>, res, next) => {
  try {
    const { meeting_id, flag_type, description, severity, metadata } = req.body;

    if (!meeting_id || !UUID_RE.test(meeting_id))
      throw badRequest("Valid meeting_id is required");
    if (!flag_type || !VALID_FLAG_TYPES.includes(flag_type))
      throw badRequest("Valid flag_type is required");
    if (!description || typeof description !== "string")
      throw badRequest("description is required");
    if (!severity || !VALID_SEVERITIES.includes(severity))
      throw badRequest("Valid severity is required");

    const meeting = await db("meetings").where({ id: meeting_id }).first();
    if (!meeting) throw badRequest("Meeting not found");

    const [created] = await db("anomaly_flags")
      .insert({
        meeting_id,
        flag_type,
        description,
        severity,
        source: "manual",
        metadata: metadata ? JSON.stringify(metadata) : null,
      })
      .returning("*");

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid anomaly flag ID format");

    const deleted = await db("anomaly_flags").where({ id }).del();
    if (!deleted) {
      res.status(404).json({ error: "Anomaly flag not found", statusCode: 404 });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.get("/meeting/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await db("meetings").where({ id }).first();
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const data = await db("anomaly_flags")
      .where({ meeting_id: id })
      .orderBy("created_at", "desc");

    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

router.post("/meeting/:id/detect", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await db("meetings").where({ id }).first();
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const flags = await detectAnomalies(db, id);

    res.json({ data: flags, total: flags.length });
  } catch (err) {
    next(err);
  }
});

export default router;

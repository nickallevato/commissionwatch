import { Router, Request } from "express";
import db from "../config/database";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

interface MeetingsQuery {
  jurisdiction_id?: string;
  commission_id?: string;
  date_from?: string;
  date_to?: string;
  status?: string;
  limit?: string;
  offset?: string;
}

router.get("/", async (req: Request<unknown, unknown, unknown, MeetingsQuery>, res, next) => {
  try {
    const {
      jurisdiction_id,
      commission_id,
      date_from,
      date_to,
      status,
      limit: rawLimit,
      offset: rawOffset,
    } = req.query;

    if (jurisdiction_id && !UUID_RE.test(jurisdiction_id))
      throw badRequest("Invalid jurisdiction_id format");
    if (commission_id && !UUID_RE.test(commission_id))
      throw badRequest("Invalid commission_id format");
    if (date_from && !DATE_RE.test(date_from))
      throw badRequest("Invalid date_from format (expected YYYY-MM-DD)");
    if (date_to && !DATE_RE.test(date_to))
      throw badRequest("Invalid date_to format (expected YYYY-MM-DD)");

    const limit = Math.min(Math.max(parseInt(rawLimit || "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(rawOffset || "0", 10) || 0, 0);

    const query = db("meetings");

    if (jurisdiction_id) {
      query.whereIn(
        "commission_id",
        db("commissions").select("id").where({ jurisdiction_id }),
      );
    }
    if (commission_id) query.where({ commission_id });
    if (date_from) query.where("date", ">=", date_from);
    if (date_to) query.where("date", "<=", date_to);
    if (status) query.where({ status });

    const countResult = await query.clone().count("* as total").first();
    const total = Number(countResult?.total ?? 0);

    const data = await query
      .select("*")
      .orderBy("date", "desc")
      .limit(limit)
      .offset(offset);

    res.json({ data, total });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await db("meetings").where({ id }).first();
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const [agendaItems, documents] = await Promise.all([
      db("agenda_items").where({ meeting_id: id }).orderBy("sort_order"),
      db("documents").where({ meeting_id: id }).orderBy("created_at"),
    ]);

    res.json({ ...meeting, agenda_items: agendaItems, documents });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/rundown", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await db("meetings").where({ id }).first();
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const rundown = await db("rundowns").where({ meeting_id: id }).first();
    if (!rundown) {
      res.status(404).json({
        error: "Rundown not yet generated for this meeting",
        statusCode: 404,
      });
      return;
    }

    res.json(rundown);
  } catch (err) {
    next(err);
  }
});

export default router;

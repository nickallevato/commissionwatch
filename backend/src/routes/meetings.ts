import { Router, Request } from "express";
import db from "../config/database";
import { loadDocumentTimelines } from "../services/agenda-diff";
import { detectAnomalies } from "../services/anomaly-detection";
import {
  findPublishedMeeting,
  whereFindingPublic,
  whereMeetingPublished,
} from "../services/publication";

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

    // Ingested is not published. An unpublished meeting is absent from every
    // public response, including the count — a total that includes rows the
    // caller cannot reach is a leak dressed as a number.
    const query = whereMeetingPublished(db("meetings"));

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

    const meeting = await findPublishedMeeting(db, id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const [agendaItems, documents] = await Promise.all([
      db("agenda_items").where({ meeting_id: id }).orderBy("item_number"),
      db("meeting_documents").where({ meeting_id: id }).orderBy("created_at"),
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

    const meeting = await findPublishedMeeting(db, id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const rundown = await db("rundown_sheets").where({ meeting_id: id }).first();
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

router.post("/:id/detect-anomalies", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await findPublishedMeeting(db, id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const flags = await detectAnomalies(db, id);
    res.json({ data: flags, count: flags.length });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/votes", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await findPublishedMeeting(db, id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const votes = await db("votes").where({ meeting_id: id }).orderBy("created_at");
    res.json({ data: votes, total: votes.length });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/anomalies", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await findPublishedMeeting(db, id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const anomalies = await whereFindingPublic(db, db("anomaly_flags"))
      .where("anomaly_flags.meeting_id", id)
      .select("anomaly_flags.*")
      .orderBy("anomaly_flags.created_at");
    res.json({ data: anomalies, total: anomalies.length });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/agenda-items", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await findPublishedMeeting(db, id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const agendaItems = await db("agenda_items")
      .where({ meeting_id: id })
      .orderBy("item_number", "asc");
    res.json({ data: agendaItems, total: agendaItems.length });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/documents", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await findPublishedMeeting(db, id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const documents = await db("meeting_documents")
      .where({ meeting_id: id })
      .orderBy("created_at", "desc");
    res.json({ data: documents, total: documents.length });
  } catch (err) {
    next(err);
  }
});

/**
 * P5 — what changed in this meeting's documents, and when.
 *
 * One timeline per document: every version, and a diff of the extracted agenda
 * items between each consecutive pair. Most documents have exactly one version
 * and return an empty `diffs` array, which is a complete answer and not an
 * error.
 *
 * Behind `findPublishedMeeting` like every other public meeting route. A diff
 * is the most quotable thing this project produces, so an unpublished meeting
 * leaking one would be the review wall failing at precisely the place it
 * matters most — `meeting-publication.test.ts` walks this path with the rest.
 */
router.get("/:id/agenda-diff", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid meeting ID format");

    const meeting = await findPublishedMeeting(db, id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }

    const timelines = await loadDocumentTimelines(db, id);
    res.json({ data: timelines, total: timelines.length });
  } catch (err) {
    next(err);
  }
});

export default router;

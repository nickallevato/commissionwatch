import { Router, Request } from "express";
import db from "../config/database";
import { requireOperator } from "../middleware/requireOperator";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_VOTES = ["yes", "no", "abstain", "absent"];

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

interface VotesQuery {
  meeting_id?: string;
  agenda_item_id?: string;
  member_id?: string;
  limit?: string;
  offset?: string;
}

router.get("/", async (req: Request<unknown, unknown, unknown, VotesQuery>, res, next) => {
  try {
    const { meeting_id, agenda_item_id, member_id, limit: rawLimit, offset: rawOffset } = req.query;

    if (meeting_id && !UUID_RE.test(meeting_id))
      throw badRequest("Invalid meeting_id format");
    if (agenda_item_id && !UUID_RE.test(agenda_item_id))
      throw badRequest("Invalid agenda_item_id format");
    if (member_id && !UUID_RE.test(member_id))
      throw badRequest("Invalid member_id format");

    const limit = Math.min(Math.max(parseInt(rawLimit || "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(rawOffset || "0", 10) || 0, 0);

    const query = db("votes");

    if (meeting_id) query.where({ meeting_id });
    if (agenda_item_id) query.where({ agenda_item_id });
    if (member_id) query.where({ member_id });

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

// A vote row is this project's core published claim about how a named official
// acted. Writing one is an operator act.
router.post("/", requireOperator, async (req, res, next) => {
  try {
    const { meeting_id, agenda_item_id, member_id, vote } = req.body;

    if (!meeting_id || !UUID_RE.test(meeting_id))
      throw badRequest("Valid meeting_id is required");
    if (!member_id || !UUID_RE.test(member_id))
      throw badRequest("Valid member_id is required");
    if (agenda_item_id && !UUID_RE.test(agenda_item_id))
      throw badRequest("Invalid agenda_item_id format");
    if (!vote || !VALID_VOTES.includes(vote))
      throw badRequest("vote must be one of: yes, no, abstain, absent");

    const [created] = await db("votes")
      .insert({ meeting_id, agenda_item_id: agenda_item_id || null, member_id, vote })
      .returning("*");

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.post("/bulk", requireOperator, async (req, res, next) => {
  try {
    const { votes } = req.body;

    if (!Array.isArray(votes) || votes.length === 0)
      throw badRequest("votes must be a non-empty array");

    for (const v of votes) {
      if (!v.meeting_id || !UUID_RE.test(v.meeting_id))
        throw badRequest("Each vote must have a valid meeting_id");
      if (!v.member_id || !UUID_RE.test(v.member_id))
        throw badRequest("Each vote must have a valid member_id");
      if (v.agenda_item_id && !UUID_RE.test(v.agenda_item_id))
        throw badRequest("Invalid agenda_item_id format in vote");
      if (!v.vote || !VALID_VOTES.includes(v.vote))
        throw badRequest("Each vote must have a valid vote value (yes/no/abstain/absent)");
    }

    const rows = votes.map((v: { meeting_id: string; agenda_item_id?: string; member_id: string; vote: string }) => ({
      meeting_id: v.meeting_id,
      agenda_item_id: v.agenda_item_id || null,
      member_id: v.member_id,
      vote: v.vote,
    }));

    const created = await db("votes").insert(rows).returning("*");

    res.status(201).json({ data: created, total: created.length });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireOperator, async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid vote ID format");

    const deleted = await db("votes").where({ id }).del();
    if (!deleted) {
      res.status(404).json({ error: "Vote not found", statusCode: 404 });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;

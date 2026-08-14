import { Router, Request } from "express";
import db from "../config/database";
import { requireOperator } from "../middleware/requireOperator";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

interface MembersQuery {
  jurisdiction_id?: string;
  limit?: string;
  offset?: string;
}

router.get("/", async (req: Request<unknown, unknown, unknown, MembersQuery>, res, next) => {
  try {
    const { jurisdiction_id, limit: rawLimit, offset: rawOffset } = req.query;

    if (jurisdiction_id && !UUID_RE.test(jurisdiction_id))
      throw badRequest("Invalid jurisdiction_id format");

    const limit = Math.min(Math.max(parseInt(rawLimit || "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(rawOffset || "0", 10) || 0, 0);

    const query = db("members");

    if (jurisdiction_id) query.where({ jurisdiction_id });

    const countResult = await query.clone().count("* as total").first();
    const total = Number(countResult?.total ?? 0);

    const data = await query
      .select("*")
      .orderBy("name", "asc")
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
    if (!UUID_RE.test(id)) throw badRequest("Invalid member ID format");

    const member = await db("members").where({ id }).first();
    if (!member) {
      res.status(404).json({ error: "Member not found", statusCode: 404 });
      return;
    }

    res.json(member);
  } catch (err) {
    next(err);
  }
});

// The roster is the record `/officials/:id` computes its arithmetic from, and
// a member row is a named living person. Writing one is an operator act.
router.post("/", requireOperator, async (req, res, next) => {
  try {
    const { jurisdiction_id, name, title, term_start, term_end, email, party } = req.body;

    if (!jurisdiction_id || !UUID_RE.test(jurisdiction_id))
      throw badRequest("Valid jurisdiction_id is required");
    if (!name || typeof name !== "string")
      throw badRequest("name is required");
    if (!term_start)
      throw badRequest("term_start is required");

    const [member] = await db("members")
      .insert({ jurisdiction_id, name, title, term_start, term_end, email, party })
      .returning("*");

    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireOperator, async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid member ID format");

    const { jurisdiction_id, name, title, term_start, term_end, email, party } = req.body;

    if (jurisdiction_id && !UUID_RE.test(jurisdiction_id))
      throw badRequest("Invalid jurisdiction_id format");

    const [updated] = await db("members")
      .where({ id })
      .update({
        ...(jurisdiction_id && { jurisdiction_id }),
        ...(name && { name }),
        ...(title !== undefined && { title }),
        ...(term_start && { term_start }),
        ...(term_end !== undefined && { term_end }),
        ...(email !== undefined && { email }),
        ...(party !== undefined && { party }),
        updated_at: db.fn.now(),
      })
      .returning("*");

    if (!updated) {
      res.status(404).json({ error: "Member not found", statusCode: 404 });
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
    if (!UUID_RE.test(id)) throw badRequest("Invalid member ID format");

    const deleted = await db("members").where({ id }).del();
    if (!deleted) {
      res.status(404).json({ error: "Member not found", statusCode: 404 });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;

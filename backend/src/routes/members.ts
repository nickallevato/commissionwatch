import { Router, Request } from "express";
import db from "../config/database";

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
      .orderBy("name")
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

interface CreateMemberBody {
  name: string;
  title?: string;
  jurisdiction_id: string;
  term_start?: string;
  term_end?: string;
}

router.post("/", async (req: Request<unknown, unknown, CreateMemberBody>, res, next) => {
  try {
    const { name, title, jurisdiction_id, term_start, term_end } = req.body;

    if (!name || typeof name !== "string")
      throw badRequest("name is required");
    if (!jurisdiction_id || !UUID_RE.test(jurisdiction_id))
      throw badRequest("Valid jurisdiction_id is required");

    const jurisdiction = await db("jurisdictions").where({ id: jurisdiction_id }).first();
    if (!jurisdiction) throw badRequest("Jurisdiction not found");

    const [member] = await db("members")
      .insert({ name, title, jurisdiction_id, term_start, term_end })
      .returning("*");

    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid member ID format");

    const { name, title, jurisdiction_id, term_start, term_end } = req.body;

    if (jurisdiction_id && !UUID_RE.test(jurisdiction_id))
      throw badRequest("Invalid jurisdiction_id format");

    if (jurisdiction_id) {
      const jurisdiction = await db("jurisdictions").where({ id: jurisdiction_id }).first();
      if (!jurisdiction) throw badRequest("Jurisdiction not found");
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (title !== undefined) updates.title = title;
    if (jurisdiction_id !== undefined) updates.jurisdiction_id = jurisdiction_id;
    if (term_start !== undefined) updates.term_start = term_start;
    if (term_end !== undefined) updates.term_end = term_end;

    if (Object.keys(updates).length === 0)
      throw badRequest("No fields to update");

    const [member] = await db("members")
      .where({ id })
      .update({ ...updates, updated_at: db.fn.now() })
      .returning("*");

    if (!member) {
      res.status(404).json({ error: "Member not found", statusCode: 404 });
      return;
    }

    res.json(member);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
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

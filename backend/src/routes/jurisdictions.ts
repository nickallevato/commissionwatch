import { Router } from "express";
import db from "../config/database";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const jurisdictions = await db("jurisdictions")
      .select("jurisdictions.*")
      .orderBy("jurisdictions.name");

    const jurisdictionIds = jurisdictions.map((j) => j.id);

    const commissions =
      jurisdictionIds.length > 0
        ? await db("commissions")
            .whereIn("jurisdiction_id", jurisdictionIds)
            .orderBy("name")
        : [];

    const commissionsByJurisdiction = new Map<string, typeof commissions>();
    for (const c of commissions) {
      const list = commissionsByJurisdiction.get(c.jurisdiction_id) || [];
      list.push(c);
      commissionsByJurisdiction.set(c.jurisdiction_id, list);
    }

    const data = jurisdictions.map((j) => ({
      ...j,
      commissions: commissionsByJurisdiction.get(j.id) || [],
    }));

    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

export default router;

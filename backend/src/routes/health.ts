import { Router } from "express";
import db from "../config/database";

const router = Router();

router.get("/", async (_req, res) => {
  let database: "connected" | "disconnected" = "disconnected";
  try {
    await db.raw("SELECT 1");
    database = "connected";
  } catch {
    // db unreachable
  }
  res.json({ status: "ok", database, timestamp: new Date().toISOString() });
});

export default router;

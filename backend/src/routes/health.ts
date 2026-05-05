import { Router } from "express";
import db from "../config/database";

interface DigestStatus {
  dailyLastRun: Date | null;
  weeklyLastRun: Date | null;
  running: boolean;
}

let digestStatusFn: (() => DigestStatus) | null = null;

export function registerDigestStatus(fn: () => DigestStatus): void {
  digestStatusFn = fn;
}

const router = Router();

router.get("/", async (_req, res) => {
  let database: "connected" | "disconnected" = "disconnected";
  try {
    await db.raw("SELECT 1");
    database = "connected";
  } catch {
    // db unreachable
  }

  const digest = digestStatusFn
    ? digestStatusFn()
    : { dailyLastRun: null, weeklyLastRun: null, running: false };

  res.json({
    status: "ok",
    database,
    digest: {
      running: digest.running,
      dailyLastRun: digest.dailyLastRun?.toISOString() ?? null,
      weeklyLastRun: digest.weeklyLastRun?.toISOString() ?? null,
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;

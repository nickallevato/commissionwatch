import { Router } from "express";

// Baked into the image at build time by backend/Dockerfile (ARG BUILD_SHA).
//
// Read once at module load, not per request: these describe the running image
// and cannot change while the process lives. Reading them per request would
// invite someone to "fix" a stale version by setting an env var on a container
// that is still running the old code.
//
// "unknown" is deliberate rather than a plausible default. The deploy compares
// these strings across the two images, so a missing value must be visibly
// missing — a fabricated-looking SHA would make a skewed deploy look healthy,
// which is the exact failure this endpoint exists to catch.
const SHA = process.env.BUILD_SHA || "unknown";
const BUILT_AT = process.env.BUILD_TIME || "unknown";

const router = Router();

router.get("/", (_req, res) => {
  res.json({ service: "backend", sha: SHA, builtAt: BUILT_AT });
});

export default router;

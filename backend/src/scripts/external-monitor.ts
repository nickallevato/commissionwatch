/**
 * The external monitor: uptime, deploy skew and ingestion staleness, judged
 * from outside the application.
 *
 * ## Why this is not in the app
 *
 * On 2026-08-09 production returned 502 on every `/api/*` route for about four
 * hours and the only reason anyone found out was a person opening the site.
 * Every account this codebase gives of its own health — the masthead's sweep
 * clock, `/admin/sources`, `/status` — is served *by the process that was
 * down*. A watch that lives inside the process can only report while the
 * process is alive, which is precisely when it has nothing to report.
 *
 * So this runs on a schedule in CI, decides for itself, and exits non-zero. A
 * red scheduled run persists in Gitea's run list until somebody deals with it.
 * A warning in a green run's log is gone as soon as it scrolls.
 *
 * ## Why it is one file with no imports
 *
 * Node 22 strips TypeScript types natively, so `node external-monitor.ts` runs
 * with no install, no build and no lockfile. That is the point: a monitor whose
 * green run depends on the npm registry being reachable is a monitor that goes
 * red for reasons that have nothing to do with the site. Keeping the module
 * free of local imports is what keeps that true — a single `import "./x"` would
 * buy back the whole build step.
 *
 * The evaluation is exported as pure functions and tested in
 * `test/external-monitor.test.ts` against fixtures. Deciding what counts as
 * healthy inside a shell `if` is how you get a monitor that reports success
 * while the site is down.
 *
 * `main()` runs only when `--run` appears on the argv, so importing this module
 * probes nothing.
 *
 * Plan: `docs/superpowers/plans/2026-08-10-external-monitoring.md`.
 */

/** Where the probes point unless `MONITOR_BASE_URL` says otherwise. */
export const DEFAULT_BASE_URL = "https://commissionwatch.bmux.sh";

/**
 * Honest, names the project, and reachable — the same discipline the scrapers
 * follow under `.claude/skills/commissionwatch-development/SKILL.md`, pointed
 * at our own site. A monitor that lies about who it is has no standing to
 * report on anyone's record-keeping.
 */
export const MONITOR_USER_AGENT =
  "CommissionWatchMonitor/1.0 (+https://commissionwatch.bmux.sh; uptime probe; admin@bmux.sh)";

/** Per-request ceiling. Four requests a run, four times an hour. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** The pause before the single retry. Long enough to cross a container restart. */
export const RETRY_DELAY_MS = 5_000;

/**
 * How many times a mismatch is re-read before it is believed.
 *
 * Used by both checks that can be caught mid-swap: the release-drift check and
 * the version-skew check. One mechanism, one pair of environment variables, one
 * set of guarantees — a second settle written separately would be a second set
 * of rules about when an absence may become a claim.
 *
 * **The race this closes.** `deploy.yml` runs the drift check with
 * `MONITOR_MAX_DRIFT_MINUTES: "0"`, so any mismatch is an immediate FAIL and the
 * step's status fails the deploy job. The step immediately before it polls
 * `/api/health` up to six times and **exits on the first 200** — and that 200
 * can be answered by the *old* container while the compose swap is still
 * finishing. A perfectly good deploy could therefore read a stale sha once and
 * turn the pipeline red.
 *
 * Raising the allowance cannot fix it: drift age is measured from the *commit*
 * time, which is already ~12 minutes old by the time `deploy-aws` finishes (the
 * three green pipelines behind `DEFAULT_MAX_DRIFT_MINUTES`), so every threshold
 * below that still fails an in-flight swap, and every threshold above it stops
 * failing a release that never landed. The fix has to be a bounded re-read.
 *
 * **Why three at ten seconds.** `deploy/deploy-aws-ssm.sh` gives the containers
 * their own settle window on the host — ten polls of `/version.json` and
 * `/api/version` three seconds apart, thirty seconds in total — and only exits 0
 * once both answer and both equal `EXPECT_SHA`. Thirty seconds is therefore the
 * host's own measured allowance for a swap becoming visible, and this matches it
 * from outside the box, where Caddy's upstream connection reuse adds the last
 * few seconds. Ten-second spacing is the same cadence as the health poll in
 * `deploy.yml` that precedes it.
 *
 * **Why it stays cheap.** Nothing is re-read on a match, so the ordinary
 * periodic run costs exactly what it did before. The cost is paid only when a
 * check already disagrees — which is a deploy in flight, or a real fault, and
 * both are worth thirty seconds. A run that is mid-swap can pay it twice, once
 * per check, and a minute spent not turning a good deploy red is a minute well
 * spent.
 */
export const DEFAULT_SETTLE_ATTEMPTS = 3;

/** The pause between settle re-reads. See `DEFAULT_SETTLE_ATTEMPTS`. */
export const DEFAULT_SETTLE_DELAY_MS = 10_000;

/** Discord refuses a message body longer than this. */
export const DISCORD_CONTENT_LIMIT = 2000;

/* ── Types ──────────────────────────────────────────────────────────── */

/**
 * One HTTP attempt's outcome, as the evaluators see it.
 *
 * `status === null` means the request never produced a response — DNS, TLS,
 * connection refused, or the timeout. That is a different fact from a 502 and
 * the report says so rather than flattening both into "down".
 */
export interface ProbeResult {
  url: string;
  status: number | null;
  body: string;
  error: string | null;
  attempts: number;
  /**
   * Response header names lower-cased, values as sent. Empty when the
   * request never produced a response. Added for the `prerender` check,
   * which has to read `Vary` — every earlier check only ever needed the
   * body, so this stayed absent until one did.
   */
  headers: Record<string, string>;
}

/**
 * `blocked` is not `pass`.
 *
 * A check that could not determine its answer — because the thing it needed to
 * read was unreadable, or because the operator never told it what to expect —
 * says so in its own word. Collapsing that into `pass` is the error pattern
 * this project keeps finding in other people's systems: an unreadable source
 * rendering as a confident claim. Collapsing it into `fail` is nearly as bad,
 * because then "we cannot see" and "we looked, and it is wrong" wake somebody
 * up with the same sentence.
 *
 * Like `warn`, it does not fail the run — the same convention
 * `deploy/monitor-trigger.sh` already follows when the run list will not load.
 */
export type CheckState = "pass" | "warn" | "blocked" | "fail";

/** One judgement, in the words that will be read by whoever is woken up. */
export interface CheckOutcome {
  name: string;
  state: CheckState;
  detail: string;
}

/** How long a check is allowed to keep looking before it believes a mismatch. */
export interface SettlePolicy {
  attempts: number;
  delayMs: number;
}

/** The settle configuration, or the reason it could not be read. */
export type SettlePolicyResult = { ok: true; policy: SettlePolicy } | { ok: false; reason: string };

/* ── Small typed helpers ────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a body as a JSON object, or say why it is not one.
 *
 * A malformed response is its own failure, distinct from a bad status: Caddy
 * answering an HTML error page with 200, or a proxy returning an empty body,
 * must never read as a healthy JSON payload that merely lacks the field we
 * wanted.
 */
export function parseJsonObject(body: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, reason: "response body is not JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "response body is not a JSON object" };
  return { ok: true, value: parsed };
}

/** A one-line description of a transport or status failure, or null if the response is usable. */
function transportFailure(probe: ProbeResult): string | null {
  if (probe.status === null) {
    return `no response after ${probe.attempts} attempt(s): ${probe.error ?? "unknown transport error"}`;
  }
  if (probe.status !== 200) {
    // 403 is worth naming: the live site is gated at the Caddy layer to a
    // single address, so a monitor that suddenly cannot see the site at all is
    // more likely to have lost its place on the allowlist than to be watching
    // an outage. Saying so beats an operator rediscovering it each time.
    const gate =
      probe.status === 403
        ? " (403 — likely the Caddy IP allowlist rather than the application)"
        : "";
    return `HTTP ${probe.status}${gate}`;
  }
  return null;
}

/* ── Probe 1: health ────────────────────────────────────────────────── */

/**
 * 200, JSON, and `database: connected`.
 *
 * A backend that answers while its database does not is a specific, nameable
 * state, and it is not health. `/api/health` reports it honestly; nothing was
 * reading the report.
 */
export function evaluateHealth(probe: ProbeResult): CheckOutcome {
  const failure = transportFailure(probe);
  if (failure !== null) return { name: "health", state: "fail", detail: failure };

  const parsed = parseJsonObject(probe.body);
  if (!parsed.ok) return { name: "health", state: "fail", detail: parsed.reason };

  const database = parsed.value.database;
  if (typeof database !== "string") {
    return { name: "health", state: "fail", detail: "response has no `database` string" };
  }
  if (database !== "connected") {
    return { name: "health", state: "fail", detail: `database is ${database}, not connected` };
  }

  const status = parsed.value.status;
  if (typeof status === "string" && status !== "ok") {
    return { name: "health", state: "fail", detail: `status is ${status}, not ok` };
  }

  return { name: "health", state: "pass", detail: "200, database connected" };
}

/* ── Probe 2: version skew ──────────────────────────────────────────── */

function readSha(probe: ProbeResult, label: string): { ok: true; sha: string } | { ok: false; detail: string } {
  const failure = transportFailure(probe);
  if (failure !== null) return { ok: false, detail: `${label}: ${failure}` };

  const parsed = parseJsonObject(probe.body);
  if (!parsed.ok) return { ok: false, detail: `${label}: ${parsed.reason}` };

  const sha = parsed.value.sha;
  if (typeof sha !== "string" || sha.trim() === "") {
    return { ok: false, detail: `${label}: response has no \`sha\` string` };
  }
  // "unknown" is what an unstamped image serves, and it is deliberate — see
  // routes/version.ts. Two unstamped images are not a verified deploy; they are
  // two absences that happen to be equal, so they must not compare as matching.
  if (sha === "unknown") {
    return { ok: false, detail: `${label}: sha is "unknown" — the image carries no build stamp` };
  }
  return { ok: true, sha: sha.trim() };
}

/**
 * The two images must be serving the same commit.
 *
 * They roll independently, so a stack running yesterday's API behind today's UI
 * is healthy by every other measure and invisible from the outside. That is the
 * exact shape of the 2026-08-09 outage: a half-finished rollout.
 *
 * This judges **one reading**. Because the images roll independently, one reading
 * is also what a probe landing mid-swap gets, so `main()` calls
 * `resolveVersionSkew` — which is this, given a bounded chance to settle before a
 * mismatch is believed.
 */
export function evaluateVersion(api: ProbeResult, web: ProbeResult): CheckOutcome {
  const apiSha = readSha(api, "/api/version");
  const webSha = readSha(web, "/version.json");

  const problems: string[] = [];
  if (!apiSha.ok) problems.push(apiSha.detail);
  if (!webSha.ok) problems.push(webSha.detail);
  if (!apiSha.ok || !webSha.ok) {
    return { name: "version", state: "fail", detail: problems.join("; ") };
  }

  if (apiSha.sha !== webSha.sha) {
    return {
      name: "version",
      state: "fail",
      detail: `version skew: api ${short(apiSha.sha)} vs web ${short(webSha.sha)} — a half-finished rollout`,
    };
  }
  return { name: "version", state: "pass", detail: `both images serve ${short(apiSha.sha)}` };
}

function short(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/* ── Probe 3: release drift ─────────────────────────────────────────── */

/**
 * Default allowance between a commit existing and that commit being live.
 *
 * Measured, not guessed. Three consecutive green pipelines on 2026-08-15 (runs
 * 28767, 28778, 28992) took 11.3, 11.7 and 12.5 minutes from the first check
 * job starting to `deploy-aws` finishing — the arm64 buildx step alone is
 * 7–8 minutes of that. Thirty minutes is roughly 2.4× the slowest observed
 * end-to-end run, which leaves room for a queued runner and a retried push
 * without firing on a deploy that is merely in progress.
 *
 * That headroom is the whole point: a check that goes red on every push is a
 * check people mute, and a muted check is how the 2026-08-14 disk-full incident
 * ran two failed deploys against a green site with nobody noticing.
 *
 * Thirty minutes is also comfortably inside what a real drift looks like. On
 * 2026-08-15 production served `72c10b0` for about four hours while the head of
 * main moved several commits ahead, and `monitor.yml` reported success on every
 * fifteen-minute tick through the whole window — a green signal an operator
 * would reasonably point at to conclude everything was fine. Any allowance from
 * a few minutes to a couple of hours would have caught that; thirty is chosen
 * to be far enough above a normal build to be quiet and far enough below a
 * genuine stall to be useful. `MONITOR_MAX_DRIFT_MINUTES` overrides it —
 * `deploy.yml` sets `0`, because by the time that pipeline probes, the build
 * time has already elapsed.
 */
export const DEFAULT_MAX_DRIFT_MINUTES = 30;

/** Where the expected head comes from, once the environment has been read. */
export type ReleaseExpectation =
  | {
      ok: true;
      sha: string;
      committedAt: string | null;
      maxDriftMinutes: number;
      settleAttempts: number;
      settleDelayMs: number;
    }
  | { ok: false; reason: string };

/** A full or abbreviated commit sha, and nothing else. */
function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

/**
 * Read the expected head from the environment.
 *
 * **`MONITOR_EXPECTED_SHA` is supplied by whatever drives the monitor**, which
 * in practice is the Gitea Actions runner passing `${{ github.sha }}` — the
 * commit the workflow itself was dispatched at, so on a `main` dispatch it is
 * the head of `origin/main`. It deliberately does not come from:
 *
 * - **a `git` invocation here.** The evaluation runs inside a stock `node:22`
 *   container with the workspace mounted; git is not guaranteed in it, and a
 *   check whose answer depends on a binary that may be absent degrades quietly.
 * - **the Gitea API.** That would need a token, a network path to Gitea, and an
 *   npm-free HTTP client — three new ways for the monitor to go red for reasons
 *   that have nothing to do with the site.
 * - **anything the deployed site itself serves.** That is the degradation that
 *   matters: an "expected" sha sourced from `/api/version`, or from a
 *   `BUILD_SHA` inherited by this process, would compare a value against itself
 *   and pass forever. The expected head must come from the source of truth for
 *   what *should* be deployed, never from the thing being judged.
 *
 * Missing or malformed input is a `blocked` check, never a default. There is no
 * safe fallback value for "what should be live".
 */
export function readReleaseExpectation(env: Record<string, string | undefined>): ReleaseExpectation {
  const rawSha = (env.MONITOR_EXPECTED_SHA ?? "").trim();
  if (rawSha === "") {
    return {
      ok: false,
      reason:
        "MONITOR_EXPECTED_SHA is not set, so there is nothing to compare the live sha against — this check did not run",
    };
  }
  if (!isCommitSha(rawSha)) {
    return { ok: false, reason: `MONITOR_EXPECTED_SHA is not a commit sha: ${JSON.stringify(rawSha)}` };
  }

  const maxDriftMinutes = readNonNegative(env.MONITOR_MAX_DRIFT_MINUTES, "MONITOR_MAX_DRIFT_MINUTES", DEFAULT_MAX_DRIFT_MINUTES);
  if (!maxDriftMinutes.ok) return { ok: false, reason: maxDriftMinutes.reason };

  const settle = readSettlePolicy(env);
  if (!settle.ok) return { ok: false, reason: settle.reason };

  const rawCommittedAt = (env.MONITOR_EXPECTED_SHA_TIME ?? "").trim();
  return {
    ok: true,
    sha: rawSha,
    committedAt: rawCommittedAt === "" ? null : rawCommittedAt,
    maxDriftMinutes: maxDriftMinutes.value,
    settleAttempts: settle.policy.attempts,
    settleDelayMs: settle.policy.delayMs,
  };
}

/**
 * The settle configuration, read once and shared by every check that settles.
 *
 * Separate from `readReleaseExpectation` because the version-skew check settles
 * too and has no expected head to be blocked on: how long to keep looking is a
 * property of the deploy, not of the drift check. Read here so both checks
 * cannot disagree about it.
 *
 * Garbage is a reason, never a silent fall back to the default — a threshold
 * nobody set being reported as one somebody did is the same defect wherever it
 * appears.
 */
export function readSettlePolicy(env: Record<string, string | undefined>): SettlePolicyResult {
  const attempts = readNonNegative(env.MONITOR_SETTLE_ATTEMPTS, "MONITOR_SETTLE_ATTEMPTS", DEFAULT_SETTLE_ATTEMPTS);
  if (!attempts.ok) return { ok: false, reason: attempts.reason };

  const delayMs = readNonNegative(env.MONITOR_SETTLE_DELAY_MS, "MONITOR_SETTLE_DELAY_MS", DEFAULT_SETTLE_DELAY_MS);
  if (!delayMs.ok) return { ok: false, reason: delayMs.reason };

  return { ok: true, policy: { attempts: Math.floor(attempts.value), delayMs: delayMs.value } };
}

/**
 * A non-negative numeric setting, or the reason it is not one.
 *
 * A garbage value silently falling back to the default is a threshold nobody set
 * being reported as one somebody did — so it is `blocked`, exactly like a
 * missing expected head.
 */
function readNonNegative(
  raw: string | undefined,
  name: string,
  fallback: number,
): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { ok: true, value: fallback };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, reason: `${name} is not a non-negative number: ${JSON.stringify(trimmed)}` };
  }
  return { ok: true, value: parsed };
}

/**
 * True when two shas name the same commit, allowing one to be an abbreviation.
 *
 * The image is stamped with the full sha by `deploy.yml`, but an operator
 * running this by hand may well pass a short one, and `isCommitSha` already
 * refuses anything shorter than seven characters — the length below which
 * abbreviations start colliding in a repository this size.
 */
function shaMatches(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return longer.startsWith(shorter);
}

/**
 * Is the commit that should be live actually live, and if not, for how long?
 *
 * **The finding this exists for:** on 2026-08-14 the deploy host filled its
 * disk. `deploy-aws` failed twice, every check job stayed green, and production
 * went on serving the previous good sha and answering `/api/health` 200 —
 * because the image pull failed before any container was replaced, which is the
 * pipeline behaving correctly. Nothing alerted, because everything that was
 * watching asked whether the site was *up*. It was. The release had simply
 * stopped landing, and the first symptom was a human noticing.
 *
 * A green check suite plus a healthy site does not mean the release deployed.
 * This is the check that says so, and it needs no AWS credentials and no host
 * access — which is why it is the one that can exist.
 *
 * The four verdicts, and what each refuses to claim:
 *
 * - **`pass`** — the live sha is the expected head. The only case where the
 *   answer is "the release landed".
 * - **`warn`** — they differ, but the expected head is younger than the
 *   allowance. Drift is *normal* for the minutes between a push and a finished
 *   arm64 build. This is reported and does not fail the run.
 * - **`fail`** — they differ and the expected head has been waiting longer than
 *   the allowance. The release stopped landing. Both shas are in the message,
 *   because the first question anyone asks is which commit is actually serving.
 * - **`blocked`** — the comparison could not be made: no expected head was
 *   supplied, or `/api/version` could not be read, or it returned no usable
 *   sha, or its age cannot be computed. These are **not** the same event as
 *   drift and are never reported as one. An unreadable version endpoint already
 *   fails the `version` check on its own; having this check also shout "drift"
 *   about it would be inventing a fact from an absence.
 */
export function evaluateReleaseDrift(
  expectation: ReleaseExpectation,
  api: ProbeResult,
  now: Date,
): CheckOutcome {
  const name = "release-drift";

  if (!expectation.ok) {
    return { name, state: "blocked", detail: `${expectation.reason}. Not a pass` };
  }

  const live = readSha(api, "/api/version");
  if (!live.ok) {
    return {
      name,
      state: "blocked",
      detail:
        `the live sha could not be read, so drift is unknown — not a pass. ` +
        `${live.detail}. Expected head ${short(expectation.sha)} (${expectation.sha})`,
    };
  }

  if (shaMatches(live.sha, expectation.sha)) {
    return {
      name,
      state: "pass",
      detail: `live sha ${short(live.sha)} is the expected head ${short(expectation.sha)} (${expectation.sha})`,
    };
  }

  const both =
    `live ${short(live.sha)} (${live.sha}) ` +
    `vs expected head ${short(expectation.sha)} (${expectation.sha})`;

  if (expectation.committedAt === null) {
    return {
      name,
      state: "blocked",
      detail:
        `the live sha is not the expected head — ${both} — but MONITOR_EXPECTED_SHA_TIME is not set, ` +
        `so whether this is a deploy in flight or a release that stopped landing cannot be told. Not a pass`,
    };
  }

  const committedAt = new Date(expectation.committedAt);
  if (Number.isNaN(committedAt.getTime())) {
    return {
      name,
      state: "blocked",
      detail:
        `the live sha is not the expected head — ${both} — but MONITOR_EXPECTED_SHA_TIME is not a date: ` +
        `${JSON.stringify(expectation.committedAt)}, so the age of the drift cannot be computed. Not a pass`,
    };
  }

  const minutes = Math.round(((now.getTime() - committedAt.getTime()) / 60_000) * 10) / 10;
  if (minutes > expectation.maxDriftMinutes) {
    return {
      name,
      state: "fail",
      detail:
        `the release has not landed: ${both}. The expected head was committed ${minutes} min ago, ` +
        `past the ${expectation.maxDriftMinutes}-min allowance. The site can be healthy and still be ` +
        `serving an old commit — check the deploy job, not the site`,
    };
  }

  return {
    name,
    state: "warn",
    detail:
      `${both}, committed ${minutes} min ago — within the ${expectation.maxDriftMinutes}-min allowance, ` +
      `so a deploy is probably still in flight`,
  };
}

/**
 * The same judgement, given a bounded chance to settle.
 *
 * `evaluateReleaseDrift` answers from one reading. One reading is not enough
 * immediately after a deploy: `deploy.yml`'s health poll exits on the first 200,
 * and that 200 can come from the container being replaced, so the very next
 * request may still be answered by the old image. See `DEFAULT_SETTLE_ATTEMPTS`
 * for why a re-read — and not a larger allowance — is the only thing that can
 * fix it.
 *
 * What the settle deliberately does **not** do:
 *
 * - **It cannot turn a persistent drift into a pass.** A re-read only changes
 *   the verdict by observing a *different, matching* sha. A site that keeps
 *   serving the old commit is read three more times and still fails, with the
 *   count in the message so nobody mistakes a settled deploy for a first-read
 *   match.
 * - **It never re-reads a `blocked` first reading.** "The version endpoint could
 *   not be read" is already retried once inside `probe()`, is already its own
 *   failure on the `version` check, and is not drift. Looping on it would be
 *   this check spending a minute to arrive at the same honest "cannot tell" —
 *   or worse, converting an absence into a claim.
 * - **It never lets an unreadable re-read overturn a reading that succeeded.**
 *   If a later probe comes back unreadable, the mismatch already observed stands
 *   and the message says the re-read failed. An absence does not erase an
 *   observation, in either direction.
 *
 * `now` is fixed for the whole settle on purpose: the reported drift age is the
 * age at the moment the run started, not a figure that creeps by half a minute
 * depending on how many re-reads happened.
 */
export async function resolveReleaseDrift(
  expectation: ReleaseExpectation,
  first: ProbeResult,
  reread: () => Promise<ProbeResult>,
  now: Date,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<CheckOutcome> {
  const outcome = evaluateReleaseDrift(expectation, first, now);

  // Nothing to settle: the release landed, or there is no expected head to
  // compare against, or the first reading was never usable.
  if (outcome.state === "pass") return outcome;
  if (!expectation.ok) return outcome;
  if (!readSha(first, "/api/version").ok) return outcome;

  return settle(outcome, {
    policy: { attempts: expectation.settleAttempts, delayMs: expectation.settleDelayMs },
    label: "/api/version",
    readable: (probed) => readSha(probed, "/api/version").ok,
    judge: (probed) => evaluateReleaseDrift(expectation, probed, now),
    reread,
    wait,
    settledBecause:
      "the first read was still serving an older sha, which is a deploy finishing rather than a " +
      "release that did not land",
    unchanged: "the live sha did not change",
  });
}

/** What one settling check needs, beyond the policy. */
interface SettleTerms<T> {
  policy: SettlePolicy;
  /** The endpoint(s) being re-read, named as the message will name them. */
  label: string;
  /** Whether a reading can be judged at all. An unreadable one is never judged. */
  readable: (reading: T) => boolean;
  judge: (reading: T) => CheckOutcome;
  reread: () => Promise<T>;
  wait: (ms: number) => Promise<void>;
  /** Why a mismatch that later agreed was a deploy in flight, in the words the reader gets. */
  settledBecause: string;
  /** What did not change, when every re-read said the same thing. */
  unchanged: string;
}

/**
 * The bounded re-read itself, shared by every check that can be caught mid-swap.
 *
 * The caller decides *whether* to settle — it owns the question of which first
 * readings are even eligible — and this owns *how*, so the three guarantees in
 * `resolveReleaseDrift`'s comment hold identically wherever it is used:
 *
 * - a verdict only improves by observing a different, matching reading;
 * - an unreadable re-read never overturns an observation that succeeded;
 * - the account of the re-reads is appended to the message either way, so a
 *   settled deploy is legible as different from a first-read match.
 */
async function settle<T>(first: CheckOutcome, terms: SettleTerms<T>): Promise<CheckOutcome> {
  if (terms.policy.attempts < 1) return first;

  const spacing = `${Math.round(terms.policy.delayMs / 100) / 10}s apart`;
  let latest = first;

  for (let attempt = 1; attempt <= terms.policy.attempts; attempt += 1) {
    await terms.wait(terms.policy.delayMs);
    const probed = await terms.reread();

    if (!terms.readable(probed)) {
      return withSettleNote(
        latest,
        `Re-read ${terms.label} ${attempt} time(s) ${spacing} to let a deploy settle; ` +
          `read ${attempt} came back unreadable, so the mismatch above is the last thing actually seen`,
      );
    }

    latest = terms.judge(probed);
    if (latest.state === "pass") {
      return withSettleNote(
        latest,
        `settled after ${attempt} re-read(s) of ${terms.label} ${spacing} — ${terms.settledBecause}`,
      );
    }
  }

  return withSettleNote(
    latest,
    `Re-read ${terms.label} ${terms.policy.attempts} time(s) ${spacing} to let a deploy settle, ` +
      `and ${terms.unchanged}`,
  );
}

/** Append the settle account to an outcome, leaving its state alone. */
function withSettleNote(outcome: CheckOutcome, note: string): CheckOutcome {
  return { ...outcome, detail: `${outcome.detail}. ${note}` };
}

/* ── Probe 2, settled ───────────────────────────────────────────────── */

/** One reading of both version endpoints, taken as a pair. */
export interface VersionReading {
  api: ProbeResult;
  web: ProbeResult;
}

/** Both documents must be readable before a disagreement between them means anything. */
function versionReadable(reading: VersionReading): boolean {
  return readSha(reading.api, "/api/version").ok && readSha(reading.web, "/version.json").ok;
}

/**
 * The version-skew judgement, given the same bounded chance to settle.
 *
 * **The race this closes**, and it is the drift check's race exactly: the two
 * images roll independently, so a probe landing mid-swap can catch one rolled
 * and the other not. `evaluateVersion` judged that from a single first read and
 * reported "a half-finished rollout" — a convincing, specific, wrong claim about
 * a deploy that was merely in progress. `deploy.yml` runs this monitor, so that
 * is a red pipeline on a good deploy, and the health poll ahead of it exits on
 * the first 200 and so cannot rule the case out.
 *
 * What it deliberately does **not** do, in the same three refusals the drift
 * settle makes:
 *
 * - **A persistent skew still fails.** The verdict can only improve by reading
 *   two documents that agree; a stack that keeps serving mismatched images is
 *   read three more times and still fails, with the count in the message.
 * - **An unreadable endpoint is never re-read into a skew, or out of one.** A
 *   version document that could not be read is already this check's own failure
 *   and is not a skew, so it is returned as it stands. If a *later* read comes
 *   back unreadable, the skew already observed stands and the message says the
 *   re-read failed.
 * - **A first-read agreement costs nothing.** No re-read, no delay, and no
 *   retry wording in the message, so the ordinary periodic run is unchanged and
 *   a settled deploy cannot be mistaken for one that was right first time.
 *
 * A settle policy that could not be read leaves the verdict alone and says so.
 * The mismatch was genuinely observed — unlike the drift check's `blocked`,
 * where a missing expected head means nothing was ever compared — so downgrading
 * it would be a typo in an environment variable silencing a real half-rolled
 * stack.
 */
export async function resolveVersionSkew(
  settlePolicy: SettlePolicyResult,
  first: VersionReading,
  reread: () => Promise<VersionReading>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<CheckOutcome> {
  const outcome = evaluateVersion(first.api, first.web);

  if (outcome.state === "pass") return outcome;
  if (!versionReadable(first)) return outcome;

  if (!settlePolicy.ok) {
    return withSettleNote(
      outcome,
      `The re-read that would tell a deploy in flight from a half-finished rollout did not run: ` +
        `${settlePolicy.reason}. The skew above was read, so this stays a failure`,
    );
  }

  return settle(outcome, {
    policy: settlePolicy.policy,
    label: "/api/version and /version.json",
    readable: versionReadable,
    judge: (reading) => evaluateVersion(reading.api, reading.web),
    reread,
    wait,
    settledBecause:
      "the two images had not both rolled yet, which is a deploy in flight rather than a " +
      "half-finished rollout",
    unchanged: "the two images still disagree",
  });
}

/* ── Probe 4: ingestion staleness ───────────────────────────────────── */

/** The fields of a `/api/ingestion/sources` row this monitor judges on. */
export interface MonitoredSource {
  adapter_key: string;
  enabled: boolean;
  expected_interval_hours: number | null;
  last_success_at: string | null;
}

function readSource(value: unknown, index: number): { ok: true; source: MonitoredSource } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: `source ${index} is not an object` };

  const adapterKey = value.adapter_key;
  if (typeof adapterKey !== "string" || adapterKey === "") {
    return { ok: false, reason: `source ${index} has no adapter_key` };
  }
  const enabled = value.enabled;
  if (typeof enabled !== "boolean") {
    return { ok: false, reason: `source ${adapterKey} has no boolean enabled` };
  }

  const rawInterval = value.expected_interval_hours;
  let interval: number | null;
  if (rawInterval === null || rawInterval === undefined) {
    interval = null;
  } else if (typeof rawInterval === "number" && Number.isFinite(rawInterval)) {
    interval = rawInterval;
  } else {
    return { ok: false, reason: `source ${adapterKey} has a non-numeric expected_interval_hours` };
  }

  const rawLastSuccess = value.last_success_at;
  let lastSuccess: string | null;
  if (rawLastSuccess === null || rawLastSuccess === undefined) {
    lastSuccess = null;
  } else if (typeof rawLastSuccess === "string") {
    lastSuccess = rawLastSuccess;
  } else {
    return { ok: false, reason: `source ${adapterKey} has a non-string last_success_at` };
  }

  return {
    ok: true,
    source: {
      adapter_key: adapterKey,
      enabled,
      expected_interval_hours: interval,
      last_success_at: lastSuccess,
    },
  };
}

/**
 * One source's verdict.
 *
 * The rules, and what each one refuses to claim:
 *
 * - **Disabled is skipped.** Bozeman, Gallatin and MT CERS are registered and
 *   switched off. A source nobody enabled is not failing to sweep, and
 *   alarming here would have made this monitor permanently red on the day it
 *   shipped — which is how a monitor becomes something people mute.
 * - **No stated interval is skipped.** Staleness is measured against an
 *   interval somebody set. Inventing a threshold for a source that declares
 *   none would be this project publishing a figure nobody agreed to.
 * - **Enabled, interval set, never swept is a warning, not a failure.** The
 *   feed does not record *when* a source was enabled, so time-since-enable
 *   cannot be computed, and the first minute after an operator enables Gallatin
 *   is exactly this state. Failing here pages somebody for switching a source
 *   on.
 * - **Enabled, interval set, and past it is the failure**, and it is the only
 *   case where the arithmetic is complete.
 *
 * The figures are recomputed here rather than read from the feed's own
 * `silence.verdict`. The point of an external monitor is not to ask the subject
 * how it thinks it is doing, and computing against this process's clock also
 * catches a server whose clock has drifted.
 */
export function evaluateSource(source: MonitoredSource, now: Date): CheckOutcome {
  const name = `source:${source.adapter_key}`;

  if (!source.enabled) {
    return { name, state: "pass", detail: "disabled — not expected to sweep" };
  }

  const interval = source.expected_interval_hours;
  if (interval === null || interval <= 0) {
    return { name, state: "pass", detail: "enabled, no expected interval declared — nothing to measure against" };
  }

  if (source.last_success_at === null) {
    return {
      name,
      state: "warn",
      detail: `enabled and has never swept successfully; expected every ${interval} h. Not a failure — the feed does not say when it was enabled`,
    };
  }

  const lastSuccess = new Date(source.last_success_at);
  if (Number.isNaN(lastSuccess.getTime())) {
    return { name, state: "fail", detail: `last_success_at is not a date: ${source.last_success_at}` };
  }

  const hours = (now.getTime() - lastSuccess.getTime()) / 3_600_000;
  const rounded = Math.round(hours * 10) / 10;
  if (hours > interval) {
    return {
      name,
      state: "fail",
      detail: `stale: last successful sweep ${rounded} h ago, expected every ${interval} h`,
    };
  }
  return { name, state: "pass", detail: `last successful sweep ${rounded} h ago, within ${interval} h` };
}

/** Every source in the feed, plus the feed's own readability. */
export function evaluateSources(probe: ProbeResult, now: Date): CheckOutcome[] {
  const failure = transportFailure(probe);
  if (failure !== null) return [{ name: "sources", state: "fail", detail: failure }];

  const parsed = parseJsonObject(probe.body);
  if (!parsed.ok) return [{ name: "sources", state: "fail", detail: parsed.reason }];

  const sources = parsed.value.sources;
  if (!Array.isArray(sources)) {
    return [{ name: "sources", state: "fail", detail: "response has no `sources` array" }];
  }
  if (sources.length === 0) {
    // Not a failure: an empty registry is a legible state, and the deployment
    // this monitor watches has been through it. It is still worth saying out
    // loud, because a feed that has silently lost its rows looks identical.
    return [{ name: "sources", state: "warn", detail: "no sources are registered" }];
  }

  const outcomes: CheckOutcome[] = [];
  sources.forEach((value, index) => {
    const read = readSource(value, index);
    if (!read.ok) {
      outcomes.push({ name: `source:${index}`, state: "fail", detail: read.reason });
      return;
    }
    outcomes.push(evaluateSource(read.source, now));
  });
  return outcomes;
}

/* ── Probe 5: resource pressure ─────────────────────────────────────── */

/** The three real states `routes/health.ts` may report for a resource. */
type ResourceState = "ok" | "low" | "critical";

function isResourceState(value: unknown): value is ResourceState {
  return value === "ok" || value === "low" || value === "critical";
}

function worstResourceState(a: ResourceState, b: ResourceState): ResourceState {
  const rank: Record<ResourceState, number> = { ok: 0, low: 1, critical: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Disk and memory pressure, as reported by `/api/health`'s `resources` field.
 *
 * **Why this reads `/api/health` rather than probing the host.** The monitor
 * runs outside the box over HTTP — see the module doc — so it cannot read the
 * deploy host's disk or memory itself. The backend can, from inside the
 * container, and reports coarse states rather than raw capacity; see
 * `routes/health.ts` for why exact free bytes are deliberately withheld from
 * this public, unauthenticated endpoint.
 *
 * **`blocked`, not `pass`, is the whole point of this check.** This is the
 * exact shape of the 2026-08-15 incident: the disk filled, every uptime and
 * deploy signal stayed green because they only ever asked "is the site up",
 * and the site was. A backend that predates this field, or that ships one in
 * a shape this cannot trust, must read as "we could not tell" — never as a
 * clean bill of health borrowed from an absence. So every one of these is
 * `blocked`, not `pass`:
 *
 * - `/api/health` itself could not be read (transport failure, non-JSON body).
 * - the response has no `resources` object at all — an older backend.
 * - `resources.disk` or `resources.memory` is missing, not a string, or a
 *   string this backend does not use (a typo, a future state this monitor
 *   predates).
 *
 * Only when both fields are a known state does this become a real verdict:
 * `critical` on either fails the run, `low` on either (with neither critical)
 * warns, and `ok`/`ok` passes.
 */
export function evaluateResources(health: ProbeResult): CheckOutcome {
  const name = "resources";

  const failure = transportFailure(health);
  if (failure !== null) {
    return { name, state: "blocked", detail: `could not read /api/health: ${failure}` };
  }

  const parsed = parseJsonObject(health.body);
  if (!parsed.ok) {
    return { name, state: "blocked", detail: `could not read /api/health: ${parsed.reason}` };
  }

  const resources = parsed.value.resources;
  if (!isRecord(resources)) {
    return {
      name,
      state: "blocked",
      detail:
        "response has no `resources` object — either an older backend that predates this check, " +
        "or a malformed one. Not a pass",
    };
  }

  const disk = resources.disk;
  const memory = resources.memory;
  if (!isResourceState(disk) || !isResourceState(memory)) {
    return {
      name,
      state: "blocked",
      detail:
        `resources has an unreadable field — disk=${JSON.stringify(disk)}, memory=${JSON.stringify(memory)}. ` +
        `Not a pass`,
    };
  }

  const worst = worstResourceState(disk, memory);
  const detail = `disk ${disk}, memory ${memory}`;
  if (worst === "critical") return { name, state: "fail", detail };
  if (worst === "low") return { name, state: "warn", detail };
  return { name, state: "pass", detail };
}

/* ── Probe 6: prerender split ───────────────────────────────────────── */

/**
 * The route this check probes.
 *
 * `frontend/nginx.conf`'s prerender consumer writes one document per
 * `/meetings/{id}`, `/findings/{id}`, `/officials/{id}` and `/source/{sha}` —
 * every one of those needs a real, currently-published record to exist, which
 * this monitor cannot assume (production has run with zero, one, or many
 * published meetings across its life). `/data` is the one prerendered route
 * with a fixed path — see the consumer's route list — so it is reachable the
 * same way on every run, whether or not anything has been published yet.
 */
export const PRERENDER_CHECK_PATH = "/data";

/**
 * The identity sent to ask nginx's `map $http_user_agent $prerender_prefix`
 * (`frontend/nginx.conf`) for the crawler branch.
 *
 * This is deliberately not a literal `Googlebot` string — see `MONITOR_USER_AGENT`
 * for why this monitor names itself honestly rather than impersonating anything.
 * It has to contain the literal substring `googlebot`, because that is what the
 * map's `~*(googlebot|...)` regex tests for and nginx does the matching, not
 * this file — so the string is built to be both: self-identifying as
 * CommissionWatchMonitor, and a fact about testing "the googlebot branch",
 * rather than a claim to be Google's crawler.
 */
export const PRERENDER_CRAWLER_USER_AGENT =
  "CommissionWatchMonitor/1.0 (+https://commissionwatch.bmux.sh; googlebot-branch prerender probe; admin@bmux.sh)";

/** One reading of `PRERENDER_CHECK_PATH`, taken under each identity. */
export interface PrerenderReading {
  browser: ProbeResult;
  crawler: ProbeResult;
}

/**
 * True when a response is the Vite-built SPA shell rather than a prerendered
 * document.
 *
 * `id="root"` is the element `frontend/src/main.tsx` mounts React onto. Every
 * SPA response carries it — it is `frontend/index.html`, byte for byte, for
 * any route the dev server or nginx's fallback serves. No prerendered document
 * ever will: `renderDocument` (`backend/src/services/prerender/document.ts`)
 * writes `<body><main>…</main><footer>…</footer></body>` and nothing else,
 * because it deliberately does not know the frontend's hashed bundle names —
 * see that file's header comment. It does emit a `<script type="application/ld+json">`
 * block (structured data), so "contains a `<script>` tag" is not usable as the
 * discriminator; the mount point is.
 *
 * **Rot risk, stated rather than assumed away:** this breaks only if the SPA's
 * root element id changes. That change breaks React mounting for every visitor
 * on every route in the same commit — the loudest possible failure — so it is
 * not a thing that rots quietly the way a scraped CSS class name would.
 */
function isSpaShell(body: string): boolean {
  return body.includes('id="root"');
}

/** Whether a response tells a cache in front of it to key on User-Agent. */
function variesOnUserAgent(probe: ProbeResult): boolean {
  const vary = probe.headers["vary"];
  if (vary === undefined) return false;
  return vary
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .includes("user-agent");
}

/**
 * Is the crawler/browser split actually happening, and if it is, is the one
 * header that makes it safe behind a shared cache present?
 *
 * Four outcomes, matched to the four this monitor already distinguishes
 * elsewhere:
 *
 * - **`pass`, split off.** Both identities get the SPA shell. This is
 *   `PRERENDER_ENABLED` unset, or the consumer's volume empty, or this
 *   backend predating the feature entirely — and none of those are a defect.
 *   Prerendering may be shipped dark; a monitor that failed on "off" would be
 *   wrong about a state the operator chose on purpose.
 * - **`pass`, split on.** The crawler identity gets a document without the
 *   SPA's mount point, the browser identity gets the shell, and both
 *   responses carry `Vary: User-Agent`. The split is doing its job safely.
 * - **`fail`, the dangerous one.** The split is on — the two identities get
 *   different markup — but `Vary: User-Agent` is missing from one or both
 *   responses. That is the exact failure `frontend/nginx.conf`'s own comment
 *   names: a cache between here and a reader can now serve a crawler's
 *   unstyled document to the next human who asks for the same URL, or the
 *   SPA shell to the next crawler. This is a `fail`, not a `warn`, because
 *   unlike a slow deploy this has no self-correcting window — it stays wrong
 *   until someone fixes the config.
 * - **`blocked`, everything else.** The route could not be read at all, or
 *   the two responses disagree in a shape this check does not recognise (for
 *   instance the crawler identity getting the shell while the browser
 *   identity does not — no known nginx config produces that, and guessing
 *   at what it means would be inventing a fact from a `map` this check did
 *   not write). `blocked` is never `pass`, so an unrecognised shape never
 *   reads as "the split works".
 */
export function evaluatePrerender(reading: PrerenderReading): CheckOutcome {
  const name = "prerender";

  const browserFailure = transportFailure(reading.browser);
  if (browserFailure !== null) {
    return {
      name,
      state: "blocked",
      detail: `browser-identity probe of ${PRERENDER_CHECK_PATH}: ${browserFailure}. Not a pass`,
    };
  }
  const crawlerFailure = transportFailure(reading.crawler);
  if (crawlerFailure !== null) {
    return {
      name,
      state: "blocked",
      detail: `crawler-identity probe of ${PRERENDER_CHECK_PATH}: ${crawlerFailure}. Not a pass`,
    };
  }

  const browserIsShell = isSpaShell(reading.browser.body);
  const crawlerIsShell = isSpaShell(reading.crawler.body);
  const browserVaries = variesOnUserAgent(reading.browser);
  const crawlerVaries = variesOnUserAgent(reading.crawler);

  if (browserIsShell && crawlerIsShell) {
    return {
      name,
      state: "pass",
      detail:
        `both the browser and crawler identity get the SPA shell at ${PRERENDER_CHECK_PATH} — the prerender ` +
        `split is not currently serving crawlers a prerendered document. Not a failure: prerendering may be ` +
        `deliberately off`,
    };
  }

  if (!crawlerIsShell && browserIsShell) {
    if (!crawlerVaries || !browserVaries) {
      const missingFrom =
        !crawlerVaries && !browserVaries
          ? "the crawler and browser responses"
          : !crawlerVaries
            ? "the crawler response"
            : "the browser response";
      return {
        name,
        state: "fail",
        detail:
          `the prerender split is active at ${PRERENDER_CHECK_PATH} — the crawler identity got a document ` +
          `without the SPA's mount point and the browser identity got the SPA shell — but Vary: User-Agent is ` +
          `missing from ${missingFrom}. A cache in front of this site could now serve one audience's response ` +
          `to the other`,
      };
    }
    return {
      name,
      state: "pass",
      detail:
        `the prerender split is active: the crawler identity gets the prerendered document, the browser ` +
        `identity gets the SPA shell, and Vary: User-Agent is present on both responses at ${PRERENDER_CHECK_PATH}`,
    };
  }

  return {
    name,
    state: "blocked",
    detail:
      `${PRERENDER_CHECK_PATH} answered in a shape this check does not recognise ` +
      `(browser got the shell: ${browserIsShell}, crawler got the shell: ${crawlerIsShell}) — not a pass`,
  };
}

/* ── Reporting ──────────────────────────────────────────────────────── */

export interface Summary {
  failed: boolean;
  failures: CheckOutcome[];
  warnings: CheckOutcome[];
  blocked: CheckOutcome[];
  lines: string[];
}

const MARK: Record<CheckState, string> = { pass: "PASS", warn: "WARN", blocked: "BLOCKED", fail: "FAIL" };

/**
 * The run's verdict.
 *
 * A warning is reported and does not fail the run. So is a blocked check — but
 * it is counted and printed separately, because "we could not tell" is a
 * different thing to hand somebody than "we looked and it is fine".
 */
export function summarise(outcomes: CheckOutcome[]): Summary {
  const failures = outcomes.filter((o) => o.state === "fail");
  const warnings = outcomes.filter((o) => o.state === "warn");
  const blocked = outcomes.filter((o) => o.state === "blocked");
  return {
    failed: failures.length > 0,
    failures,
    warnings,
    blocked,
    lines: outcomes.map((o) => `${MARK[o.state]}  ${o.name}: ${o.detail}`),
  };
}

export interface AlertContext {
  baseUrl: string;
  runUrl: string | null;
  checkedAt: string;
}

/**
 * The message posted straight to Discord.
 *
 * It says that it bypassed the application's own routing, and why. That is the
 * fallback reasoning in the W7 spec taken to its conclusion: a deploy that
 * broke the backend is exactly when the backend cannot be trusted to say the
 * deploy broke it, so this never POSTs to `/api/internal/events`. A message
 * that looks different from the product's own notifications should explain why
 * it looks different.
 */
export function buildAlertMessage(summary: Summary, context: AlertContext): string {
  const parts: string[] = [];
  parts.push(`**CommissionWatch external monitor: ${summary.failures.length} failing check(s)**`);
  parts.push(`Target: ${context.baseUrl} · checked ${context.checkedAt}`);
  parts.push("");
  for (const failure of summary.failures) {
    parts.push(`• **${failure.name}** — ${failure.detail}`);
  }
  for (const warning of summary.warnings) {
    parts.push(`• (warning) ${warning.name} — ${warning.detail}`);
  }
  for (const blocked of summary.blocked) {
    parts.push(`• (blocked — could not be determined) ${blocked.name} — ${blocked.detail}`);
  }
  parts.push("");
  if (context.runUrl !== null) parts.push(`Run: ${context.runUrl}`);
  parts.push(
    "Posted directly to this webhook, bypassing the application's delivery routing on purpose: the backend cannot be trusted to report its own outage.",
  );

  const message = parts.join("\n");
  if (message.length <= DISCORD_CONTENT_LIMIT) return message;
  const ellipsis = "\n… truncated";
  return `${message.slice(0, DISCORD_CONTENT_LIMIT - ellipsis.length)}${ellipsis}`;
}

/* ── I/O ────────────────────────────────────────────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attempt(
  url: string,
  userAgent: string,
): Promise<{ status: number; body: string; headers: Record<string, string> } | { error: string }> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, body, headers };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One request, and at most one retry.
 *
 * Retried only on a transport error or a 5xx — the shapes a restarting
 * container makes. A 4xx is not retried: it will say the same thing the second
 * time, and hammering a site we are worried about is not monitoring it.
 *
 * `userAgent` defaults to the monitor's own honest identity. The `prerender`
 * check is the one caller that overrides it — see `PRERENDER_CRAWLER_USER_AGENT`
 * — to ask nginx's `map $http_user_agent $prerender_prefix` the question this
 * check exists to answer.
 */
export async function probe(url: string, userAgent: string = MONITOR_USER_AGENT): Promise<ProbeResult> {
  let last = await attempt(url, userAgent);
  let attempts = 1;

  const retryable = "error" in last || last.status >= 500;
  if (retryable) {
    await sleep(RETRY_DELAY_MS);
    last = await attempt(url, userAgent);
    attempts = 2;
  }

  if ("error" in last) {
    return { url, status: null, body: "", error: last.error, attempts, headers: {} };
  }
  return { url, status: last.status, body: last.body, error: null, attempts, headers: last.headers };
}

/**
 * Post the alert straight to the webhook.
 *
 * Returns whether it landed. A webhook that will not accept the message is
 * reported in the log and does not change the run's verdict, which already
 * reflects the site — and which is why the failed run is the durable alert and
 * the webhook is the convenience.
 */
export async function postToDiscord(webhookUrl: string, content: string): Promise<boolean> {
  for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": MONITOR_USER_AGENT },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 429 && attemptNo === 1) {
        // Discord publishes 5 requests per 2 seconds per webhook and tells you
        // how long to wait. Honouring it beats a blind retry.
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? 2 : Number(retryAfter);
        await sleep(Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 10) * 1000 : 2000);
        continue;
      }
      if (response.status >= 200 && response.status < 300) return true;
      console.error(`discord webhook returned HTTP ${response.status}`);
      return false;
    } catch (error) {
      console.error(`discord webhook failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  return false;
}

export async function main(): Promise<number> {
  const baseUrl = (process.env.MONITOR_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const now = new Date();

  console.log(`CommissionWatch external monitor — ${baseUrl} at ${now.toISOString()}`);

  const health = await probe(`${baseUrl}/api/health`);
  const apiVersion = await probe(`${baseUrl}/api/version`);
  const webVersion = await probe(`${baseUrl}/version.json`);
  const sources = await probe(`${baseUrl}/api/ingestion/sources`);
  const prerenderBrowser = await probe(`${baseUrl}${PRERENDER_CHECK_PATH}`);
  const prerenderCrawler = await probe(`${baseUrl}${PRERENDER_CHECK_PATH}`, PRERENDER_CRAWLER_USER_AGENT);

  // Both of these may re-read before they believe a mismatch — see
  // `DEFAULT_SETTLE_ATTEMPTS`. They re-probe rather than reusing the readings
  // above, because the whole point is to look again. Nothing is re-read when the
  // first reading already agrees, so an ordinary run costs four requests.
  const version = await resolveVersionSkew(
    readSettlePolicy(process.env),
    { api: apiVersion, web: webVersion },
    async () => ({
      api: await probe(`${baseUrl}/api/version`),
      web: await probe(`${baseUrl}/version.json`),
    }),
  );

  const drift = await resolveReleaseDrift(
    readReleaseExpectation(process.env),
    apiVersion,
    () => probe(`${baseUrl}/api/version`),
    now,
  );

  const outcomes: CheckOutcome[] = [
    evaluateHealth(health),
    evaluateResources(health),
    version,
    drift,
    evaluatePrerender({ browser: prerenderBrowser, crawler: prerenderCrawler }),
    ...evaluateSources(sources, now),
  ];

  const summary = summarise(outcomes);
  for (const line of summary.lines) console.log(line);

  if (!summary.failed) {
    console.log(
      `\nNo check failed (${summary.warnings.length} warning(s), ${summary.blocked.length} blocked — ` +
        `blocked means the answer could not be determined, not that it was fine). ` +
        `Nothing is posted on a green run.`,
    );
    return 0;
  }

  console.error(`\n${summary.failures.length} check(s) failed.`);

  const webhook = process.env.DISCORD_WEBHOOK_URL ?? "";
  if (webhook.trim() === "") {
    // Deliberate: no webhook means the failed run is the alert. Inventing a
    // second channel nobody configured would be this monitor deciding on its
    // own how to reach a person.
    console.error("DISCORD_WEBHOOK_URL is not configured; the failed run is the alert.");
    return 1;
  }

  const message = buildAlertMessage(summary, {
    baseUrl,
    runUrl: process.env.MONITOR_RUN_URL ?? null,
    checkedAt: now.toISOString(),
  });
  const posted = await postToDiscord(webhook.trim(), message);
  console.error(posted ? "alert posted directly to Discord." : "alert could not be posted to Discord.");
  return 1;
}

// Runs only when asked, so importing this module in a test probes nobody's
// site. `--run` rather than an import.meta check because this file is executed
// as ESM by Node's type stripping and imported through tsx's CommonJS build in
// the test suite, and the argv is the one thing that means the same in both.
if (process.argv.includes("--run")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`external monitor crashed: ${error instanceof Error ? error.stack : String(error)}`);
      process.exitCode = 2;
    });
}

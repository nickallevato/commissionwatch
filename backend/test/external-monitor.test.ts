import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAlertMessage,
  DISCORD_CONTENT_LIMIT,
  DEFAULT_BACKUP_MAX_AGE_HOURS,
  DEFAULT_MAX_DRIFT_MINUTES,
  evaluateBackupFreshness,
  evaluateHealth,
  evaluatePrerender,
  evaluateReleaseDrift,
  evaluateResources,
  evaluateSource,
  evaluateSources,
  evaluateVersion,
  PRERENDER_CHECK_PATH,
  readReleaseExpectation,
  readSettlePolicy,
  resolveReleaseDrift,
  resolveVersionSkew,
  summarise,
  DEFAULT_SETTLE_ATTEMPTS,
  DEFAULT_SETTLE_DELAY_MS,
  type CheckOutcome,
  type ProbeResult,
} from "../src/scripts/external-monitor";

/**
 * The external monitor's judgement, tested against fixtures rather than the
 * network.
 *
 * This is the whole reason the evaluation is a module and not a run of shell
 * `if` statements in a YAML file: a monitor whose logic is untested is a
 * monitor that will one day report success while the site is down, and nobody
 * will find out until they open the site — which is exactly the failure it was
 * built to prevent.
 *
 * Nothing here touches the database or the network. `--run` is absent from this
 * process's argv, so importing the module probes nobody.
 */

/** A response that arrived, with a body. */
function response(status: number, body: string, headers: Record<string, string> = {}): ProbeResult {
  return { url: "https://example.test/probe", status, body, error: null, attempts: 1, headers };
}

/** A request that never produced a response at all. */
function unreachable(error: string): ProbeResult {
  return { url: "https://example.test/probe", status: null, body: "", error, attempts: 2, headers: {} };
}

const HEALTHY_BODY = JSON.stringify({
  status: "ok",
  database: "connected",
  digest: { running: true, dailyLastRun: null, weeklyLastRun: null },
  timestamp: "2026-08-10T04:05:31.597Z",
});

const SHA = "9004d3452b2043f10f469bda482d76eea67c0b54";
const OTHER_SHA = "1fb246f0a1b2c3d4e5f60718293a4b5c6d7e8f90";

function versionBody(service: string, sha: string): string {
  return JSON.stringify({ service, sha, builtAt: "2026-08-10T03:53:15Z" });
}

/** Shaped exactly like production's `/api/ingestion/sources` today. */
function sourcesBody(sources: unknown[]): string {
  return JSON.stringify({
    generated_at: "2026-08-10T04:05:37.430Z",
    last_successful_sweep_at: null,
    sources,
    total: sources.length,
  });
}

const NOW = new Date("2026-08-10T04:00:00.000Z");

describe("external monitor — health", () => {
  it("passes a healthy response", () => {
    const outcome = evaluateHealth(response(200, HEALTHY_BODY));
    assert.equal(outcome.state, "pass");
  });

  it("fails when the database is disconnected", () => {
    const body = JSON.stringify({ status: "ok", database: "disconnected" });
    const outcome = evaluateHealth(response(200, body));
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /disconnected/);
  });

  it("fails on the 502 that four hours of outage looked like", () => {
    const outcome = evaluateHealth(response(502, "<html>Bad Gateway</html>"));
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /HTTP 502/);
  });

  it("names the Caddy allowlist on a 403 rather than calling it an outage", () => {
    const outcome = evaluateHealth(response(403, "Forbidden"));
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /allowlist/);
  });

  it("fails when nothing answered at all, and says so differently from a 502", () => {
    const outcome = evaluateHealth(unreachable("The operation was aborted due to timeout"));
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /no response after 2 attempt/);
  });

  it("fails on a malformed body rather than reading it as healthy", () => {
    const outcome = evaluateHealth(response(200, "<html>it worked!</html>"));
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /not JSON/);
  });

  it("fails on a JSON array, which is JSON and is not a health report", () => {
    const outcome = evaluateHealth(response(200, "[]"));
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /not a JSON object/);
  });

  it("fails when the database field is missing entirely", () => {
    const outcome = evaluateHealth(response(200, JSON.stringify({ status: "ok" })));
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /no `database` string/);
  });
});

/**
 * `evaluateResources` reads the `resources` field `/api/health` reports (see
 * `routes/health.ts`). The case that matters most is the one named in the
 * roadmap item: an absent `resources` field must be `blocked`, never `pass` —
 * that is precisely the failure that let the 2026-08-15 disk-full incident go
 * unnoticed while every uptime signal stayed green.
 */
function healthBody(resources: unknown): string {
  return JSON.stringify({ status: "ok", database: "connected", resources });
}

describe("external monitor — resource pressure", () => {
  it("passes when both disk and memory are ok", () => {
    const outcome = evaluateResources(response(200, healthBody({ disk: "ok", memory: "ok" })));
    assert.equal(outcome.state, "pass");
    assert.match(outcome.detail, /disk ok, memory ok/);
  });

  it("warns when disk is low", () => {
    const outcome = evaluateResources(response(200, healthBody({ disk: "low", memory: "ok" })));
    assert.equal(outcome.state, "warn");
  });

  it("warns when memory is low", () => {
    const outcome = evaluateResources(response(200, healthBody({ disk: "ok", memory: "low" })));
    assert.equal(outcome.state, "warn");
  });

  it("fails when disk is critical", () => {
    const outcome = evaluateResources(response(200, healthBody({ disk: "critical", memory: "ok" })));
    assert.equal(outcome.state, "fail");
  });

  it("fails when memory is critical even if disk is only low", () => {
    const outcome = evaluateResources(response(200, healthBody({ disk: "low", memory: "critical" })));
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /disk low, memory critical/);
  });

  it("blocks — not passes — when the resources field is entirely absent", () => {
    // This is the assertion that matters most: an older backend that predates
    // this field, or a health response that simply omits it, must read as
    // "we could not tell" rather than borrowing a clean bill of health from an
    // absence. That collapse is exactly the shape of the 2026-08-15 incident.
    const outcome = evaluateResources(response(200, JSON.stringify({ status: "ok", database: "connected" })));
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.detail, /no `resources` object/);
  });

  it("blocks when resources is present but not an object", () => {
    const outcome = evaluateResources(response(200, healthBody("fine")));
    assert.equal(outcome.state, "blocked");
  });

  it("blocks when disk is a string that is not a known state", () => {
    const outcome = evaluateResources(response(200, healthBody({ disk: "mostly fine", memory: "ok" })));
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.detail, /unreadable field/);
  });

  it("blocks when memory is missing", () => {
    const outcome = evaluateResources(response(200, healthBody({ disk: "ok" })));
    assert.equal(outcome.state, "blocked");
  });

  it("blocks when a state field is a number instead of a string", () => {
    const outcome = evaluateResources(response(200, healthBody({ disk: 1, memory: "ok" })));
    assert.equal(outcome.state, "blocked");
  });

  it("blocks when /api/health itself could not be read", () => {
    const outcome = evaluateResources(unreachable("timeout"));
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.detail, /could not read \/api\/health/);
  });

  it("blocks on a malformed /api/health body rather than reading it as fine", () => {
    const outcome = evaluateResources(response(200, "<html>it worked!</html>"));
    assert.equal(outcome.state, "blocked");
  });
});

/**
 * Backup freshness — the 2026-08-16 maturity review's rank-1 gap. Nothing
 * could tell whether a backup had ever succeeded; `deploy/backup.sh`'s
 * critical-exit guard only fires when the script actually runs. `/api/health`
 * now reports `backup.lastSuccessAt` from `ops_event_log`, and this is the
 * judgement over it.
 */
function backupHealthBody(backup: unknown): string {
  return JSON.stringify({ status: "ok", database: "connected", backup });
}

describe("external monitor — backup freshness", () => {
  it("passes when the last success is well within the allowance", () => {
    const succeededAt = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    const outcome = evaluateBackupFreshness(
      response(200, backupHealthBody({ lastSuccessAt: succeededAt })),
      NOW,
    );
    assert.equal(outcome.state, "pass");
    assert.match(outcome.detail, /3 h ago/);
  });

  it(`fails when the last success is older than the ${DEFAULT_BACKUP_MAX_AGE_HOURS}-hour allowance`, () => {
    const succeededAt = new Date(NOW.getTime() - 30 * 3_600_000).toISOString();
    const outcome = evaluateBackupFreshness(
      response(200, backupHealthBody({ lastSuccessAt: succeededAt })),
      NOW,
    );
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /30 h ago/);
    assert.match(outcome.detail, /stopped landing/);
  });

  it("honours a MONITOR_BACKUP_MAX_AGE_HOURS-shaped override passed explicitly", () => {
    const succeededAt = new Date(NOW.getTime() - 10 * 3_600_000).toISOString();
    const outcome = evaluateBackupFreshness(
      response(200, backupHealthBody({ lastSuccessAt: succeededAt })),
      NOW,
      5,
    );
    assert.equal(outcome.state, "fail");
  });

  it("BLOCKS — never passes — when no backup has ever been recorded", () => {
    // This is the assertion that matters most in this whole file: "nothing
    // has ever succeeded" must never read as a clean bill of health borrowed
    // from an absence. See the MUTATION-VERIFY note in the module doc for
    // `evaluateBackupFreshness`.
    const outcome = evaluateBackupFreshness(
      response(200, backupHealthBody({ lastSuccessAt: null })),
      NOW,
    );
    assert.equal(outcome.state, "blocked");
    assert.notEqual(outcome.state, "pass");
    assert.match(outcome.detail, /no backup has ever been recorded/);
  });

  it("blocks when the backup field is entirely absent — an older backend", () => {
    const outcome = evaluateBackupFreshness(
      response(200, JSON.stringify({ status: "ok", database: "connected" })),
      NOW,
    );
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.detail, /no `backup` object/);
  });

  it("blocks when backup is present but not an object", () => {
    const outcome = evaluateBackupFreshness(response(200, backupHealthBody("fine")), NOW);
    assert.equal(outcome.state, "blocked");
  });

  it("blocks when lastSuccessAt is a number instead of a string or null", () => {
    const outcome = evaluateBackupFreshness(
      response(200, backupHealthBody({ lastSuccessAt: 12345 })),
      NOW,
    );
    assert.equal(outcome.state, "blocked");
  });

  it("blocks when lastSuccessAt is not a parseable date", () => {
    const outcome = evaluateBackupFreshness(
      response(200, backupHealthBody({ lastSuccessAt: "not a date" })),
      NOW,
    );
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.detail, /not a date/);
  });

  it("blocks when /api/health itself could not be read", () => {
    const outcome = evaluateBackupFreshness(unreachable("timeout"), NOW);
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.detail, /could not read \/api\/health/);
  });

  it("blocks on a malformed /api/health body rather than reading it as fine", () => {
    const outcome = evaluateBackupFreshness(response(200, "<html>it worked!</html>"), NOW);
    assert.equal(outcome.state, "blocked");
  });
});

/**
 * The prerender split — `frontend/nginx.conf`'s `map $http_user_agent
 * $prerender_prefix`, verified from outside because nothing in this repo
 * puts nginx in the request path. Probed at `/data`, the one prerendered
 * route with a fixed path, so the check works whether or not any meeting is
 * currently published.
 *
 * Fixture bodies stand in for the two real shapes production can answer
 * with: the Vite-built SPA shell (`id="root"`, a `<script type="module">`
 * pointing at a hashed bundle) and `renderDocument`'s prerendered document
 * (no mount point, a `<script type="application/ld+json">` block instead —
 * proof that "has a `<script>` tag" is not the discriminator this check uses).
 */
const SPA_SHELL_BODY =
  '<!doctype html><html lang="en"><head><title>CommissionWatch</title>' +
  '<script type="module" crossorigin src="/assets/index-DVi2iEZg.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-Cb2jez4Z.css"></head>' +
  '<body class="bg-paper text-ink"><div id="root"></div></body></html>';

const PRERENDERED_BODY =
  '<!doctype html><html lang="en"><head><title>Bulk data — CommissionWatch</title>' +
  '<script type="application/ld+json">{"@context":"https://schema.org"}</script></head>' +
  '<body><main><h1>Bulk data</h1></main><footer><a href="/bot">About this dataset</a></footer></body></html>';

describe("external monitor — prerender split", () => {
  it("passes when the split is off: both identities get the SPA shell", () => {
    const outcome = evaluatePrerender({
      browser: response(200, SPA_SHELL_BODY),
      crawler: response(200, SPA_SHELL_BODY),
    });
    assert.equal(outcome.state, "pass");
    assert.match(outcome.detail, /not currently serving crawlers/);
    assert.match(outcome.detail, /deliberately off/);
  });

  it("passes when the split is active and both responses carry Vary: User-Agent", () => {
    const outcome = evaluatePrerender({
      browser: response(200, SPA_SHELL_BODY, { vary: "User-Agent" }),
      crawler: response(200, PRERENDERED_BODY, { vary: "User-Agent" }),
    });
    assert.equal(outcome.state, "pass");
    assert.match(outcome.detail, /split is active/);
    assert.match(outcome.detail, new RegExp(PRERENDER_CHECK_PATH.replace("/", "\\/")));
  });

  it("treats Vary as present among other values, case-insensitively", () => {
    const outcome = evaluatePrerender({
      browser: response(200, SPA_SHELL_BODY, { vary: "Accept-Encoding, user-agent" }),
      crawler: response(200, PRERENDERED_BODY, { vary: "user-agent" }),
    });
    assert.equal(outcome.state, "pass");
  });

  it("FAILS — not warns — when the split is active but Vary: User-Agent is missing from the crawler response", () => {
    const outcome = evaluatePrerender({
      browser: response(200, SPA_SHELL_BODY, { vary: "User-Agent" }),
      crawler: response(200, PRERENDERED_BODY),
    });
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /Vary: User-Agent is missing/);
    assert.match(outcome.detail, /crawler response/);
    assert.match(outcome.detail, /cache in front/);
  });

  it("fails when Vary: User-Agent is missing from the browser response instead", () => {
    const outcome = evaluatePrerender({
      browser: response(200, SPA_SHELL_BODY),
      crawler: response(200, PRERENDERED_BODY, { vary: "User-Agent" }),
    });
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /browser response/);
  });

  it("fails — the case this monitor was built for — when the split is active and Vary is on neither response", () => {
    const outcome = evaluatePrerender({
      browser: response(200, SPA_SHELL_BODY),
      crawler: response(200, PRERENDERED_BODY),
    });
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /crawler and browser responses/);
  });

  it("blocks when the browser-identity probe could not be read", () => {
    const outcome = evaluatePrerender({
      browser: unreachable("connect ECONNREFUSED 10.0.0.1:443"),
      crawler: response(200, PRERENDERED_BODY, { vary: "User-Agent" }),
    });
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.detail, /browser-identity probe/);
    assert.match(outcome.detail, /ECONNREFUSED/);
  });

  it("blocks when the crawler-identity probe could not be read", () => {
    const outcome = evaluatePrerender({
      browser: response(200, SPA_SHELL_BODY, { vary: "User-Agent" }),
      crawler: response(502, "Bad Gateway"),
    });
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.detail, /crawler-identity probe/);
    assert.match(outcome.detail, /HTTP 502/);
  });

  it("blocks — never passes — on a shape this check does not recognise", () => {
    // The crawler identity got the shell and the browser identity got the
    // prerendered document — the inverse of what any nginx config here
    // produces. Not a state this check invents a story for.
    const outcome = evaluatePrerender({
      browser: response(200, PRERENDERED_BODY, { vary: "User-Agent" }),
      crawler: response(200, SPA_SHELL_BODY, { vary: "User-Agent" }),
    });
    assert.equal(outcome.state, "blocked");
    assert.match(outcome.detail, /does not recognise/);
  });

  it("counts as blocked, not as a pass, in the run summary", () => {
    const outcome = evaluatePrerender({
      browser: unreachable("timeout"),
      crawler: response(200, PRERENDERED_BODY, { vary: "User-Agent" }),
    });
    const summary = summarise([outcome]);
    assert.equal(summary.failed, false);
    assert.equal(summary.blocked.length, 1);
  });
});

describe("external monitor — version skew", () => {
  it("passes when both images serve the same sha", () => {
    const outcome = evaluateVersion(
      response(200, versionBody("backend", SHA)),
      response(200, versionBody("frontend", SHA)),
    );
    assert.equal(outcome.state, "pass");
    assert.match(outcome.detail, /9004d34/);
  });

  it("fails on skew — the shape of a half-finished rollout", () => {
    const outcome = evaluateVersion(
      response(200, versionBody("backend", OTHER_SHA)),
      response(200, versionBody("frontend", SHA)),
    );
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /version skew/);
    assert.match(outcome.detail, /1fb246f/);
    assert.match(outcome.detail, /9004d34/);
  });

  it('refuses to match two "unknown" shas', () => {
    const outcome = evaluateVersion(
      response(200, versionBody("backend", "unknown")),
      response(200, versionBody("frontend", "unknown")),
    );
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /no build stamp/);
  });

  it("fails when the frontend is up and the backend is 502 — last night exactly", () => {
    const outcome = evaluateVersion(
      response(502, "Bad Gateway"),
      response(200, versionBody("frontend", SHA)),
    );
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /\/api\/version: HTTP 502/);
  });

  it("fails on a malformed version document", () => {
    const outcome = evaluateVersion(
      response(200, "not json at all"),
      response(200, versionBody("frontend", SHA)),
    );
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /not JSON/);
  });
});

describe("external monitor — source staleness", () => {
  it("is quiet about a registered, disabled source", () => {
    const outcome = evaluateSource(
      {
        adapter_key: "bozeman-granicus",
        enabled: false,
        expected_interval_hours: 168,
        last_success_at: null,
      },
      NOW,
    );
    assert.equal(outcome.state, "pass");
    assert.match(outcome.detail, /disabled/);
  });

  it("is quiet about an enabled source with no declared interval", () => {
    const outcome = evaluateSource(
      { adapter_key: "mt-cers", enabled: true, expected_interval_hours: null, last_success_at: null },
      NOW,
    );
    assert.equal(outcome.state, "pass");
    assert.match(outcome.detail, /nothing to measure against/);
  });

  it("warns — and does not fail — for an enabled source that has never swept", () => {
    const outcome = evaluateSource(
      {
        adapter_key: "gallatin-civicplus",
        enabled: true,
        expected_interval_hours: 168,
        last_success_at: null,
      },
      NOW,
    );
    assert.equal(outcome.state, "warn");
    assert.match(outcome.detail, /never swept/);
  });

  it("fails an enabled source past its expected interval", () => {
    const outcome = evaluateSource(
      {
        adapter_key: "gallatin-civicplus",
        enabled: true,
        expected_interval_hours: 24,
        last_success_at: "2026-08-08T04:00:00.000Z",
      },
      NOW,
    );
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /stale/);
    assert.match(outcome.detail, /48 h ago/);
  });

  it("passes an enabled source inside its interval", () => {
    const outcome = evaluateSource(
      {
        adapter_key: "gallatin-civicplus",
        enabled: true,
        expected_interval_hours: 24,
        last_success_at: "2026-08-09T22:00:00.000Z",
      },
      NOW,
    );
    assert.equal(outcome.state, "pass");
    assert.match(outcome.detail, /within 24 h/);
  });

  it("fails an unparseable last_success_at instead of treating it as never", () => {
    const outcome = evaluateSource(
      {
        adapter_key: "gallatin-civicplus",
        enabled: true,
        expected_interval_hours: 24,
        last_success_at: "last tuesday",
      },
      NOW,
    );
    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /not a date/);
  });
});

describe("external monitor — the sources feed", () => {
  it("is silent about production as it stands today: three sources, all disabled", () => {
    const body = sourcesBody([
      {
        adapter_key: "bozeman-granicus",
        enabled: false,
        expected_interval_hours: 168,
        last_success_at: null,
      },
      {
        adapter_key: "gallatin-civicplus",
        enabled: false,
        expected_interval_hours: 168,
        last_success_at: null,
      },
      { adapter_key: "mt-cers", enabled: false, expected_interval_hours: null, last_success_at: null },
    ]);
    const summary = summarise(evaluateSources(response(200, body), NOW));
    assert.equal(summary.failed, false);
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.warnings.length, 0);
  });

  it("fails the run when one enabled source among many has gone stale", () => {
    const body = sourcesBody([
      {
        adapter_key: "bozeman-granicus",
        enabled: false,
        expected_interval_hours: 168,
        last_success_at: null,
      },
      {
        adapter_key: "gallatin-civicplus",
        enabled: true,
        expected_interval_hours: 24,
        last_success_at: "2026-08-01T04:00:00.000Z",
      },
    ]);
    const summary = summarise(evaluateSources(response(200, body), NOW));
    assert.equal(summary.failed, true);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].name, "source:gallatin-civicplus");
  });

  it("warns without failing when the registry is empty", () => {
    const summary = summarise(evaluateSources(response(200, sourcesBody([])), NOW));
    assert.equal(summary.failed, false);
    assert.equal(summary.warnings.length, 1);
  });

  it("fails a malformed feed rather than reporting zero stale sources", () => {
    const outcomes = evaluateSources(response(200, JSON.stringify({ total: 3 })), NOW);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].state, "fail");
    assert.match(outcomes[0].detail, /no `sources` array/);
  });

  it("fails a source row that is missing its fields", () => {
    const body = sourcesBody([{ adapter_key: "gallatin-civicplus" }]);
    const outcomes = evaluateSources(response(200, body), NOW);
    assert.equal(outcomes[0].state, "fail");
    assert.match(outcomes[0].detail, /boolean enabled/);
  });

  it("fails when the feed itself is unreachable", () => {
    const outcomes = evaluateSources(unreachable("connect ECONNREFUSED"), NOW);
    assert.equal(outcomes[0].state, "fail");
    assert.match(outcomes[0].detail, /ECONNREFUSED/);
  });
});

/**
 * Release drift — the 2026-08-14 incident, made detectable.
 *
 * The deploy host filled its disk, `deploy-aws` failed twice, every check job
 * stayed green, and production kept serving the previous good sha and answering
 * `/api/health` 200. Nothing alerted, because everything watching asked whether
 * the site was up. The tests below are written against that shape: a perfectly
 * healthy site that is running the wrong commit.
 */
describe("external monitor — release drift", () => {
  /** 90 minutes before NOW: well past any allowance. */
  const OLD_COMMIT = "2026-08-10T02:30:00.000Z";
  /** Five minutes before NOW: an arm64 build has not even finished yet. */
  const FRESH_COMMIT = "2026-08-10T03:55:00.000Z";

  function expectation(overrides: Record<string, string | undefined> = {}) {
    return readReleaseExpectation({
      MONITOR_EXPECTED_SHA: OTHER_SHA,
      MONITOR_EXPECTED_SHA_TIME: OLD_COMMIT,
      ...overrides,
    });
  }

  it("fails when the live sha is not the expected head, and names both shas", () => {
    const outcome = evaluateReleaseDrift(expectation(), response(200, versionBody("backend", SHA)), NOW);

    assert.equal(outcome.state, "fail");
    // Both, in full. The first question after this alert is which commit is
    // actually serving, and an abbreviation is not an answer you can `git show`.
    assert.ok(outcome.detail.includes(SHA), `expected the live sha in: ${outcome.detail}`);
    assert.ok(outcome.detail.includes(OTHER_SHA), `expected the head sha in: ${outcome.detail}`);
    assert.match(outcome.detail, /has not landed/);
    assert.match(outcome.detail, /90 min ago/);
    assert.match(outcome.detail, /30-min allowance/);
    // The incident's lesson, in the message itself.
    assert.match(outcome.detail, /healthy and still be/);
  });

  it("passes when the live sha is the expected head", () => {
    const outcome = evaluateReleaseDrift(
      expectation({ MONITOR_EXPECTED_SHA: SHA }),
      response(200, versionBody("backend", SHA)),
      NOW,
    );

    assert.equal(outcome.state, "pass");
    assert.ok(outcome.detail.includes(SHA));
    assert.match(outcome.detail, /is the expected head/);
  });

  it("passes when the operator supplies an abbreviated sha for the same commit", () => {
    const outcome = evaluateReleaseDrift(
      expectation({ MONITOR_EXPECTED_SHA: SHA.slice(0, 8) }),
      response(200, versionBody("backend", SHA)),
      NOW,
    );

    assert.equal(outcome.state, "pass");
  });

  it("warns without failing while a deploy is still plausibly in flight", () => {
    const outcome = evaluateReleaseDrift(
      expectation({ MONITOR_EXPECTED_SHA_TIME: FRESH_COMMIT }),
      response(200, versionBody("backend", SHA)),
      NOW,
    );

    assert.equal(outcome.state, "warn");
    assert.match(outcome.detail, /still in flight/);
    assert.equal(summarise([outcome]).failed, false);
  });

  it("honours a configured allowance", () => {
    const outcome = evaluateReleaseDrift(
      expectation({ MONITOR_EXPECTED_SHA_TIME: FRESH_COMMIT, MONITOR_MAX_DRIFT_MINUTES: "2" }),
      response(200, versionBody("backend", SHA)),
      NOW,
    );

    assert.equal(outcome.state, "fail");
    assert.match(outcome.detail, /2-min allowance/);
  });

  /**
   * The guard that matters.
   *
   * "The shas differ" and "the version endpoint could not be read" are
   * different events. Reporting them the same way is the exact error pattern
   * this project exists to refuse — an unreadable source rendering as a
   * confident claim. Every branch below must be `blocked`, must say so, and
   * must never say the release drifted.
   */
  describe("cannot determine ≠ drift", () => {
    const cases: Array<[string, ProbeResult, RegExp]> = [
      ["the endpoint never answered", unreachable("connect ECONNREFUSED 10.0.0.1:443"), /ECONNREFUSED/],
      ["the endpoint answered 502", response(502, "<html>bad gateway</html>"), /HTTP 502/],
      ["the body is not JSON", response(200, "<!doctype html><title>oops</title>"), /not JSON/],
      ["the body is JSON but not an object", response(200, "[1,2,3]"), /not a JSON object/],
      ["the payload carries no sha", response(200, JSON.stringify({ service: "backend" })), /no `sha` string/],
      ["the sha is empty", response(200, versionBody("backend", "   ")), /no `sha` string/],
      // An unstamped image serves "unknown" on purpose. Two absences that
      // happen to be equal are not a verified deploy.
      ["the image carries no build stamp", response(200, versionBody("backend", "unknown")), /no build stamp/],
    ];

    for (const [label, probe, reason] of cases) {
      it(`is blocked, not a drift failure, when ${label}`, () => {
        const outcome = evaluateReleaseDrift(expectation(), probe, NOW);

        assert.equal(outcome.state, "blocked");
        assert.match(outcome.detail, reason);
        assert.match(outcome.detail, /drift is unknown/);
        assert.match(outcome.detail, /not a pass/);
        // Never the drift wording, and never a live sha it did not read.
        assert.doesNotMatch(outcome.detail, /has not landed/);
        assert.ok(!outcome.detail.includes(SHA), `invented a live sha in: ${outcome.detail}`);
        // It still says what it was looking for, so the reader can act.
        assert.ok(outcome.detail.includes(OTHER_SHA));
      });
    }

    it("is blocked when no expected head was supplied at all", () => {
      const outcome = evaluateReleaseDrift(
        readReleaseExpectation({}),
        response(200, versionBody("backend", SHA)),
        NOW,
      );

      assert.equal(outcome.state, "blocked");
      assert.match(outcome.detail, /MONITOR_EXPECTED_SHA is not set/);
      assert.match(outcome.detail, /not a pass/i);
    });

    it("is blocked rather than defaulting when the expected head is not a sha", () => {
      const outcome = evaluateReleaseDrift(
        readReleaseExpectation({ MONITOR_EXPECTED_SHA: "refs/heads/main" }),
        response(200, versionBody("backend", SHA)),
        NOW,
      );

      assert.equal(outcome.state, "blocked");
      assert.match(outcome.detail, /not a commit sha/);
    });

    it("is blocked rather than silently using the default allowance when the allowance is garbage", () => {
      const outcome = evaluateReleaseDrift(
        expectation({ MONITOR_MAX_DRIFT_MINUTES: "half an hour" }),
        response(200, versionBody("backend", SHA)),
        NOW,
      );

      assert.equal(outcome.state, "blocked");
      assert.match(outcome.detail, /MONITOR_MAX_DRIFT_MINUTES/);
    });

    it("is blocked, with both shas, when the shas differ but the drift cannot be aged", () => {
      for (const time of [undefined, "yesterday-ish"]) {
        const outcome = evaluateReleaseDrift(
          expectation({ MONITOR_EXPECTED_SHA_TIME: time }),
          response(200, versionBody("backend", SHA)),
          NOW,
        );

        assert.equal(outcome.state, "blocked");
        assert.ok(outcome.detail.includes(SHA));
        assert.ok(outcome.detail.includes(OTHER_SHA));
        assert.match(outcome.detail, /MONITOR_EXPECTED_SHA_TIME/);
        assert.match(outcome.detail, /not a pass/i);
      }
    });
  });

  it("reads the environment with a measured default allowance", () => {
    const parsed = readReleaseExpectation({ MONITOR_EXPECTED_SHA: SHA });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.maxDriftMinutes, DEFAULT_MAX_DRIFT_MINUTES);
    assert.equal(parsed.ok && parsed.committedAt, null);
  });

  it("counts a blocked check separately from a pass, and does not fail the run on it", () => {
    const summary = summarise([
      { name: "health", state: "pass", detail: "200, database connected" },
      evaluateReleaseDrift(expectation(), unreachable("socket hang up"), NOW),
    ]);

    assert.equal(summary.failed, false);
    assert.equal(summary.blocked.length, 1);
    assert.equal(summary.warnings.length, 0);
    assert.match(summary.lines[1], /^BLOCKED {2}release-drift: /);
  });
});

/**
 * The settle — the deploy-pipeline race, closed.
 *
 * `deploy.yml` runs the drift check with a zero allowance, and the step before
 * it polls `/api/health` and exits on the FIRST 200. That 200 can be answered by
 * the old container while the compose swap is still finishing, so a perfectly
 * good deploy could read a stale sha once and turn the pipeline red. Raising the
 * allowance cannot help: drift is aged from the commit time, which is already
 * ~12 minutes old by then.
 *
 * Everything below asserts both halves of the bargain — a swap in progress
 * settles to a pass, and a release that genuinely did not land still fails.
 */
describe("external monitor — the settle", () => {
  const OLD_COMMIT = "2026-08-10T02:30:00.000Z";
  /** What `deploy.yml` sees: the head was committed twelve minutes ago. */
  const TWELVE_MINUTES_AGO = "2026-08-10T03:48:00.000Z";

  function expectation(overrides: Record<string, string | undefined> = {}) {
    return readReleaseExpectation({
      MONITOR_EXPECTED_SHA: OTHER_SHA,
      MONITOR_EXPECTED_SHA_TIME: OLD_COMMIT,
      ...overrides,
    });
  }

  /** The old container's answer, and the new one's. */
  const STALE = () => response(200, versionBody("backend", SHA));
  const LANDED = () => response(200, versionBody("backend", OTHER_SHA));

  /** A re-reader that hands back a scripted sequence, and counts its calls. */
  function reader(sequence: Array<() => ProbeResult>) {
    const calls: number[] = [];
    const waits: number[] = [];
    return {
      calls,
      waits,
      wait: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
      read: () => {
        const next = sequence[calls.length] ?? sequence[sequence.length - 1];
        calls.push(1);
        return Promise.resolve(next());
      },
    };
  }

  it("does not re-read at all when the first read is already the expected head", async () => {
    const r = reader([STALE]);
    const outcome = await resolveReleaseDrift(
      expectation({ MONITOR_EXPECTED_SHA: SHA }),
      STALE(),
      r.read,
      NOW,
      r.wait,
    );

    assert.equal(outcome.state, "pass");
    assert.equal(r.calls.length, 0, "a match must cost nothing");
    // No retry wording, so an operator can tell this from a settled deploy.
    assert.doesNotMatch(outcome.detail, /re-read/i);
    assert.doesNotMatch(outcome.detail, /settled/i);
  });

  it("settles the deploy-pipeline race: the swap finishes on the second read", async () => {
    const r = reader([LANDED]);
    const outcome = await resolveReleaseDrift(
      // deploy.yml exactly: zero allowance, head committed twelve minutes ago.
      expectation({ MONITOR_MAX_DRIFT_MINUTES: "0", MONITOR_EXPECTED_SHA_TIME: TWELVE_MINUTES_AGO }),
      STALE(),
      r.read,
      NOW,
      r.wait,
    );

    assert.equal(outcome.state, "pass", `a finished swap must not fail the deploy: ${outcome.detail}`);
    assert.equal(r.calls.length, 1);
    assert.match(outcome.detail, /settled after 1 re-read/);
    assert.equal(summarise([outcome]).failed, false);
  });

  it("says how many re-reads it took, so a settled deploy is not read as a first-read match", async () => {
    const r = reader([STALE, STALE, LANDED]);
    const outcome = await resolveReleaseDrift(expectation(), STALE(), r.read, NOW, r.wait);

    assert.equal(outcome.state, "pass");
    assert.equal(r.calls.length, 3);
    assert.match(outcome.detail, /settled after 3 re-read\(s\)/);
    assert.match(outcome.detail, /10s apart/);
  });

  it("still FAILS a drift that persists across every re-read", async () => {
    const r = reader([STALE]);
    const outcome = await resolveReleaseDrift(expectation(), STALE(), r.read, NOW, r.wait);

    assert.equal(outcome.state, "fail");
    assert.equal(r.calls.length, DEFAULT_SETTLE_ATTEMPTS, "the settle must be bounded");
    assert.match(outcome.detail, /has not landed/);
    assert.match(outcome.detail, /Re-read \/api\/version 3 time\(s\)/);
    assert.match(outcome.detail, /did not change/);
    // Both shas survive the annotation — they are the first thing anyone needs.
    assert.ok(outcome.detail.includes(SHA));
    assert.ok(outcome.detail.includes(OTHER_SHA));
  });

  it("keeps a warn a warn when the drift is inside the allowance", async () => {
    const r = reader([STALE]);
    const outcome = await resolveReleaseDrift(
      expectation({ MONITOR_EXPECTED_SHA_TIME: "2026-08-10T03:55:00.000Z" }),
      STALE(),
      r.read,
      NOW,
      r.wait,
    );

    assert.equal(outcome.state, "warn");
    assert.match(outcome.detail, /Re-read \/api\/version 3 time\(s\)/);
  });

  it("never re-reads a first read that could not be read, and stays blocked", async () => {
    const r = reader([LANDED]);
    const outcome = await resolveReleaseDrift(
      expectation(),
      unreachable("connect ECONNREFUSED 10.0.0.1:443"),
      r.read,
      NOW,
      r.wait,
    );

    assert.equal(outcome.state, "blocked", "a retry loop must not turn `cannot read` into anything else");
    assert.equal(r.calls.length, 0);
    assert.match(outcome.detail, /drift is unknown/);
  });

  it("does not re-read when there is no expected head to compare against", async () => {
    const r = reader([LANDED]);
    const outcome = await resolveReleaseDrift(readReleaseExpectation({}), STALE(), r.read, NOW, r.wait);

    assert.equal(outcome.state, "blocked");
    assert.equal(r.calls.length, 0);
  });

  it("does not let an unreadable re-read overturn the mismatch it already saw", async () => {
    const r = reader([() => unreachable("socket hang up")]);
    const outcome = await resolveReleaseDrift(expectation(), STALE(), r.read, NOW, r.wait);

    // An absence does not erase an observation. The mismatch was read cleanly.
    assert.equal(outcome.state, "fail");
    assert.equal(r.calls.length, 1, "no point re-reading past an unreadable endpoint");
    assert.match(outcome.detail, /came back unreadable/);
    assert.match(outcome.detail, /has not landed/);
  });

  it("honours a configured settle count and delay", async () => {
    const r = reader([STALE]);
    const outcome = await resolveReleaseDrift(
      expectation({ MONITOR_SETTLE_ATTEMPTS: "1", MONITOR_SETTLE_DELAY_MS: "250" }),
      STALE(),
      r.read,
      NOW,
      r.wait,
    );

    assert.equal(outcome.state, "fail");
    assert.deepEqual(r.waits, [250]);
    assert.match(outcome.detail, /Re-read \/api\/version 1 time\(s\) 0.3s apart/);
  });

  it("can be switched off entirely with a zero settle count", async () => {
    const r = reader([LANDED]);
    const outcome = await resolveReleaseDrift(
      expectation({ MONITOR_SETTLE_ATTEMPTS: "0" }),
      STALE(),
      r.read,
      NOW,
      r.wait,
    );

    assert.equal(outcome.state, "fail");
    assert.equal(r.calls.length, 0);
    assert.doesNotMatch(outcome.detail, /Re-read/);
  });

  it("is blocked rather than guessing when the settle configuration is garbage", async () => {
    for (const bad of [
      { MONITOR_SETTLE_ATTEMPTS: "a few" },
      { MONITOR_SETTLE_ATTEMPTS: "-1" },
      { MONITOR_SETTLE_DELAY_MS: "ten seconds" },
    ]) {
      const r = reader([LANDED]);
      const outcome = await resolveReleaseDrift(expectation(bad), STALE(), r.read, NOW, r.wait);

      assert.equal(outcome.state, "blocked", `expected blocked for ${JSON.stringify(bad)}`);
      assert.equal(r.calls.length, 0);
      assert.match(outcome.detail, /MONITOR_SETTLE_/);
    }
  });

  it("defaults to a bounded, cheap settle", () => {
    const parsed = readReleaseExpectation({ MONITOR_EXPECTED_SHA: SHA });
    assert.equal(parsed.ok && parsed.settleAttempts, DEFAULT_SETTLE_ATTEMPTS);
    assert.equal(parsed.ok && parsed.settleDelayMs, DEFAULT_SETTLE_DELAY_MS);
    // Thirty seconds in the worst case, and only ever on a mismatch. Matching
    // deploy-aws-ssm.sh's own 10 × 3s host-side version poll.
    assert.equal(DEFAULT_SETTLE_ATTEMPTS * DEFAULT_SETTLE_DELAY_MS, 30_000);
  });
});

/**
 * The version check's half of the same race — G2d.
 *
 * The backend and frontend images roll independently, so a probe landing mid-swap
 * catches one rolled and the other not, and `evaluateVersion` judged that from a
 * single first read: a confident "half-finished rollout" about a deploy that was
 * simply in progress. `deploy.yml` runs this monitor, so that is a red pipeline on
 * a good deploy.
 *
 * The settle is the drift check's, reused rather than rewritten, so the same
 * three refusals are asserted here: a persistent skew still fails, an unreadable
 * reading is never converted into a skew or out of one, and a first-read
 * agreement costs nothing.
 */
describe("external monitor — the version settle", () => {
  /** Mid-swap: the backend has rolled, the frontend has not. */
  const SKEWED = (): { api: ProbeResult; web: ProbeResult } => ({
    api: response(200, versionBody("backend", OTHER_SHA)),
    web: response(200, versionBody("frontend", SHA)),
  });
  /** Both images on the new commit. */
  const ROLLED = (): { api: ProbeResult; web: ProbeResult } => ({
    api: response(200, versionBody("backend", OTHER_SHA)),
    web: response(200, versionBody("frontend", OTHER_SHA)),
  });

  function reader(sequence: Array<() => { api: ProbeResult; web: ProbeResult }>) {
    const calls: number[] = [];
    const waits: number[] = [];
    return {
      calls,
      waits,
      wait: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
      read: () => {
        const next = sequence[calls.length] ?? sequence[sequence.length - 1];
        calls.push(1);
        return Promise.resolve(next());
      },
    };
  }

  const policy = readSettlePolicy({});

  it("does not re-read at all when the two images already agree", async () => {
    const r = reader([SKEWED]);
    const outcome = await resolveVersionSkew(policy, ROLLED(), r.read, r.wait);

    assert.equal(outcome.state, "pass");
    assert.equal(r.calls.length, 0, "an agreement must cost nothing");
    assert.deepEqual(r.waits, []);
    assert.doesNotMatch(outcome.detail, /re-read/i);
    assert.doesNotMatch(outcome.detail, /settled/i);
  });

  it("settles the mid-swap race: the frontend rolls on the second read", async () => {
    const r = reader([ROLLED]);
    const outcome = await resolveVersionSkew(policy, SKEWED(), r.read, r.wait);

    assert.equal(outcome.state, "pass", `a finished swap must not fail the deploy: ${outcome.detail}`);
    assert.equal(r.calls.length, 1);
    assert.match(outcome.detail, /settled after 1 re-read/);
    assert.match(outcome.detail, /\/api\/version and \/version\.json/);
    assert.match(outcome.detail, /10s apart/);
    assert.equal(summarise([outcome]).failed, false);
  });

  it("says how many re-reads it took, so a settled deploy is not read as a first-read match", async () => {
    const r = reader([SKEWED, SKEWED, ROLLED]);
    const outcome = await resolveVersionSkew(policy, SKEWED(), r.read, r.wait);

    assert.equal(outcome.state, "pass");
    assert.equal(r.calls.length, 3);
    assert.match(outcome.detail, /settled after 3 re-read\(s\)/);
  });

  it("still FAILS a skew that persists across every re-read", async () => {
    const r = reader([SKEWED]);
    const outcome = await resolveVersionSkew(policy, SKEWED(), r.read, r.wait);

    assert.equal(outcome.state, "fail");
    assert.equal(r.calls.length, DEFAULT_SETTLE_ATTEMPTS, "the settle must be bounded");
    assert.match(outcome.detail, /version skew/);
    assert.match(outcome.detail, /Re-read \/api\/version and \/version\.json 3 time\(s\)/);
    assert.match(outcome.detail, /still disagree/);
    // Both shas survive the annotation.
    assert.match(outcome.detail, /1fb246f/);
    assert.match(outcome.detail, /9004d34/);
    assert.equal(summarise([outcome]).failed, true);
  });

  describe("cannot read ≠ skew", () => {
    const unreadable: Array<[string, { api: ProbeResult; web: ProbeResult }, RegExp]> = [
      [
        "the backend answered 502 — last night exactly",
        { api: response(502, "Bad Gateway"), web: response(200, versionBody("frontend", SHA)) },
        /\/api\/version: HTTP 502/,
      ],
      [
        "the frontend document never arrived",
        {
          api: response(200, versionBody("backend", SHA)),
          web: unreachable("connect ECONNREFUSED 10.0.0.1:443"),
        },
        /ECONNREFUSED/,
      ],
      [
        "a version document is not JSON",
        { api: response(200, "not json at all"), web: response(200, versionBody("frontend", SHA)) },
        /not JSON/,
      ],
      [
        "the images carry no build stamp",
        {
          api: response(200, versionBody("backend", "unknown")),
          web: response(200, versionBody("frontend", "unknown")),
        },
        /no build stamp/,
      ],
    ];

    for (const [label, reading, reason] of unreadable) {
      it(`does not re-read, and does not call it a skew, when ${label}`, async () => {
        const r = reader([ROLLED]);
        const outcome = await resolveVersionSkew(policy, reading, r.read, r.wait);

        assert.equal(outcome.state, "fail");
        assert.equal(r.calls.length, 0, "an unreadable reading is not a mismatch to settle");
        assert.match(outcome.detail, reason);
        assert.doesNotMatch(outcome.detail, /version skew/);
        assert.doesNotMatch(outcome.detail, /Re-read/);
      });
    }

    it("does not let an unreadable re-read overturn the skew it already saw", async () => {
      const r = reader([
        () => ({ api: response(200, versionBody("backend", OTHER_SHA)), web: unreachable("socket hang up") }),
      ]);
      const outcome = await resolveVersionSkew(policy, SKEWED(), r.read, r.wait);

      // An absence does not erase an observation. The skew was read cleanly.
      assert.equal(outcome.state, "fail");
      assert.equal(r.calls.length, 1, "no point re-reading past an unreadable endpoint");
      assert.match(outcome.detail, /came back unreadable/);
      assert.match(outcome.detail, /version skew/);
    });
  });

  it("honours a configured settle count and delay, shared with the drift check", async () => {
    const r = reader([SKEWED]);
    const outcome = await resolveVersionSkew(
      readSettlePolicy({ MONITOR_SETTLE_ATTEMPTS: "1", MONITOR_SETTLE_DELAY_MS: "250" }),
      SKEWED(),
      r.read,
      r.wait,
    );

    assert.equal(outcome.state, "fail");
    assert.deepEqual(r.waits, [250]);
    assert.match(outcome.detail, /1 time\(s\) 0\.3s apart/);
  });

  it("can be switched off entirely with a zero settle count", async () => {
    const r = reader([ROLLED]);
    const outcome = await resolveVersionSkew(
      readSettlePolicy({ MONITOR_SETTLE_ATTEMPTS: "0" }),
      SKEWED(),
      r.read,
      r.wait,
    );

    assert.equal(outcome.state, "fail");
    assert.equal(r.calls.length, 0);
    assert.doesNotMatch(outcome.detail, /Re-read/);
  });

  it("keeps an observed skew a failure when the settle configuration is garbage", async () => {
    // Unlike the drift check's `blocked` — where a missing expected head means
    // nothing was ever compared — the skew here was genuinely read. A typo in an
    // environment variable must not be able to silence a half-rolled stack.
    for (const bad of [{ MONITOR_SETTLE_ATTEMPTS: "a few" }, { MONITOR_SETTLE_DELAY_MS: "ten seconds" }]) {
      const r = reader([ROLLED]);
      const outcome = await resolveVersionSkew(readSettlePolicy(bad), SKEWED(), r.read, r.wait);

      assert.equal(outcome.state, "fail", `expected a failure for ${JSON.stringify(bad)}`);
      assert.equal(r.calls.length, 0);
      assert.match(outcome.detail, /version skew/);
      assert.match(outcome.detail, /MONITOR_SETTLE_/);
      assert.match(outcome.detail, /did not run/);
    }
  });

  it("reads one settle policy for both checks", () => {
    const parsed = readSettlePolicy({});
    assert.equal(parsed.ok && parsed.policy.attempts, DEFAULT_SETTLE_ATTEMPTS);
    assert.equal(parsed.ok && parsed.policy.delayMs, DEFAULT_SETTLE_DELAY_MS);

    // The same two variables the drift check reads, so the two settles cannot
    // disagree about how long a deploy is allowed to take.
    const configured = readReleaseExpectation({
      MONITOR_EXPECTED_SHA: SHA,
      MONITOR_SETTLE_ATTEMPTS: "2",
      MONITOR_SETTLE_DELAY_MS: "1500",
    });
    const shared = readSettlePolicy({ MONITOR_SETTLE_ATTEMPTS: "2", MONITOR_SETTLE_DELAY_MS: "1500" });
    assert.equal(configured.ok && configured.settleAttempts, shared.ok && shared.policy.attempts);
    assert.equal(configured.ok && configured.settleDelayMs, shared.ok && shared.policy.delayMs);
  });
});

describe("external monitor — the alert", () => {
  const context = {
    baseUrl: "https://commissionwatch.bmux.sh",
    runUrl: "https://gitea.example.invalid/your-org/commissionwatch/actions/runs/1",
    checkedAt: "2026-08-10T04:00:00.000Z",
  };

  it("says it bypassed the application's routing, and why", () => {
    const summary = summarise([{ name: "health", state: "fail", detail: "HTTP 502" }]);
    const message = buildAlertMessage(summary, context);
    assert.match(message, /bypassing the application's delivery routing/);
    assert.match(message, /cannot be trusted to report its own outage/);
    assert.match(message, /HTTP 502/);
    assert.match(message, /runs\/1/);
  });

  it("labels a blocked check as undetermined rather than listing it as a finding", () => {
    const summary = summarise([
      { name: "health", state: "fail", detail: "HTTP 502" },
      { name: "release-drift", state: "blocked", detail: "the live sha could not be read — not a pass" },
    ]);
    const message = buildAlertMessage(summary, context);

    assert.match(message, /1 failing check/);
    assert.match(message, /\(blocked — could not be determined\) release-drift/);
  });

  it("truncates visibly rather than being rejected by Discord", () => {
    const many: CheckOutcome[] = [];
    for (let i = 0; i < 200; i += 1) {
      many.push({ name: `source:adapter-${i}`, state: "fail", detail: "stale: last successful sweep 900 h ago" });
    }
    const message = buildAlertMessage(summarise(many), context);
    assert.ok(message.length <= DISCORD_CONTENT_LIMIT);
    assert.match(message, /truncated/);
  });
});

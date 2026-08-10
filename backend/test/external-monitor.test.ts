import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAlertMessage,
  DISCORD_CONTENT_LIMIT,
  evaluateHealth,
  evaluateSource,
  evaluateSources,
  evaluateVersion,
  summarise,
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
function response(status: number, body: string): ProbeResult {
  return { url: "https://example.test/probe", status, body, error: null, attempts: 1 };
}

/** A request that never produced a response at all. */
function unreachable(error: string): ProbeResult {
  return { url: "https://example.test/probe", status: null, body: "", error, attempts: 2 };
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

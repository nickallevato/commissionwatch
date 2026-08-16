import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * `deploy/backup.sh` is shell, so it gets no execution test here — that would
 * mean docker, Postgres and MinIO containers running under `node --test`,
 * which is out of scope for this suite. What can be tested from the backend is
 * the text of the script itself, the same technique
 * `workflow-monitor-env.test.ts` uses for the Gitea workflows: read the file
 * as an artefact and assert the properties that must not regress.
 *
 * The two properties this guards, both from the 2026-08-16 maturity review
 * (finding 6.1, ranked highest-risk): an archive that never leaves the
 * instance is a copy, not a backup, and a script that reports success on a
 * failed upload is worse than a script that never uploads at all. Concretely:
 *
 *   1. An unset `BACKUP_S3_URI` must not let the script exit 0 silently — it
 *      must exit non-zero AND emit a critical ops event, so either a cron/
 *      monitor watching the exit code or a delivery channel watching the
 *      dispatcher notices.
 *   2. The `aws s3 cp` upload path must check its own exit status rather than
 *      trusting `set -e` alone to catch it silently, and must verify the
 *      object landed with a second, independent read.
 */

const SCRIPT = readFileSync(
  path.resolve(__dirname, "..", "..", "deploy", "backup.sh"),
  "utf8",
);

describe("deploy/backup.sh: off-instance backup cannot silently succeed", () => {
  it("sets OFFSITE_MISSING when BACKUP_S3_URI is unset", () => {
    const unsetBranch = SCRIPT.split(/else\b/).pop() ?? "";
    // Loose on exact shell shape, but the unset branch must flip the flag that
    // drives both the ops event and the non-zero exit below.
    assert.match(
      SCRIPT,
      /if \[ -n "\$\{BACKUP_S3_URI:-\}" \]; then[\s\S]*?\belse\b[\s\S]*?OFFSITE_MISSING=1/,
      "the unset-BACKUP_S3_URI branch no longer sets OFFSITE_MISSING=1 — an " +
        "unconfigured host could report success without anyone deciding that " +
        "on purpose",
    );
    assert.ok(unsetBranch.length > 0, "sanity: script has an else branch at all");
  });

  it("exits non-zero when the offsite leg is missing, distinct from other failure paths", () => {
    assert.match(
      SCRIPT,
      /if \[ "\$OFFSITE_MISSING" -eq 1 \][\s\S]*?exit 60/,
      "no non-zero exit is reached when OFFSITE_MISSING is 1 — a cron or " +
        "monitor watching this job's exit code would see 0 every night on an " +
        "unconfigured host, which is the exact failure mode ('a quiet log " +
        "line') the maturity review found",
    );
  });

  it("emits a critical ops event when the offsite leg is missing", () => {
    assert.match(
      SCRIPT,
      /OFFSITE_MISSING" -eq 1 \][\s\S]*?emit "ops\.backup_offsite_missing"[\s\S]*?critical/,
      "ops.backup_offsite_missing is no longer emitted at critical severity " +
        "when the archive stays instance-only — the disclosure path a reader " +
        "would already be watching (ops.backup_failed's channel) goes silent " +
        "for this condition",
    );
  });

  it("never exits 0 immediately after logging the unset warning without a later exit check", () => {
    // Regression guard against reverting to the original shape: a bare `log`
    // call with no flag set and no later exit check.
    const unsetLogIndex = SCRIPT.indexOf(
      "BACKUP_S3_URI is unset; the archive has NOT left the instance",
    );
    assert.notEqual(unsetLogIndex, -1, "the unset-case log message was removed or reworded");
    const tail = SCRIPT.slice(unsetLogIndex);
    assert.match(
      tail,
      /exit 60/,
      "nothing after the unset-BACKUP_S3_URI log line causes a non-zero exit",
    );
  });
});

describe("deploy/backup.sh: the upload path checks its own exit status", () => {
  it("does not run `aws s3 cp` unguarded", () => {
    // `set -e` alone catching a failed cp is exactly the fragile assumption
    // the task calls out — the exit status must be checked explicitly (an
    // `if`/`if !` around the call), not merely relied upon via the script's
    // global `set -e`.
    assert.match(
      SCRIPT,
      /if !.*aws s3 cp/,
      "aws s3 cp is no longer explicitly guarded with an exit-status check — " +
        "a script that only relies on `set -e` here can still report success " +
        "on a failed upload depending on how the call is composed",
    );
  });

  it("verifies the object landed with a second, independent read after the upload", () => {
    assert.match(
      SCRIPT,
      /aws s3 ls "\$DEST"/,
      "no verification read (`aws s3 ls`) exists after `aws s3 cp` — a cp " +
        "that exits 0 is not proof the object exists at the destination",
    );
  });

  it("treats a failed or unverified upload as OFFSITE_MISSING, not as a silent success", () => {
    assert.match(
      SCRIPT,
      /UPLOAD_OK=0[\s\S]*?OFFSITE_MISSING=1/,
      "a failed/unverified upload no longer flows into OFFSITE_MISSING — it " +
        "could report ops.backup_succeeded with a false offsite location and " +
        "exit 0",
    );
  });

  it("never echoes the S3 target from a CLI argument — it is read from the environment", () => {
    assert.doesNotMatch(
      SCRIPT,
      /BACKUP_S3_URI=.*\$1|--s3-uri|--bucket\s+"\$1"/,
      "BACKUP_S3_URI must be read from the environment, not accepted as a " +
        "positional/flag argument",
    );
    assert.match(
      SCRIPT,
      /\$\{BACKUP_S3_URI:-\}/,
      "BACKUP_S3_URI is no longer read from the environment",
    );
  });
});

describe("deploy/backup.sh: retention and restore are documented in the header", () => {
  it("states retention counts", () => {
    assert.match(SCRIPT, /RETENTION:/, "no RETENTION section in the header");
    assert.match(SCRIPT, /7 daily/i);
    assert.match(SCRIPT, /4 weekly/i);
  });

  it("states how a restore is performed and what has actually been tested", () => {
    assert.match(SCRIPT, /RESTORE:/, "no RESTORE section in the header");
    assert.match(
      SCRIPT,
      /restore-drill\.sh/,
      "the header no longer points at the script that performs a restore",
    );
    // Must distinguish tested from untested, not just assert a restore "works".
    assert.match(
      SCRIPT,
      /has been run|has NOT been exercised|untested/i,
      "the header states a restore capability without saying what was and " +
        "was not actually tested",
    );
  });
});

/**
 * 2026-08-16 maturity review, finding H1: `deploy/Caddyfile` routed `/api/*`
 * straight to the backend, bypassing nginx. That was harmless while Helmet
 * carried its own copies of the security headers; once 6.4 removed them on
 * the stated ground that "nginx is the one layer in the request path for
 * BOTH" (`backend/src/app.ts`, `frontend/nginx.conf`), a Caddyfile that split
 * `/api/*` off from nginx would have shipped every API response with no CSP,
 * no HSTS, no `X-Frame-Options`. Nothing consumed the file
 * (`grep -rn "Caddyfile" deploy/*.sh deploy/*.yml .gitea/workflows/*.yml` —
 * verified empty), it used the local-dev container name
 * (`commissionwatch-frontend`) rather than production's
 * (`commissionwatch-web`), and `deploy/README.md`'s own §5 already described
 * the real, live edge as a single `reverse_proxy commissionwatch-web:3000`
 * for the whole host, applied entirely outside this repository in
 * `your-org/platform-aws`. The file was a stale orphan, not a template
 * anything applies, so it was deleted rather than corrected.
 *
 * This is the guard against it — or anything shaped like it — coming back.
 * Same technique `workflow-monitor-env.test.ts` and this file's own header
 * comment use: read the artefact as text, because no YAML/Caddyfile parser is
 * a backend dependency and adding one so a guard can run is how a guard
 * acquires a reason not to run.
 */
describe("deploy/ edge config cannot route /api/* around nginx", () => {
  it("no Caddyfile exists in deploy/", () => {
    // The guard for "stayed deleted", per the maturity review's instruction:
    // if a Caddyfile is ever reintroduced, the next two assertions inspect
    // it; until then, its absence is the property being guarded.
    const exists = existsSync(path.resolve(__dirname, "..", "..", "deploy", "Caddyfile"));
    assert.equal(
      exists,
      false,
      "deploy/Caddyfile has reappeared. Before adding one back: does it route " +
        "/api/* through the same upstream as the HTML document (today, " +
        "production's single `reverse_proxy commissionwatch-web:3000` for the " +
        "whole host)? A Caddyfile that gives /api/* its own upstream would " +
        "bypass nginx, and nginx is the only thing that sets the security " +
        "headers now that Helmet's copies are gone (backend/src/app.ts, " +
        "6.4). If you are adding a real one back, also update this test to " +
        "assert the property on it rather than deleting the guard.",
    );
  });

  it("no committed deploy script or workflow references a Caddyfile", () => {
    // Regression guard for the fact that found it in the first place: a
    // Caddyfile that nothing applies is exactly how the stale one went
    // unnoticed. If something starts consuming a Caddyfile again, that is a
    // deliberate enough change that this test should be revisited by name,
    // not silently defeated by adding the reference.
    const deployDir = path.resolve(__dirname, "..", "..", "deploy");
    const workflowsDir = path.resolve(__dirname, "..", "..", ".gitea", "workflows");
    const candidates = [
      ...readdirSync(deployDir)
        .filter((f) => (f.endsWith(".sh") || f.endsWith(".yml")) && f !== "Caddyfile")
        .map((f) => path.join(deployDir, f)),
      ...readdirSync(workflowsDir)
        .filter((f) => f.endsWith(".yml"))
        .map((f) => path.join(workflowsDir, f)),
    ];

    const offenders = candidates.filter((file) => readFileSync(file, "utf8").includes("Caddyfile"));
    assert.deepEqual(
      offenders,
      [],
      `these files reference a Caddyfile this repository does not apply: ${offenders.join(", ")}`,
    );
  });
});

describe("ops-events: the new event exists and defaults to critical", () => {
  it("OPS_EVENTS includes ops.backup_offsite_missing", async () => {
    const { OPS_EVENTS, parseOpsEventArgs } = await import(
      "../src/services/delivery/ops-events"
    );
    assert.ok(
      (OPS_EVENTS as readonly string[]).includes("ops.backup_offsite_missing"),
      "ops.backup_offsite_missing must be a declared, routable event",
    );
    const args = parseOpsEventArgs(["--event", "ops.backup_offsite_missing"]);
    assert.equal(
      args.severity,
      "critical",
      "ops.backup_offsite_missing must default to critical even without an " +
        "explicit --severity, since a caller forgetting the flag must not " +
        "silently downgrade it",
    );
  });
});

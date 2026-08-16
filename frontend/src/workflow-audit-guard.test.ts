import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `npm audit` for this package is not run anywhere unless a CI step calls it.
 * On 2026-08-16 three moderate advisories in react-router / react-router-dom
 * (via @remix-run/router) shipped on every page of the public SPA, silently,
 * because nothing checked. The fix was a version bump; the guard against a
 * repeat is this test plus the CI step it verifies.
 *
 * `--omit=dev` is deliberate: a dev-only advisory never reaches a reader, and
 * failing CI on one would train everyone to ignore the check. `--audit-level=
 * high` is deliberate too: it lets moderates through without blocking, but
 * a high or critical advisory in a shipped dependency must fail the build.
 *
 * This is a text test on purpose, the same technique
 * `backend/test/workflow-monitor-env.test.ts` uses: no YAML parser is a
 * frontend dependency, and adding one so this guard can run is how the guard
 * acquires a reason not to run. The workflow is read from disk as the
 * artefact it is.
 */

const WORKFLOW = join(__dirname, "..", "..", ".gitea", "workflows", "deploy.yml");

function readWorkflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

/** The `ci-frontend` job's block, scoped so a matching step in another job cannot satisfy the assertion. */
function ciFrontendJob(yaml: string): string {
  const start = yaml.indexOf("ci-frontend:");
  expect(start, ".gitea/workflows/deploy.yml no longer has a ci-frontend job").not.toBe(-1);
  // Next top-level (2-space-indented) job key after ci-frontend marks the end.
  const rest = yaml.slice(start + "ci-frontend:".length);
  const nextJobMatch = rest.match(/\n {2}\S[^\n]*:\n/);
  const end = nextJobMatch ? start + "ci-frontend:".length + nextJobMatch.index! : yaml.length;
  return yaml.slice(start, end);
}

describe("frontend CI audits production dependencies", () => {
  it("the ci-frontend job runs npm audit scoped to production dependencies", () => {
    const job = ciFrontendJob(readWorkflow());
    expect(
      job,
      "ci-frontend no longer runs `npm audit --omit=dev`. Without it, an advisory in a " +
        "dependency that ships to the public site can accumulate silently again, exactly as " +
        "the 2026-08-16 react-router advisories did.",
    ).toMatch(/npm audit\b[^\n]*--omit=dev|npm audit\b[^\n]*--omit dev/);
  });

  it("the audit step fails only on high or critical advisories, not moderate", () => {
    const job = ciFrontendJob(readWorkflow());
    expect(
      job,
      "ci-frontend's npm audit step no longer sets --audit-level=high. Without it, an " +
        "audit step either fails the build on every moderate (and gets disabled the first " +
        "time that's inconvenient) or checks nothing at all.",
    ).toMatch(/npm audit\b[^\n]*--audit-level=high/);
  });

  it("the audit step runs in the frontend working directory", () => {
    const job = ciFrontendJob(readWorkflow());
    const auditIndex = job.search(/npm audit\b/);
    expect(auditIndex, "no npm audit invocation found in ci-frontend").not.toBe(-1);
    const before = job.slice(0, auditIndex);
    const lastWorkingDir = [...before.matchAll(/working-directory:\s*(\S+)/g)].pop();
    expect(
      lastWorkingDir?.[1],
      "the npm audit step is not scoped to working-directory: frontend",
    ).toBe("frontend");
  });
});

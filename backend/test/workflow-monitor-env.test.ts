import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The workflows must keep handing the monitor its expected head.
 *
 * `evaluateReleaseDrift` reports **BLOCKED** when `MONITOR_EXPECTED_SHA` is
 * missing, and a blocked check deliberately does not fail the run — because "we
 * could not tell" must not page anybody. The cost of that correct decision is
 * that the release-drift check can be **silently switched off by an unrelated
 * YAML edit**: drop one line from a workflow and every run stays green while the
 * check that exists to catch a release that stopped landing quietly stops
 * running. Nothing else in this repository would notice.
 *
 * So the workflows are read from disk here as the artefacts they are. Both
 * variables are checked in both places they have to appear, because supplying
 * one without the other is exactly the silent failure:
 *
 * - **supplied to the step** — as a `env:` mapping entry, or assigned in the
 *   step's own shell (`deploy.yml` reads the commit time from `git log`, which
 *   an `env:` mapping cannot do).
 * - **forwarded into the container** — the monitor runs under `docker run`, and
 *   a variable the runner holds but does not pass with `-e` reaches the probe as
 *   an absence, which is precisely a BLOCKED check on a green run.
 *
 * This is a text test on purpose: no YAML parser is a backend dependency, and
 * adding one so a guard can run is how a guard acquires a reason not to run.
 */

const WORKFLOWS = path.resolve(__dirname, "..", "..", ".gitea", "workflows");

const VARIABLES = ["MONITOR_EXPECTED_SHA", "MONITOR_EXPECTED_SHA_TIME"] as const;

const FILES: Array<{ file: string; why: string }> = [
  { file: "monitor.yml", why: "the periodic probe" },
  { file: "deploy.yml", why: "the post-deploy probe" },
];

function read(file: string): string {
  return readFileSync(path.join(WORKFLOWS, file), "utf8");
}

/**
 * The `docker run …` invocation that starts the monitor, as text.
 *
 * Scoped to the actual command so a stray `-e MONITOR_EXPECTED_SHA` somewhere
 * else in the file — a comment, another step — cannot satisfy the assertion.
 */
function monitorDockerRun(yaml: string, file: string): string {
  const start = yaml.indexOf("docker run");
  assert.notEqual(start, -1, `${file} no longer runs the monitor under docker run`);
  const end = yaml.indexOf("external-monitor.ts", start);
  assert.notEqual(end, -1, `${file}'s docker run no longer invokes external-monitor.ts`);
  return yaml.slice(start, end);
}

/** `NAME:` or `NAME=` / `export NAME`, and never a longer name that starts the same way. */
function isSupplied(yaml: string, name: string): boolean {
  const mapping = new RegExp(`^\\s*${name}:\\s*\\S`, "m");
  const shellAssignment = new RegExp(`^\\s*(export\\s+)?${name}=`, "m");
  return mapping.test(yaml) || shellAssignment.test(yaml);
}

/** `-e NAME` in the docker run, with a boundary so `_TIME` cannot stand in for it. */
function isForwarded(dockerRun: string, name: string): boolean {
  return new RegExp(`-e\\s+${name}(?![A-Za-z0-9_])`).test(dockerRun);
}

describe("workflows keep the release-drift check switched on", () => {
  for (const { file, why } of FILES) {
    for (const name of VARIABLES) {
      it(`${file} (${why}) supplies ${name} to the monitor step`, () => {
        assert.ok(
          isSupplied(read(file), name),
          `${file} does not set ${name} anywhere. Without it the release-drift check reports ` +
            `BLOCKED and the run stays green — the check is off and nothing says so.`,
        );
      });

      it(`${file} (${why}) forwards ${name} into the monitor container`, () => {
        assert.ok(
          isForwarded(monitorDockerRun(read(file), file), name),
          `${file} does not pass \`-e ${name}\` to docker run, so the value never reaches the ` +
            `probe. It arrives as an absence, which is a BLOCKED check on a green run.`,
        );
      });
    }
  }

  it("both workflows still invoke the monitor at all", () => {
    for (const { file } of FILES) {
      assert.match(
        read(file),
        /backend\/src\/scripts\/external-monitor\.ts --run/,
        `${file} no longer runs the external monitor`,
      );
    }
  });
});

/**
 * `ci-backend` must audit its production dependencies, same as `ci-frontend`
 * already does. A gate that only one of the two jobs runs is a gate a
 * backend-only change never has to pass — and is deletable by an unrelated
 * YAML edit while every run stays green, same failure mode as the
 * release-drift check above.
 */
describe("ci-backend runs the production dependency audit", () => {
  function backendJob(yaml: string): string {
    const start = yaml.indexOf("ci-backend:");
    assert.notEqual(start, -1, "deploy.yml has no ci-backend job");
    const end = yaml.indexOf("ci-frontend:", start);
    assert.notEqual(end, -1, "deploy.yml has no ci-frontend job after ci-backend");
    return yaml.slice(start, end);
  }

  it("ci-backend has an audit step matching ci-frontend's flags", () => {
    const job = backendJob(read("deploy.yml"));
    assert.match(
      job,
      /npm audit --audit-level=high --omit=dev/,
      "ci-backend does not run `npm audit --audit-level=high --omit=dev` — the same gate " +
        "ci-frontend runs on its production dependencies is missing on the backend.",
    );
  });

  it("the backend audit step runs before typecheck, mirroring ci-frontend's placement", () => {
    const job = backendJob(read("deploy.yml"));
    const auditIdx = job.indexOf("npm audit --audit-level=high --omit=dev");
    const typecheckIdx = job.indexOf("npm run typecheck");
    assert.ok(auditIdx !== -1 && typecheckIdx !== -1 && auditIdx < typecheckIdx);
  });
});

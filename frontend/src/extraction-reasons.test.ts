import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The extraction failure reasons, read out of both packages and compared.
 *
 * The backend owns this taxonomy. The frontend keeps **two hand copies** of it —
 * the `ExtractionFailureReason` union in `types/index.ts` and the
 * `READING_FAILURE` sentence map in `StatusPage.tsx` — and neither is derived
 * from the backend, because the two packages build separately and share no code.
 *
 * The danger is not the duplication, it is the drift, and it has a reader on the
 * end of it. `StatusPage` is a **public** page: it tells a stranger how much of
 * the archive this project has failed to read. A reason the backend added and the
 * frontend does not know renders as `undefined` in that sentence — no build
 * error, no test failure, no 500, just a public page printing "undefined" where
 * it should say why a document went unread. The union being a *type* is exactly
 * why nothing catches it: types describe the wire, they do not check it, and the
 * row arrives at runtime carrying a string TypeScript never sees.
 *
 * This happened on 2026-08-15. Adding `repetition-truncated` needed three edits
 * across two packages and only one of them was in the package that compiles the
 * backend. So the assertion is not "the reasons are correct" — it is "there is
 * one list", which is checkable, and which is the property the copies threaten.
 *
 * Both directions, because a stale extra entry is the same defect wearing the
 * other sign: a reason the frontend still explains and the backend stopped
 * emitting is a sentence about a state that can no longer happen, and it is
 * indistinguishable from a live one until somebody goes looking.
 *
 * Text scans, in the style of `nginx-headers.test.ts` and of
 * `DataLicensePage.test.tsx`, which reads `backend/src/app.ts` the same way.
 * Importing across the package boundary would mean compiling the backend into
 * the frontend's test run, and this needs to read the file, not run it.
 */

const BACKEND = join(__dirname, "..", "..", "backend", "src", "services", "extraction");
const RUNS = readFileSync(join(BACKEND, "runs.ts"), "utf8");
const DISTRIBUTION = readFileSync(join(BACKEND, "distribution.ts"), "utf8");
const TYPES = readFileSync(join(__dirname, "types", "index.ts"), "utf8");
const STATUS_PAGE = readFileSync(join(__dirname, "pages", "StatusPage.tsx"), "utf8");

/**
 * Comments removed, because these declarations are documented in prose that
 * quotes itself.
 *
 * Both copies carry a doc comment per member explaining what the reason means,
 * and those sentences contain quoted phrases — so a scan for `"…"` over the raw
 * text reads `"we ran out of budget mid-record"` as a union member. Caught by the
 * union-and-map-agree assertion the first time this ran, which is the assertion
 * earning its place: without it the extra phantom members would have sat in the
 * parsed set and every "missing" check would still have passed.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The body of a `const NAME... = { ... };` or `type NAME = ...;` declaration. */
function block(source: string, opener: RegExp, closer: string): string {
  const match = opener.exec(source);
  if (match === null) {
    throw new Error(`the declaration ${String(opener)} is gone — this guard is reading nothing`);
  }
  const start = match.index + match[0].length;
  const end = source.indexOf(closer, start);
  if (end === -1) throw new Error(`unterminated declaration for ${String(opener)}`);
  return source.slice(start, end);
}

/**
 * The backend's list, from the object literal that is already the closed record
 * of it. Keyed by `Record<ChunkFailureReason, true>`, so a member added to the
 * union and forgotten there fails to compile in the backend — which makes this
 * object, not the union, the thing worth reading.
 */
function backendReasons(): string[] {
  const body = withoutComments(block(RUNS, /export const CHUNK_FAILURE_REASONS[^{]*\{/, "};"));
  // `"kebab-case": true` and bare `truncated: true` both occur.
  return [...body.matchAll(/(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*:\s*true/g)]
    .map((match) => match[1] ?? match[2])
    .sort();
}

/** The frontend's union, member by member. */
function frontendUnion(): string[] {
  const body = withoutComments(block(TYPES, /export type ExtractionFailureReason\s*=/, ";"));
  return [...body.matchAll(/\|?\s*"([^"]+)"/g)].map((match) => match[1]).sort();
}

/** The frontend's sentence map. */
function frontendLabels(): string[] {
  const body = withoutComments(
    block(
      STATUS_PAGE,
      /const READING_FAILURE:\s*Record<ExtractionFailureReason,\s*string>\s*=\s*\{/,
      "};",
    ),
  );
  return [...body.matchAll(/(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*:\s*"/g)]
    .map((match) => match[1] ?? match[2])
    .sort();
}

/**
 * The one member the frontend has that the backend's chunk taxonomy does not.
 *
 * It is not invented here: the API sends `DistributionReason`, which the backend
 * declares as `ChunkFailureReason | "unclassified"` for rows written before the
 * taxonomy existed. The declaration is asserted below rather than assumed, so
 * this allowance cannot itself go stale.
 */
const UNCLASSIFIED = "unclassified";

describe("the extraction failure reasons are one list, not three", () => {
  it("reads a non-empty list out of each of the three declarations", () => {
    // The guard's own failure mode. Every assertion below is a set comparison,
    // and two empty sets are equal — so a regex that stops matching after a
    // refactor would turn this file green and blind at the same moment.
    expect(backendReasons().length).toBeGreaterThan(5);
    expect(frontendUnion().length).toBeGreaterThan(5);
    expect(frontendLabels().length).toBeGreaterThan(5);
  });

  it("keeps the backend's wire type as the chunk reasons plus `unclassified`", () => {
    // The premise of the allowance below.
    expect(DISTRIBUTION).toContain(`ChunkFailureReason | "${UNCLASSIFIED}"`);
  });

  it("explains every reason the backend can emit", () => {
    // The defect this file exists for: a reason with no sentence renders as
    // `undefined` on a public page.
    const missing = backendReasons().filter((reason) => !frontendLabels().includes(reason));
    expect(
      missing,
      `emitted by the backend and unexplained on /status: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("types every reason the backend can emit", () => {
    const missing = backendReasons().filter((reason) => !frontendUnion().includes(reason));
    expect(
      missing,
      `emitted by the backend and absent from ExtractionFailureReason: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("carries no reason the backend cannot emit", () => {
    // The other direction. A sentence about a state that can no longer happen
    // reads exactly like one about a state that can.
    const allowed = new Set([...backendReasons(), UNCLASSIFIED]);
    const staleUnion = frontendUnion().filter((reason) => !allowed.has(reason));
    const staleLabels = frontendLabels().filter((reason) => !allowed.has(reason));
    expect(staleUnion, `typed but no longer emitted: ${staleUnion.join(", ")}`).toEqual([]);
    expect(staleLabels, `explained but no longer emitted: ${staleLabels.join(", ")}`).toEqual([]);
  });

  it("keeps the union and the sentence map in step with each other", () => {
    expect(frontendLabels()).toEqual(frontendUnion());
  });

  it("gives every reason a sentence a reader could act on", () => {
    // Not decoration: the string is the whole of what a stranger is told about
    // why part of the public record went unread.
    const body = withoutComments(
      block(
        STATUS_PAGE,
        /const READING_FAILURE:\s*Record<ExtractionFailureReason,\s*string>\s*=\s*\{/,
        "};",
      ),
    );
    for (const sentence of [...body.matchAll(/:\s*"([^"]*)"/g)].map((match) => match[1])) {
      expect(sentence.length, `"${sentence}" is not a sentence`).toBeGreaterThan(15);
    }
  });
});

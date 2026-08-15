import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RENAMED_PATHS, VOCABULARY } from "./vocabulary";

/**
 * The vocabulary is enforced here, because prose in a design document does not
 * hold one.
 *
 * On 2026-08-14 the masthead said "Findings", the URL said `/anomalies`, the
 * heading said "Flagged for review" and the body copy said "nothing here is a
 * finding" — four names for one object on one page, one of them denying it was
 * the object. Nothing caught it because nothing was looking.
 *
 * These tests look. Two of them scan source files, which is unusual for this
 * suite and deliberate: the failure mode is a word appearing somewhere nobody
 * reviewed, and only a scan finds that.
 */

const SRC = join(__dirname);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Files whose reader-facing text may still carry a retired word, each for a
 * stated reason. An exception is a decision somebody wrote down; a match nobody
 * looked at is the thing this test exists to find.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "vocabulary.ts": "defines the retired words",
  // The account of how this site works has to be able to name the schema it is
  // describing, including the tables a reader never otherwise sees.
  "MethodologyPage.tsx": "describes the pipeline, including table names",
  "DataLicensePage.tsx": "documents the export columns, which are schema names",
};

/**
 * Text a reader actually sees: JSX text nodes between tags.
 *
 * Deliberately not every string literal. `useMembers`, `AnomalyFlag` and
 * `/api/members` are identifiers and endpoints, and the whole point of
 * `vocabulary.ts` is that the database's names and the reader's names are
 * allowed to differ. Only rendered prose is in scope.
 *
 * The naive version of this — everything between a `>` and a `<` — reported two
 * offenders on its first run and both were the extractor's fault, not the
 * page's: `>` and `<` are also generics and comparisons, so `useState<Row[]>([])`
 * followed by an `"anomaly.flagged"` event type read as one long text node. A
 * segment carrying `;`, `=`, or a bracket is code, and prose contains at least
 * one letter with a space beside it. Cheap heuristics, but the alternative is
 * parsing JSX to lint a word list.
 */
function readerText(source: string): string {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  return (withoutComments.match(/>[^<>{}]+</g) ?? [])
    .filter((segment) => !/[;=[\]]/.test(segment) && /[a-z]\s|\s[a-z]/i.test(segment))
    .join(" ");
}

/**
 * Prose that reaches the reader as a string literal rather than as a JSX text
 * node — the branches of a ternary in an expression container, a template
 * literal that pluralises a count, an `aria-label`.
 *
 * `readerText` cannot see any of it, and that blind spot was not theoretical:
 * `MeetingDetailPage.tsx` rendered "One anomaly on this record" as an `<h2>`
 * for a day with this file already in the suite, because the sentence sat
 * inside `{… ? "…" : "…"}` and the scan only looked between tags.
 *
 * The heuristic for "prose": at least two words, one of them lowercase with a
 * space beside it, and no `/` — which drops every path, endpoint and import
 * specifier, the exact things `vocabulary.ts` says are allowed to keep the
 * database's names.
 */
function readerLiterals(source: string): string {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  return (withoutComments.match(/["`]([^"`\\\n]{8,})["`]/g) ?? [])
    .filter((literal) => !literal.includes("/") && /[a-z]+\s+[a-z]/i.test(literal))
    .join(" ");
}

describe("the vocabulary is one set of words", () => {
  it("uses no retired word in prose held in a string literal", () => {
    const retired = /\b(anomal(?:y|ies)|members?)\b/i;
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (ALLOWED[name]) continue;
      const found = readerLiterals(readFileSync(file, "utf8")).match(retired);
      if (found) offenders.push(`${name}: "${found[0]}"`);
    }

    expect(offenders).toEqual([]);
  });

  /**
   * A redirect preserves what an old address has accrued from outside. Pointing
   * our own navigation at one spends a round trip to learn something we already
   * know, on every reader, forever.
   */
  it("links internally to the new address, never to the redirect", () => {
    // App.tsx defines the redirects and vocabulary.ts names them; a file that
    // declares a rename has to be able to write the old address down.
    const declares = new Set(["App.tsx", "vocabulary.ts"]);
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (declares.has(name)) continue;
      const source = readFileSync(file, "utf8");
      for (const from of Object.keys(RENAMED_PATHS)) {
        if (source.includes(`to="${from}"`) || source.includes(`to={"${from}"}`)) {
          offenders.push(`${name} links to ${from}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("uses no retired word in text a reader sees", () => {
    const retired = /\b(anomal(?:y|ies)|members?)\b/i;
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (ALLOWED[name]) continue;
      const found = readerText(readFileSync(file, "utf8")).match(retired);
      if (found) offenders.push(`${name}: "${found[0]}"`);
    }

    expect(offenders).toEqual([]);
  });

  it("gives every term that has a page a route, and every claim none", () => {
    // A claim is addressable but never its own page: a page whose entire
    // content is one sentence about one named person is an accusation, not a
    // record. The null is the mechanism, not a gap.
    expect(VOCABULARY.claim.path).toBeNull();
    for (const [key, term] of Object.entries(VOCABULARY)) {
      if (key === "claim") continue;
      expect(term.path, `${key} needs a route`).toMatch(/^\//);
    }
  });

  it("keeps the renamed paths pointing at routes the vocabulary knows", () => {
    const known = new Set<string>(
      Object.values(VOCABULARY)
        .map((term): string | null => term.path)
        .filter((path) => path !== null),
    );
    for (const [from, to] of Object.entries(RENAMED_PATHS)) {
      expect(known.has(to), `${from} redirects to ${to}, which is not a term`).toBe(true);
    }
  });
});

/**
 * The nav is where the four-way disagreement was visible, so it gets its own
 * assertion rather than relying on the scan. `Layout.test.tsx` checks the hrefs
 * resolve; this checks the *label* agrees with the vocabulary the href names.
 */
describe("the masthead agrees with the vocabulary", () => {
  it("labels each renamed section with its term, not its table", () => {
    const layout = readFileSync(join(SRC, "components", "Layout.tsx"), "utf8");

    expect(layout).toContain('{ to: "/findings", label: "Findings" }');
    expect(layout).toContain('{ to: "/officials", label: "Officials" }');
    // The addresses these replaced must not come back as nav targets. They are
    // redirects now, and a nav link pointing at a redirect is a wasted hop that
    // a crawler charges us for.
    expect(layout).not.toContain('to: "/anomalies"');
    expect(layout).not.toContain('to: "/members"');
  });
});

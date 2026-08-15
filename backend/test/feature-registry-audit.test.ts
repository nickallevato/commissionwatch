import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { FEATURES } from "../src/services/features/manifest";

/**
 * **A feature flag is not a wall.**
 *
 * The publication wall, the review gate, the claim wall and "nothing naming a
 * person auto-publishes" are invariants. They are not settings, and there must be
 * no row, no variable and no console click that turns one off.
 *
 * A registry that can disable a safety property is a worse artifact than no
 * registry, because it converts an invariant into a setting — and a setting is
 * something somebody eventually changes at 11pm for a reason that made sense at
 * the time. The whole design rests on one sentence: the registry gates **whether
 * a capability runs**, never **whether a check applies**. That sentence is in the
 * spec, in the migration, and in the manifest's header, and until this file
 * existed it was an intention rather than a property — the same failure
 * `publication-wall-audit.test.ts` was written for, where two documents described
 * a rule that `GET /api/votes` had never followed.
 *
 * So this suite measures it from three sides:
 *
 *  1. **no key in the manifest names a wall.** A key matching the vocabulary of a
 *     check cannot ship, so there is nothing for a console to offer and nothing
 *     for `setFlag` to write. Any key that trips the vocabulary and is nevertheless
 *     a capability is listed in `ALLOWED_KEYS` below with its reason, in the same
 *     style as `publication-wall-audit.test.ts`'s `ALLOWED`;
 *  2. **the wall modules do not know the registry exists.** No import, no call, in
 *     any of them. A flag cannot gate a check that cannot read a flag, and that is
 *     a stronger guarantee than any assertion about behaviour at a particular call
 *     site;
 *  3. **every shipped key has a reader.** A key nothing under `src/` ever asks
 *     about is a switch that lies about what it controls — the console renders it,
 *     the operator clicks it, the audit row is written, and behaviour does not
 *     move. 0.4.0 shipped two of those, and this is the check that would have
 *     caught them.
 *
 * ## What it does not measure
 *
 * The second check is direct rather than transitive: it reads the named files, not
 * their whole import graph. A wall module that reached a flag through a helper two
 * hops away would pass. That is the honest limit of a structural test at this
 * cost, and it is narrowed by the marker assertion below — a wall that moves to a
 * file this list does not name makes this suite **fail**, rather than quietly
 * measuring nothing, which is the failure mode of every hand-kept list beside
 * growing code.
 *
 * The third check is textual in the other direction: it proves a key is *named*
 * somewhere outside the manifest, not that the naming sits on a live code path. A
 * key mentioned in dead code would pass. It is still the difference between a
 * switch with a reader and a switch with none, which is the whole of the defect it
 * exists for.
 */

const SRC = join(__dirname, "..", "src");

/* --------------------------------------------------------------------------
   1. The key set
   -------------------------------------------------------------------------- */

/**
 * Words that name a check rather than a capability.
 *
 * A key containing one of these is either a switch for a wall or a switch that
 * will be read as one by the next person, and the second is nearly as bad: an
 * operator who believes a control exists behaves as though the invariant is
 * negotiable.
 */
const WALL_VOCABULARY = [
  "publication",
  "publish",
  "review",
  "approval",
  "approve",
  "wall",
  "consent",
  "gate",
  "moderation",
  "unpublished",
  "withheld",
  "bypass",
];

/**
 * A key that trips the vocabulary and is nevertheless a capability, with the
 * reason. Matched on the **whole key**, so an entry exempts nothing but itself:
 * with `claim_publication` listed, `publication_wall`, `skip_publication` and
 * `claim_publication_check` all still failed.
 */
const ALLOWED_KEYS: Readonly<Record<string, string>> = {
  // Empty since 0.5.0. `claim_publication` was the single entry: it tripped
  // `publication` and was exempted as a capability that gated whether an already
  // approved claim renders. It turned out to gate nothing at all — check 3 below
  // is what found that — and it was removed from the manifest, so its exemption
  // goes with it. The test under this one refuses to let a stale name sit here
  // as a hole for a future key to fall into.
};

describe("no feature key can gate a wall", () => {
  it("finds no manifest key naming a check", () => {
    const offenders: string[] = [];

    for (const feature of FEATURES) {
      const key: string = feature.key;
      if (ALLOWED_KEYS[key] !== undefined) continue;

      const hits = WALL_VOCABULARY.filter((word) => key.includes(word));
      if (hits.length > 0) {
        offenders.push(`${key} matches ${hits.join(", ")}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "A feature flag is not a wall. A key naming publication, review, approval, a " +
        "wall, consent, a gate or moderation is either a switch for a safety property " +
        "or will be read as one — and an invariant that has a switch is a setting. If " +
        "the key really gates a capability, add it to ALLOWED_KEYS with the reason it " +
        "cannot disable a check:\n  " +
        offenders.join("\n  "),
    );
  });

  it("keeps the exemption list exact, so it cannot widen by accident", () => {
    // Every exemption names a key that actually ships. A stale entry here would be
    // a hole waiting for a future key to fall into — `claim_publication_v2` would
    // not match, but a rename to a key already listed would sail through with a
    // reason written about something else.
    const shipped = new Set<string>(FEATURES.map((feature) => feature.key));
    for (const key of Object.keys(ALLOWED_KEYS)) {
      assert.ok(shipped.has(key), `ALLOWED_KEYS names ${key}, which is not in the manifest`);
      assert.notEqual(ALLOWED_KEYS[key].trim(), "", `${key} is exempted with no reason`);
    }
  });

  it("states, for every key, that it gates a capability", () => {
    // Not decoration. The description is what an operator reads at 11pm while
    // deciding whether this is the thing that is going wrong, and a key with an
    // empty one is a switch nobody can evaluate.
    for (const feature of FEATURES) {
      assert.notEqual(feature.title.trim(), "", feature.key);
      assert.ok(feature.description.trim().length > 40, `${feature.key} has no real description`);
      assert.ok(["low", "publishes", "sends"].includes(feature.risk), feature.key);
    }
  });
});

/* --------------------------------------------------------------------------
   2. The wall modules
   -------------------------------------------------------------------------- */

interface WallModule {
  /** Relative to `backend/src`. */
  path: string;
  /** Which wall this file is. */
  what: string;
  /**
   * A string that must still be in the file. If a wall moves out of the module
   * this list names, the marker goes with it and this suite fails — which is the
   * only thing that stops a hand-kept list from silently measuring nothing.
   */
  marker: RegExp;
}

/**
 * Every module that decides whether something reaches a reader.
 *
 * **Files, not directories, and deliberately so.** `services/events/emit.ts` is a
 * wall — `emitEvent` refuses to write an event whose subject is not public — while
 * `services/events/drain.ts` in the same directory is a capability and reads the
 * `event_drain` flag by design. A directory-shaped guard would either exempt the
 * wall or fail on the capability, and both are wrong.
 */
const WALL_MODULES: readonly WallModule[] = [
  {
    path: "services/publication.ts",
    what: "the publication wall — ingested is not published",
    marker: /export function whereMeetingPublished/,
  },
  {
    path: "services/review/queue.ts",
    what: "the review gate — the only thing that sets a finding to `published`",
    marker: /review_state/,
  },
  {
    path: "services/review/claims.ts",
    what: "the claim wall — the only thing that makes a `minute_claims` row public",
    marker: /whereClaimPublic/,
  },
  {
    path: "services/review/policy.ts",
    what: "the threshold the review gate holds findings against",
    marker: /Severity/,
  },
  {
    path: "services/review/place-links.ts",
    what: "the place-link wall — what puts a coordinate on a public map",
    marker: /approvePlaceLink/,
  },
  {
    path: "services/events/emit.ts",
    what: "the event claim wall — no event for a subject that is not public",
    marker: /subjectIsPublic/,
  },
];

/** An import of anything in `services/features`, written any of the ways it can be. */
const FEATURE_IMPORT = /from\s+["'][^"']*features(?:\/(?:registry|manifest))?["']/;

/** A call into the registry, for the case where somebody wires it in without an import. */
const FEATURE_CALL =
  /\b(?:featureEnabled|resolveFeature|getFeatureRegistry|setFeatureRegistry|killSwitchForcesOff|featureDefinition|isFeatureKey|new\s+FeatureRegistry)\s*\(/;

describe("the walls do not know the registry exists", () => {
  it("names modules that all still exist and still hold their wall", () => {
    for (const module of WALL_MODULES) {
      const full = join(SRC, module.path);
      assert.ok(existsSync(full), `${module.path} is gone — ${module.what} moved and this guard did not`);
      const source = readFileSync(full, "utf8");
      assert.match(
        source,
        module.marker,
        `${module.path} no longer contains ${module.marker} — ${module.what} may have moved to a file ` +
          "this list does not check, which would leave the guard passing over nothing",
      );
    }
  });

  it("finds no import of the features services in any wall module", () => {
    const offenders: string[] = [];

    for (const module of WALL_MODULES) {
      const source = readFileSync(join(SRC, module.path), "utf8");
      // Comments count as prose and not as code, but a comment cannot import
      // anything either — so the match is over the whole file and a comment that
      // happens to contain `from "./features"` would be a false positive worth the
      // simplicity. None does; the manifest is discussed by name, not by path.
      for (const line of source.split("\n")) {
        if (FEATURE_IMPORT.test(line)) offenders.push(`${module.path}: ${line.trim()}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "A wall must not be able to read a flag. Whatever this import was for, the " +
        "capability it gates belongs on the calling side of the wall, not inside it:\n  " +
        offenders.join("\n  "),
    );
  });

  it("finds no call into the registry in any wall module", () => {
    const offenders: string[] = [];

    for (const module of WALL_MODULES) {
      const source = readFileSync(join(SRC, module.path), "utf8");
      for (const line of source.split("\n")) {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;
        if (FEATURE_CALL.test(line)) offenders.push(`${module.path}: ${line.trim()}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "A flag decided something inside a wall. There is no reading of this that is " +
        "not an invariant becoming a setting:\n  " + offenders.join("\n  "),
    );
  });
});

/* --------------------------------------------------------------------------
   3. Every shipped key has a reader
   -------------------------------------------------------------------------- */

/**
 * A switch that accepts a click and changes nothing is the failure this project
 * exists to refuse about the public record, committed against our own console.
 *
 * 0.4.0 shipped `claim_publication` and `generated_narrative` into `FEATURES`.
 * Both rendered a toggle, both wrote an audit row when clicked, and neither was
 * read anywhere outside `manifest.ts`. The descriptions asserted otherwise — one
 * claimed to decide "whether approved claims are shown" while approved claims
 * were already public through three surfaces none of which consulted it. That is
 * the same defect class as 0.4.0's F1j, a flag that reached no loop.
 *
 * The check is a scan of real source text off disk, deliberately: the only other
 * way to state "these keys are wired" is a second hand-written list beside the
 * manifest, and a hand-written list of what is wired is exactly the artifact that
 * goes stale and starts lying — which is the defect, not the guard.
 */

/** The manifest is where a key is *declared*; a reader must be somewhere else. */
const MANIFEST_PATH = join("services", "features", "manifest.ts");

/** Every `.ts` file under `backend/src`, recursively. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The key written as a string literal — which is the only way a call site can name
 * one, since `featureEnabled` takes `FeatureKey` and every consumer passes a
 * literal. Quoted so that `dated_export_archive` does not match a comment
 * discussing the dated export archive in prose.
 */
function keyLiteral(key: string): RegExp {
  return new RegExp(`["'\`]${key}["'\`]`);
}

/** Comment lines are prose. A key discussed in a comment is not a key with a reader. */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

describe("every feature key has a reader", () => {
  const files = sourceFiles(SRC).sort();

  it("scans a source tree that exists, with a matcher that still matches", () => {
    // Guard the guard. Two empty sets are equal, and a scan that silently stopped
    // matching would report no offenders for the same reason a clean tree does —
    // this repository has already been bitten by exactly that shape.
    assert.ok(FEATURES.length > 0, "the manifest is empty, so the check below asserts nothing");
    assert.ok(
      files.length > 20,
      `found ${files.length} source files under ${SRC} — the scan is looking at the wrong tree`,
    );

    // The matcher, proved against the one file guaranteed to contain every key.
    // If `keyLiteral` stops matching, this fails here rather than passing an
    // empty offender list downstream.
    const manifest = readFileSync(join(SRC, MANIFEST_PATH), "utf8");
    for (const feature of FEATURES) {
      assert.match(
        manifest,
        keyLiteral(feature.key),
        `the scan cannot find ${feature.key} in the manifest that declares it — the matcher is broken`,
      );
    }
  });

  it("finds, for every shipped key, at least one file outside the manifest that names it", () => {
    const readers = new Map<string, string[]>(FEATURES.map((feature) => [feature.key, []]));

    for (const file of files) {
      const relativePath = relative(SRC, file);
      if (relativePath === MANIFEST_PATH) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      for (const [key, found] of readers) {
        const pattern = keyLiteral(key);
        const hit = lines.findIndex((line) => !isComment(line) && pattern.test(line));
        if (hit >= 0) found.push(`${relativePath}:${hit + 1}`);
      }
    }

    const offenders = [...readers]
      .filter(([, found]) => found.length === 0)
      .map(([key]) => key);

    assert.deepEqual(
      offenders,
      [],
      "A key with no reader is a switch that lies about what it controls. The console " +
        "renders it, the operator types a reason, `setFlag` writes the row and the audit " +
        "trail — and no code under `backend/src` ever asks. Nothing changes, and the " +
        "description on the row says something did. Either wire the key to the capability " +
        "it names, or take it out of `FEATURES` and leave a comment recording what it " +
        "claimed and what must exist before it returns:\n  " +
        offenders.join("\n  "),
    );
  });
});

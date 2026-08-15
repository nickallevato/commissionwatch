import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
 * So this suite measures it from two sides:
 *
 *  1. **no key in the manifest names a wall.** A key matching the vocabulary of a
 *     check cannot ship, so there is nothing for a console to offer and nothing
 *     for `setFlag` to write. `claim_publication` is the one key that trips the
 *     vocabulary and is listed below with its reason, in the same style as
 *     `publication-wall-audit.test.ts`'s `ALLOWED`;
 *  2. **the wall modules do not know the registry exists.** No import, no call, in
 *     any of them. A flag cannot gate a check that cannot read a flag, and that is
 *     a stronger guarantee than any assertion about behaviour at a particular call
 *     site.
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
 * reason. Matched on the **whole key**, so `claim_publication` being here exempts
 * nothing else: `publication_wall`, `skip_publication` and
 * `claim_publication_check` all still fail.
 */
const ALLOWED_KEYS: Readonly<Record<string, string>> = {
  // Gates whether an *already approved* claim renders for the public, serving the
  // pinned bytes an operator approved. It cannot decide whether a claim needs
  // approving: that is `reviewClaim`, it is a wall, and it has no flag. Turning
  // this off hides approved claims; there is no value of it that shows an
  // unapproved one.
  claim_publication: "gates whether approved claims render, never whether approval is required",
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

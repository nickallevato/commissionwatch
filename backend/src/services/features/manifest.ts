/**
 * The compiled list of things an operator may switch on, and what each one does.
 *
 * This file — not the `features` table — is the authority on what a feature key
 * means. The set of real features is a property of the deployed code, so a row
 * naming a key that is not listed here is inert rather than an error, which is
 * the behaviour a rolled-back deploy needs. `registry.ts` resolves only these
 * keys.
 *
 * ## What may never be added here
 *
 * **A feature flag is not a wall.** The publication wall, the review gate, the
 * claim wall and "nothing naming a person auto-publishes" are invariants, not
 * settings. A registry that can disable a safety property is a worse artifact
 * than no registry, because it converts an invariant into a setting — and a
 * setting is something somebody eventually changes at 11pm for a reason that
 * made sense at the time. Every key here gates **whether a capability runs**,
 * never **whether a check applies**, and `feature-registry-audit.test.ts` holds
 * the key set to that by vocabulary.
 *
 * `generated_narrative` is the entry that makes the distinction concrete. On
 * means composed prose reaches the *operator queue*. There is no value of any
 * flag that publishes generated prose about a person, because the review gate is
 * a wall and is not in this file.
 *
 * ## The key type
 *
 * `FEATURES` is `as const satisfies readonly FeatureDefinition[]`, so `FeatureKey`
 * is a literal union read back off the array rather than a hand-maintained
 * second list. A call site naming a key that is not shipped is a compile error,
 * which is the only way `get('mcp_sever')` gets caught — a typo resolves to
 * "no such row, default off" at runtime and looks exactly like a feature that is
 * simply turned off.
 */

/**
 * What turning a feature on can cost, in the only terms that matter to somebody
 * deciding at speed:
 *
 *  - `low`        nothing a stranger can see changes, and nothing leaves the
 *                 building. Turning it off again undoes it.
 *  - `publishes`  it changes what a stranger can read. Reversible, but the
 *                 window it was open cannot be closed retroactively.
 *  - `sends`      it emits something that leaves the building and cannot be
 *                 recalled. The console demands a typed confirmation for these.
 */
export type FeatureRisk = "low" | "publishes" | "sends";

export interface FeatureDefinition {
  /** snake_case, and the key stored in `features.key`. */
  key: string;
  /** What the console calls it. */
  title: string;
  /**
   * What turning it **on** actually does — stated as the change in behaviour, not
   * as a description of the subsystem. An operator reading this row at 11pm is
   * deciding whether this is the thing that is going wrong.
   */
  description: string;
  risk: FeatureRisk;
  /**
   * The pre-registry environment variable that still enables this feature, or
   * `null` if it never had one.
   *
   * These stay honoured because they are documented in
   * `deploy/docker-compose.shared.yml`, in `docs/STATUS.md` and in operator steps
   * that are currently correct. With no registry row present, behaviour is
   * byte-identical to today — which is also what keeps the existing drain,
   * consumer and MCP suites honest rather than rewritten.
   */
  legacyEnv: string | null;
  /**
   * A step the operator must take *besides* flipping the switch, or `null`.
   *
   * On the row rather than in `docs/STATUS.md`, because a flag whose prerequisite
   * lives in a document is a flag that gets turned on without it.
   */
  requiresSeed: string | null;
}

export const FEATURES = [
  {
    key: "event_drain",
    title: "Event drain",
    description:
      "The drain claims undispatched rows from `events` and hands them to the delivery " +
      "dispatcher, which routes them to whichever channels are configured. This is the only " +
      "key that can cause a message to leave the building. Note that with SPF/DKIM/DMARC " +
      "unconfigured and `ALERT_FROM_EMAIL` on a domain we do not deploy, email alignment " +
      "fails by construction — turning this on does not fix that and does not depend on it.",
    risk: "sends",
    legacyEnv: "EVENT_DRAIN_ENABLED",
    requiresSeed: null,
  },
  {
    key: "prerender",
    title: "Prerendered pages",
    description:
      "The prerender consumer walks the event log and writes a static document per published " +
      "meeting, finding, official and source, deleting the file when its subject stops being " +
      "public. It writes files; whether anything serves them is a deployment decision this " +
      "switch does not make.",
    risk: "publishes",
    legacyEnv: "PRERENDER_ENABLED",
    // A flag is not a migration. The consumer walks forward from its cursor and
    // nothing replays a publish that happened before the flag went on, so every
    // page already published is missing until the rebuild runs. The spec calls
    // this "the prerender-rebuild seed"; it is in fact the npm script below —
    // there is no knex seed of that name and `seeds/` holds only pilot data.
    requiresSeed:
      "Run `npm run prerender:rebuild` after enabling. The consumer only walks events past its " +
      "cursor, so everything published before now has no file until the rebuild writes one.",
  },
  {
    key: "mcp_server",
    title: "MCP server",
    description:
      "`POST /mcp` and `/.well-known/mcp.json` answer instead of returning 404, exposing the " +
      "public dataset to model clients through the same publication wall the REST API reads " +
      "through. No unpublished record becomes reachable; a new audience does.",
    risk: "publishes",
    legacyEnv: "MCP_ENABLED",
    requiresSeed: null,
  },
  {
    key: "claim_publication",
    title: "Published claims",
    description:
      "An approved claim renders for the public inside the meeting it was extracted from, at " +
      "`#claim-{id}`, serving the pinned `rendered_text` bytes that were approved rather than " +
      "a re-render. Approval is still a wall: this switch decides whether approved claims are " +
      "shown, never whether a claim needs approving.",
    risk: "publishes",
    legacyEnv: null,
    requiresSeed: null,
  },
  {
    key: "generated_narrative",
    title: "Generated finding narrative",
    description:
      "The findings composer drafts prose for a detected finding **into the operator review " +
      "queue**, every sentence carrying its citation. Nothing it writes reaches a reader " +
      "without an operator approving it, and there is no flag value that changes that — the " +
      "review gate is a wall, not a feature.",
    // `low`, and that is the whole point of the entry: the output of this
    // capability lands behind the review gate, so turning it on changes what an
    // operator sees and nothing a stranger sees.
    risk: "low",
    legacyEnv: null,
    requiresSeed: null,
  },
  {
    key: "dated_export_archive",
    title: "Dated export archive",
    description:
      "`/api/data/archive` serves point-in-time exports addressed by date, built from the same " +
      "walled dataset builders as `/api/data` so there is exactly one publication wall in the " +
      "export path. With this off, `/data` says the question is unanswerable rather than " +
      "implying otherwise.",
    risk: "publishes",
    legacyEnv: null,
    requiresSeed: null,
  },
] as const satisfies readonly FeatureDefinition[];

/** The literal union of shipped keys, read back off `FEATURES`. */
export type FeatureKey = (typeof FEATURES)[number]["key"];

/**
 * Lookup by key. Built once at module load, so the read path — which
 * `mcpEnabled()` sits on, per request — costs a map hit and no scan.
 */
const BY_KEY: ReadonlyMap<string, FeatureDefinition> = new Map(
  FEATURES.map((feature) => [feature.key, feature]),
);

export function featureKeys(): readonly FeatureKey[] {
  return FEATURES.map((feature) => feature.key);
}

/**
 * Narrows an arbitrary string — a row from `features`, a path parameter — to a
 * shipped key. The `false` branch is the inertness rule: an unrecognised key is
 * not an error anywhere it is read, only unresolvable.
 */
export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && BY_KEY.has(value);
}

/** The definition for a key the compiler has already established is shipped. */
export function featureDefinition(key: FeatureKey): FeatureDefinition {
  const definition = BY_KEY.get(key);
  if (definition === undefined) {
    // Unreachable while `FeatureKey` is derived from `FEATURES`. Thrown rather
    // than asserted away, because the alternative is a non-null cast and the one
    // thing that could make this reachable is somebody widening `FeatureKey` to
    // `string`.
    throw new Error(`feature ${key} is not in the manifest`);
  }
  return definition;
}

/** As above, for a key that has not been narrowed yet. `null` when inert. */
export function findFeatureDefinition(key: string): FeatureDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * The kill-switch variable name for a key: `event_drain` → `FEATURE_EVENT_DRAIN`.
 *
 * Derived rather than declared, so a new manifest entry cannot ship with a
 * working switch and a wrong variable name in the deploy docs. The migration's
 * `features_key_shape_check` keeps every key a snake_case token, which is what
 * makes this a straight upper-casing with nothing to escape.
 */
export function killSwitchEnvName(key: string): string {
  return `FEATURE_${key.toUpperCase()}`;
}

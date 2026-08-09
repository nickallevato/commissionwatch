import type { Knex } from "knex";
import type { AdapterRegistry } from "./adapters/registry";
import type { SourceAdapter } from "./adapters/types";

/**
 * Turns a registered adapter into the rows it needs to be swept.
 *
 * `describeSource()` is pure and touches no network, so this is safe on every
 * boot, and it is idempotent by construction: a jurisdiction is matched on
 * `(name, state)`, a commission on `(jurisdiction_id, name)`, and a source on
 * the `(jurisdiction_id, adapter_key)` unique index migration 016 already
 * declares.
 *
 * It exists so that standing up a source is not "hand-write three UUIDs into
 * psql and hope". Cadence still lives in the database and is still the
 * operator's to change — registration sets a default the first time and never
 * overwrites it, because an operator who moved a sweep to 03:00 should not find
 * it back at 07:17 after the next deploy.
 */

export interface RegistrationDefaults {
  /** Applied only when the source row is created. */
  cronExpression?: string;
  /** Applied only when the source row is created. Null means no expectation. */
  expectedIntervalHours?: number | null;
  /**
   * Whether a newly created source starts enabled. Default false — a source
   * that begins sweeping the moment it is deployed is a source nobody chose.
   */
  enabled?: boolean;
}

export interface RegisteredSource {
  sourceId: string;
  jurisdictionId: string;
  adapterKey: string;
  created: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireId(row: unknown, table: string): string {
  if (!isRecord(row) || typeof row.id !== "string" || row.id === "") {
    throw new Error(`${table}: insert or lookup returned no id`);
  }
  return row.id;
}

async function ensureJurisdiction(db: Knex, adapter: SourceAdapter): Promise<string> {
  const { jurisdiction } = adapter.describeSource();
  const existing: unknown = await db("jurisdictions")
    .where({ name: jurisdiction.name, state: jurisdiction.state })
    .first("id");
  if (isRecord(existing)) return requireId(existing, "jurisdictions");

  const inserted: unknown = await db("jurisdictions")
    .insert({
      name: jurisdiction.name,
      state: jurisdiction.state,
      type: jurisdiction.type,
      website_url: jurisdiction.websiteUrl ?? null,
    })
    .returning("id");
  return requireId(Array.isArray(inserted) ? inserted[0] : undefined, "jurisdictions");
}

async function ensureCommissions(
  db: Knex,
  jurisdictionId: string,
  adapter: SourceAdapter,
): Promise<number> {
  const { bodies } = adapter.describeSource();
  let created = 0;
  for (const body of bodies) {
    const existing: unknown = await db("commissions")
      .where({ jurisdiction_id: jurisdictionId, name: body.name })
      .first("id");
    if (isRecord(existing)) continue;
    await db("commissions").insert({
      jurisdiction_id: jurisdictionId,
      name: body.name,
      // The listing URL is where the body's record is published. Stored as the
      // schedule note rather than invented prose: `commissions` has no
      // listing_url column, and making one up is not this change's job.
      description: `Meetings published at ${body.listingUrl}`,
    });
    created += 1;
  }
  return created;
}

/** Ensures rows for one adapter. Returns what it found or made. */
export async function registerSource(
  db: Knex,
  adapter: SourceAdapter,
  defaults: RegistrationDefaults = {},
): Promise<RegisteredSource> {
  const descriptor = adapter.describeSource();
  const jurisdictionId = await ensureJurisdiction(db, adapter);
  await ensureCommissions(db, jurisdictionId, adapter);

  const existing: unknown = await db("ingestion_sources")
    .where({ jurisdiction_id: jurisdictionId, adapter_key: adapter.key })
    .first("id");
  if (isRecord(existing)) {
    return {
      sourceId: requireId(existing, "ingestion_sources"),
      jurisdictionId,
      adapterKey: adapter.key,
      created: false,
    };
  }

  const inserted: unknown = await db("ingestion_sources")
    .insert({
      jurisdiction_id: jurisdictionId,
      adapter_key: adapter.key,
      config: JSON.stringify({
        baseUrls: descriptor.baseUrls,
        politeness: descriptor.politeness,
        bodies: descriptor.bodies.map((body) => body.key),
      }),
      enabled: defaults.enabled ?? false,
      // An adapter that cannot fetch live is `blocked` from the start, which is
      // a state, not an error — every stage after fetch keeps working.
      health_status: descriptor.supportsLiveFetch ? "healthy" : "blocked",
      cron_expression: defaults.cronExpression ?? "17 7 * * *",
      expected_interval_hours: defaults.expectedIntervalHours ?? null,
    })
    .returning("id");

  return {
    sourceId: requireId(Array.isArray(inserted) ? inserted[0] : undefined, "ingestion_sources"),
    jurisdictionId,
    adapterKey: adapter.key,
    created: true,
  };
}

/** Ensures rows for every adapter in `registry`. */
export async function registerSources(
  db: Knex,
  registry: AdapterRegistry,
  defaults: RegistrationDefaults = {},
): Promise<RegisteredSource[]> {
  const results: RegisteredSource[] = [];
  for (const adapter of registry.all()) {
    results.push(await registerSource(db, adapter, defaults));
  }
  return results;
}

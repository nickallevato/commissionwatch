# Geography — the city development map

> Design of record for a feature the operator added to the design phase on 2026-08-14: a
> general-purpose mapping system that lets this project's data be associated, tagged and connected
> to *the location of the decisions and actions it records*.
>
> Companion to `2026-08-14-published-claim-design.md` (what may be published about a person) and
> `2026-08-14-vocabulary-and-ui-design.md` (what things are called). Read those first.

## Why this is the right feature

Local government is *about* places. A rezone is a rezone of a parcel. A capital project is a street.
A variance is a lot line. A tax increment district is a boundary drawn on a map. Almost every
decision this project records has a location, and right now the database holds none of them.

A reader's real question is rarely "what did the commission do in March". It is "what is happening
near me", and there is no way to ask it. A map is the only interface that answers it directly, and
it is also the interface that makes the corpus *searchable by the people most affected by it* rather
than only by people already following the agenda.

It is also, bluntly, the most reusable thing in the roadmap. Bozeman and Gallatin are the pilot; a
general geographic layer is what makes the third jurisdiction a configuration rather than a rewrite.

## The line this feature must not cross

The project has already made this decision once, in code. Migration `043_drop_campaign_finance_pii.ts`
**dropped `entity_address`** from campaign finance, and `051` did the same federally. That precedent
governs here.

**This maps decisions, not people.**

| Mapped | Not mapped |
|---|---|
| A parcel subject to a rezone | Where an official lives |
| A capital project's extent | Where a donor lives |
| A district or boundary | Where a public commenter lives |
| The address named in a public agenda item | An address obtained by joining a name to a records source |
| A city facility | A residence, ever, for any reason |

Three rules make that enforceable rather than aspirational:

1. **A location must come from the record.** A geometry is attached to an agenda item, a document, a
   project or a boundary — objects that already exist and are already public. There is no path from a
   *person* to a *location*. `minute_claims` gets no geometry column, and no join from `members` to
   any geographic table is permitted. A test asserts the absence.
2. **A location is a claim like any other**, and carries the same citation: the artifact sha, the
   quote, and the offset where the address or parcel identifier appears. An un-sourced pin is an
   un-sourced claim and cannot be published.
3. **Residential addresses are excluded by policy at ingest**, not filtered at render. If a source
   feed contains them, they are not stored. The one exception is an address that is *itself the
   subject of a public land-use decision* — the applicant's parcel in a rezone is the substance of
   the agenda item, and it is already printed in the public notice. Even then, what is stored is the
   parcel and the decision, never a resident's name attached to it.

Rule 3 has a sharp edge worth stating: a rezone application at a residential address is public
record, and a resident's home is a private fact, and sometimes these are the same coordinate. The
resolution is that we publish *the application*, in the words of the notice, and we never publish a
map layer of "who lives where" — because the difference between those is aggregation, and
aggregation is what turns public records into surveillance.

## The data model

### a. Probed 2026-08-15: PostGIS is absent, and half the feature does not need it

**Evidence, not reasoning.** Against the deployed image (`pgvector/pgvector:pg16`, the same tag in
`docker-compose.yml` and `deploy/docker-compose.shared.yml`):

```
select count(*) from pg_available_extensions where name like 'postgis%';   -- 0
select name from pg_available_extensions
 where name in ('vector','postgis','pg_trgm','cube','earthdistance');
 -- cube, earthdistance, pg_trgm, vector
```

So PostGIS is not merely un-installed, it is **unavailable** — `CREATE EXTENSION postgis` fails and
a migration containing it would fail *on deploy*, since migrations run automatically. That is a
production outage delivered by a feature branch, and it is the reason this probe was worth running
before writing the migration rather than after.

But `cube` and `earthdistance` are there, and they answer the query this feature exists for:

```
create extension cube; create extension earthdistance;
select round(earth_distance(ll_to_earth(45.6796,-111.0386),
                            ll_to_earth(45.6841,-111.0386))::numeric);   -- 501
select round(earth_distance(ll_to_earth(45.6796,-111.0386),
                            ll_to_earth(45.7246,-111.0386))::numeric);   -- 5009
create index p_geo on p using gist (ll_to_earth(lat, lon));              -- CREATE INDEX
```

501 metres and 5,009 metres against two points a known distance apart, and **the radius query is
indexable** with a GiST index on `ll_to_earth`. Nothing here needs a new image.

### The consequence: two stages, and the valuable one ships first

**Stage 1 — points, today.** `places` stores `lat`/`lon` as `float8` with a GiST index on
`ll_to_earth(lat, lon)`. That serves the "what is happening near me" query, `/feed.xml?near=…`, and
the whole point-and-radius half of the design — including the subscription this spec calls the most
compelling in the roadmap, *"anything within 500 metres of this address"*. It requires **no
deployment change at all**, which means it is not gated on an operator window.

**Stage 2 — polygons, when the image changes.** Parcel boundaries, district containment, and
`geometry(Geometry, 4326)` genuinely need PostGIS: `earthdistance` does points and distances and
nothing else. Stage 2 is where "which district contains this parcel" lives, and it stays blocked on
`pgvector/pgvector:pg16` being replaced with an image carrying both extensions — which is an
operator-sequenced change, ordered *before* the migration, never with it.

The `precision` column already carries this split honestly: a stage-1 `place` is `exact`, `block` or
`centroid`, and `parcel` becomes available only in stage 2. A reader is never shown a polygon we do
not have.

### b. PostGIS, and the deployment consequence (stage 2 only)

The database is PostgreSQL 16 with pgvector. PostGIS is a **separate extension and a different
image**, so this is not a migration-only change — `deploy/`'s compose file and the database image
must change, and the change must be sequenced ahead of the migration or the migration fails on
deploy. Name that in the plan explicitly; it is exactly the kind of thing that turns into a
crash-loop in production.

Alternatives considered and rejected: storing GeoJSON in `jsonb` with no spatial index works for
rendering and fails for the only queries that matter ("what is within 500m of this point", "which
district contains this parcel"), and would be rewritten within a month. Use the real thing.

### c. `places` — the general geographic object

Migration `079_create_places.ts`:

```
id              uuid pk
jurisdiction_id uuid not null → jurisdictions
kind            text not null      -- 'parcel' | 'address' | 'street_segment'
                                   -- | 'district' | 'facility' | 'project_area' | 'boundary'
label           text not null      -- as printed in the record
geom            geometry(Geometry, 4326) not null
external_ref    text null          -- county parcel id, city project number
external_source text null          -- which authoritative dataset it came from
precision       text not null      -- 'exact' | 'parcel' | 'block' | 'centroid' | 'jurisdiction'
created_at / updated_at

CHECK (kind IN (...))
CHECK (precision IN ('exact','parcel','block','centroid','jurisdiction'))
CREATE INDEX places_geom ON places USING GIST (geom);
CREATE UNIQUE INDEX places_external ON places (external_source, external_ref)
  WHERE external_ref IS NOT NULL;
```

**`precision` is not decoration.** A geocoded street address and a parcel polygon from the county
assessor are different epistemic objects, and a map that draws them identically is lying at a
resolution the reader cannot see. Precision drives rendering: an `exact` geocode is a pin, a
`parcel` is a polygon, a `block` or `centroid` is a deliberately fuzzy shape, and a `jurisdiction`
fallback renders as a whole-city badge rather than a pin anywhere. **Never draw a point more
precisely than the source supports.** This is the single most common way civic maps mislead.

`external_source`/`external_ref` make a place content-addressable against an authoritative dataset,
the same instinct as `artifacts.sha256` — re-importing the county parcel layer must update, not
duplicate.

### d. `place_links` — the association layer

The general-purpose part. Any record object can be tied to any place, with a stated basis:

```
id           uuid pk
place_id     uuid not null → places
subject_kind text not null  -- 'agenda_item' | 'meeting' | 'document' | 'finding' | 'project'
subject_id   uuid not null
relation     text not null  -- 'subject_of' | 'located_at' | 'affects' | 'adjacent_to' | 'within'
confidence   text not null  -- 'stated' | 'matched' | 'inferred'
artifact_sha256 char(64) null
quote        text null
quote_offset integer null
status       text not null default 'held'
...review/approval columns, as minute_claims

CHECK (subject_kind IN (...)) CHECK (relation IN (...)) CHECK (confidence IN (...))
CHECK (confidence = 'inferred' OR (artifact_sha256 IS NOT NULL AND quote_offset IS NOT NULL))
CREATE UNIQUE INDEX place_links_dedupe ON place_links (place_id, subject_kind, subject_id, relation);
```

`subject_kind`/`subject_id` is polymorphic and deliberately not an FK, for the reasons the event
spine gives: there is no single table to point at, and the link records that a document *said*
something, which must survive the subject's deletion.

**`confidence` is the honesty column.** `stated` means the record names the location and the quote
proves it. `matched` means an address string in the record resolved against an authoritative parcel
dataset, and the match itself is recorded. `inferred` means neither, and an `inferred` link is
**never public** — it exists only as a lead in the operator console. The CHECK constraint enforces
that anything public carries a citation.

### e. Boundaries

Districts, wards, TIF districts, zoning designations and city limits are `places` of kind
`district`/`boundary`, imported from the jurisdiction's own published GIS. They are **time-bounded**
— districts get redrawn, and a claim about "District 3" in 2019 is about a different polygon than
one in 2026. Add `effective_from`/`effective_to`, and every spatial query resolves against the date
of the record, not against today. A map that silently re-districts history is worse than no map.

## Getting the geometry

**Probe before designing.** This project's rule, and geographic data has more dead ends than most.
The plan's first task is a probe report, not code. In order of preference:

1. **The county's authoritative parcel layer.** Gallatin County publishes GIS; Montana has a state
   cadastral system. This is the best source: canonical parcel identifiers, real polygons, and a
   licence that usually permits reuse with attribution. Check the licence and record it in
   `jurisdiction_access_policy` — that table exists for exactly this class of fact, and its principle
   holds: *our conduct is ours to state; their terms are theirs and must be read.*
2. **The city's open-data portal** for districts, zoning, capital projects and city limits.
3. **Geocoding an address printed in an agenda item**, as a fallback, at `exact` or `block`
   precision depending on what the geocoder returns.

On geocoding: use a service whose terms permit storing the result, and **store the result** rather
than geocoding at render time — a map that makes a third-party API call per pin is a map that leaks
its reader's browsing to that third party and breaks when the quota runs out. Nominatim's usage
policy forbids heavy automated use; Census/TIGER covers US addresses and is public domain and is
the likely answer. Probe it. Record which service, when, and at what precision, on the place row.

**Nothing in this feature may require an API key that ships to the browser**, and no map tile
provider may receive the reader's requests directly if it can be avoided — self-host or proxy tiles.
A transparency site that tells a commercial mapping company exactly which parcels each reader looked
at has quietly built the surveillance layer it was designed to avoid. This is a hard requirement, not
a preference, and it constrains the tile choice: an open tile source (OpenStreetMap-derived, self
hosted or proxied and cached) rather than an embedded commercial SDK.

## Extraction

Locations come out of documents the same way claims do, and the same rules apply:

- Address and parcel identifiers are extracted by **deterministic parsing first** — an address regex,
  a parcel-number pattern, a "Ordinance ____ rezoning ____" template — because these are formatted
  strings and a model is the wrong tool for a well-formed pattern.
- Where a model is used to identify *which* place an item is about, it is subject to the same
  verification as `minute_claims`: the quote must be located in the artifact bytes, and the LLM
  governor (spec §3) judges whether the passage supports the association. A place link is a claim.
- Held by default. A `place_link` naming a specific parcel is published only after operator review,
  by the same queue.

## The public surface

**`/map`** — the reader-facing map. Filters by jurisdiction, date range, decision kind, and finding
severity. Every pin opens a card that is the same `<Citation>`/`<Provenance>` component set the rest
of the site uses; there is no separate map-flavoured way of showing a source.

**Location becomes a first-class filter everywhere else.** `/search?near=…&radius=…`, and — the
important one — the **query feed** from the delivery spec accepts the same parameters. *"Tell me
about anything within 500 metres of this address"* is the single most compelling subscription this
project could offer, it requires no account and stores no personal data, and it is only possible once
geometry exists. The subscription is a URL containing a coordinate the subscriber chose; we never
learn who they are.

**`/map` must degrade.** ~69% of AI crawlers execute no JavaScript, and a map is JavaScript. Every
place gets a server-rendered page — `/places/{id}` — listing the decisions associated with it, in
date order, with citations. The map is the *index*; the place pages are the *record*. That also means
the geographic data reaches the OCD export and the MCP endpoint, where a machine consumer can ask
"what has happened at this parcel" and get sourced answers.

**Absence is stated.** A meeting with no located items says so, via `<Absence>` with a
`none-exist`-style reason. A map that shows an empty area implies nothing is happening there, which
is usually false and is exactly the kind of quiet misrepresentation the `<Absence>` grammar exists
to prevent.

## Tests the plan must require

- No join path exists from `members`/`minute_claims` to `places` — asserted by a schema test that
  enumerates foreign keys, so a future migration adding one fails the suite.
- An `inferred` place link is invisible on every public path.
- A `held` place link, and a link whose meeting is unpublished, are each invisible.
- A place link with `confidence <> 'inferred'` and no citation is rejected by the database.
- Rendering respects `precision`: a `block`-precision place never renders as a point.
- A boundary query resolves against the record's date, not today's — asserted with a district that
  changed.
- Re-importing the same parcel layer updates rather than duplicates.
- No map request leaves the origin for a third-party host — asserted in the frontend test against
  the rendered page's network references, the same way the CSP would.

## Open questions

**Does the map need PostGIS on day one, or can the pilot ship with parcels-as-GeoJSON?** Specified as
PostGIS, because the "near me" query is the whole point and it is the query GeoJSON-in-jsonb cannot
serve. But it is a production database image change on a live deployment, and the operator should
know that before it is scheduled rather than discover it during a deploy window.

**How far does "affects" reach?** A rezone affects the parcel; arguably it affects every adjacent
parcel, and a reader who lives next door would say so. `adjacent_to` is in the relation list, but
generating adjacency links automatically is an *inference*, and inferences are not publishable under
rule 2. Recommendation: compute adjacency at **query** time for the "near me" feed — which is a
factual statement about distance — and never store it as a claim about the decision. The distinction
is thin and it is worth the operator's eye.

**Which jurisdiction's GIS licence permits redistribution?** Unknown until probed. It goes in
`jurisdiction_access_policy` and, per the working agreement, a human reads the terms — that record is
the one thing in this system a subagent may not fill in.

# Plan — the public status page (`/status`)

> Mockup screen 08. Written 2026-08-10, against `docs/superpowers/specs/2026-08-09-phase-2-design.md`
> and the state of the tree at `61fce5e` + the `feat/archive-salvage` stack.

## What this is

A **read-only public projection** of the operator's Sources screen, at `/status`, reading
`ingestion_sources` and `ingestion_runs`. P2 built the same judgements for the operator
(`backend/src/services/pressroom/sources.ts`); this exposes them to a reader who is entitled to
know whether the thing reporting on their city's record-keeping is itself working.

The invariant from `SKILL.md` that this closes:

> **Failures are disclosed, not swallowed.** … the public status page reads from those rows. A
> transparency project that silently stops ingesting is worse than one that says "Bozeman: last
> successful sweep 6 days ago."

## The seven requirements, and where each is satisfied

| # | Requirement | Where |
|---|---|---|
| 1 | Every figure comes from a query, not a maintained file | `buildPublicStatus()` calls `listSources()`, which is three `SELECT`s. No literal figure anywhere on the page. |
| 2 | A never-run source prints "Never run", never omitted | `assessVerdict` already returns `never_run`; the projection keeps disabled and never-run rows. Migration 037 puts MT CERS in the table so it can be shown. |
| 3 | Silence is visible — past `expected_interval_hours` reads *Suspect* | `assessSilence` is reused verbatim. The page prints both numbers so a reader can disagree with the verdict. |
| 4 | Disabled sources stay listed with `disabled_reason` | Projection carries `enabled` and `disabled_reason`; the page renders the reason in the open, not behind a disclosure. |
| 5 | Collection-conduct disclosure in plain words, incl. the vendor-`robots.txt` exception | A summary section on `/status` linking to `/methodology#robots`, with the "if the disclosure comes down, the exception ends" sentence stated on **both** pages. |
| 6 | The public-records route offered alongside | Link to `/public-records` in the same section. |
| 7 | Public, unauthenticated, and leaks no meeting content | New public route, no `requireOperator`. The projection **drops `latest_run.error` and every run id**; a test asserts no unpublished-meeting string reaches the response. |

## Decisions

### D1 — Reuse `listSources`, project it down. Do not re-query.

The silence watch and the verdict ladder are judgements, and a second implementation of a judgement
is a second implementation that will disagree with the first after the next change. `listSources`
stays the single reader; `toPublicSource()` is a pure narrowing function over its output, which is
what makes the "no content leaks" test cheap and total.

### D2 — The public projection drops run **error text** and run **ids**.

`ingestion_runs.error` is free text written by whatever threw. It routinely carries a URL, and a
Granicus URL carries a meeting title in its query string. Publishing it would be publishing an
uncontrolled string on a page whose stated rule is that no unpublished meeting's content appears.

So the public row carries the run's **status, timestamps, record count and failure count** — the
figures — and says "this run recorded N failures" rather than reproducing what they said. Counts are
fine; content is not. The operator console keeps the full text, which is where it belongs: the
operator is the person who has to act on it.

Run **ids** go too: a public id invites a `/admin/runs/:id` fetch that 401s, which teaches nothing,
and the public page has no run-detail destination.

### D3 — One request, one endpoint: `GET /api/ingestion/sources`.

It joins the masthead's existing `/api/ingestion/status` under the same router, because both answer
"is this site's ingestion alive". The response carries `generated_at` so the page can state when the
figures were read, and `last_successful_sweep_at` so the page's headline figure and the masthead's
cannot disagree.

### D4 — MT CERS gets a row, because requirement 2 and requirement 1 together demand it.

The page must show MT CERS as never-run, and the page may only show what the table holds. So the
table has to hold it. Migration 037 inserts a `State of Montana` jurisdiction and an `mt-cers`
`ingestion_sources` row, `enabled = false`, with a `disabled_reason` that says plainly that no
adapter has been written yet.

Two consequences, both recorded rather than worked around:

- `jurisdictions.type` is a native enum of `('city','county')`. A statewide filing system is
  neither, so the migration adds `'state'`. `ALTER TYPE … ADD VALUE` may not be used in the same
  transaction that adds it, so migration 037 sets `config = { transaction: false }`.
- **`seeds/001_pilot_data.ts` deletes every `jurisdictions` row**, and `ingestion_sources` cascades
  from it. So on a seeded development or test database these rows are absent. That is pre-existing
  seed behaviour, not something this change introduces, and the status-page tests therefore build
  their own fixtures rather than leaning on either the seed or the migration.

### D5 — Paper ground, not `paper-sunk`.

`/status` is front-of-house. `PressroomShell` is the console's chrome and is not reused. No new
palette entry, no new dependency.

## Tasks

### T1 — `backend/src/services/ingestion-status.ts` (new)

Move nothing; add:

```ts
export interface PublicStatusRun {
  status: RunStatusValue;
  started_at: string;
  finished_at: string | null;
  records: number;
  failures: number;
}
export interface PublicStatusSource { … }        // no id, no error text
export interface PublicStatus {
  generated_at: string;
  last_successful_sweep_at: string | null;
  sources: PublicStatusSource[];
}
export function toPublicSource(source: PressroomSource): PublicStatusSource
export async function buildPublicStatus(db: Knex, now?: Date): Promise<PublicStatus>
```

`toPublicSource` is pure and exported so the leak test can hit it directly with a hostile
`PressroomSource`.

### T2 — `backend/src/routes/ingestion.ts`

Add `GET /sources` → `buildPublicStatus(db)`. Public; the router is already mounted outside
`/api/admin`.

### T3 — `backend/test/public-status.test.ts` (new) + register it in `backend/package.json`

The `test` script enumerates every file. An unregistered test never runs.

Assertions:

1. A source with no runs is **present** with `verdict: "never_run"` — not filtered out.
2. A disabled source is present with `verdict: "disabled"` and its `disabled_reason` verbatim.
3. A source whose last success is older than `expected_interval_hours` reads
   `silence.verdict === "suspect"`, with both numbers.
4. Within the interval reads `ok`; no interval reads `unknown`.
5. `lifetime_records` sums every run's counts, and is `0` — not absent — for a source with none.
6. **No leak.** Fixture: an unpublished meeting whose `location` is a unique token, an
   `agenda_items` row whose `title` and `description` are unique tokens, and an `ingestion_runs`
   row whose `error` embeds all three. `JSON.stringify(response.body)` contains none of them, and
   no `latest_run` object has an `error` or `id` key.
7. Reachable with no session cookie: 200.

### T4 — `frontend/src/types` — `PublicStatus*` types mirroring T1

### T5 — `frontend/src/pages/StatusPage.tsx` (new)

Sections, in order:

1. Kicker / headline / rule, then one paragraph: what this page is and that every figure on it is
   read from the ingestion tables at load.
2. **Last successful sweep** — the one big figure, or "No sweep yet" when null.
3. **Sources** — one table. Columns: Source, Verdict, Lifetime records, Last success, Silence
   watch, Latest run. A disabled row shows its reason inline. A never-run row says "Never run" in
   the accent colour. Zero lifetime records renders in the accent colour with the sentence.
   Wide table, `overflow-x-auto` on its own container.
4. **How this site collects** — plain words: public record only, one request every few seconds, an
   honest user agent, nothing re-fetched unchanged, no CAPTCHA/fingerprint/proxy evasion; the
   vendor-`robots.txt` exception named, with Granicus's `Disallow: /` stated and the sentence that
   the exception is valid only while disclosed. Links to `/methodology#robots` for the full text.
5. **Or ask for it directly** — links `/public-records`.

Empty-database case: "No ingestion source is registered" in the accent colour, saying that is a
configuration gap and not a quiet week.

### T6 — `frontend/src/pages/StatusPage.test.tsx` (new)

Never-run listed; disabled listed with reason; suspect rendered with both numbers; zero-record
sentence; the robots disclosure sentence present; `/methodology#robots` and `/public-records` links
present; load failure renders an alert rather than an empty page.

### T7 — Route + chrome

`/status` in `App.tsx`; a `Status` link in the `Layout` colophon so `chrome-links.test.tsx` keeps
passing and the page is reachable.

### T8 — `frontend/src/pages/MethodologyPage.tsx` correction

Lines ~330–336 currently say:

> A per-source table — every crawler, its URL, its cadence and its current health — publishes here
> when the ingestion registry ships. Until it does, this paragraph is the honest version…

That sentence stops being true the moment `/status` ships. Replace it with a link to `/status`.
Leave the robots.txt disclosure untouched — requirement 5 forbids weakening or burying it.

### T9 — `backend/migrations/037_register_mt_cers_source.ts`

Per D4. `transaction: false`.

## Verification

```
docker compose up -d db
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
bash ./deploy/test-deploy-aws-ssm.sh
```

Baseline not to regress: backend 782/202, frontend 222/28, zero lint errors, deploy self-test 61/0.

## Explicitly not built

- No auto-refresh / polling. A status page that re-requests on a timer is a status page that
  hammers its own API from every idle tab.
- No per-run drill-down. That is the console, and it is behind auth for a reason.
- No uptime or latency history for the site itself. Nothing measures it, and a graph drawn from
  nothing is the exact failure this page exists to make impossible.

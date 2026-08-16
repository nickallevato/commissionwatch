> **SUPERSEDED — landed via migration 035, marked 2026-08-16.**
>
> Verified present on 2026-08-16: `backend/migrations/035_add_full_text_search.ts`,
> `backend/src/routes/search.ts` mounted at `/api/search` in `app.ts`, and
> `backend/test/search.test.ts`.
>
> The acceptance criterion that mattered was checked rather than assumed: *an unpublished meeting,
> its agenda items and its document text never appear.* `search.test.ts` asserts that wall **in
> both directions** — absent while unpublished, present once published — because a test proving only
> absence would also pass against a search that returns nothing at all.
>
> The unchecked boxes below are **not outstanding work**. They are the step-by-step transcript
> of work that shipped; nobody went back to tick them. They are left unticked rather than ticked
> retroactively, because ticking a box nobody watched pass would be a claim, and this project does
> not make those. Read `CHANGELOG.md` and `docs/STATUS.md` for what is actually true now.

# P6 · Full-text search over the record — implementation plan

> 2026-08-10. Spec: `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P6.
> Branch `feat/archive-salvage`. Nothing is pushed: production is 502 on `/api/*`.

## What this builds

*Find me everything about this.* PostgreSQL full-text search over the published record — generated
`tsvector` columns with GIN indexes, `websearch_to_tsquery` for the query, `ts_headline` for the
snippet, one public `GET /api/search?q=`, and a search page on the public site.

## Why Postgres, and not a vendor

A3 of `docs/superpowers/specs/2026-08-09-archive-salvage-design.md` withdrew embeddings: the
operator has no OpenAI account, OpenRouter does not serve embeddings, and nothing consumed vectors.
The want underneath was real. Postgres answers it with **no vendor, no API key, no per-call cost and
no dimension decision**.

No embeddings provider is added here. `document_embeddings` and `vector(1536)` are not touched. If
exact-and-stemmed search proves insufficient in practice, *that* is the evidence that would justify
revisiting embeddings — with a requirement attached, rather than because the table was there.

## Corrections to the spec, made before writing code

The spec was written from the shape of the model rather than from the columns. Three things it says
do not exist as written.

1. **`meetings` has no `title`.** Migration 003 gives it `date`, `time`, `location`, `status`,
   `agenda_url`, `minutes_url`. Its only free text is **`location`**, and a venue is not a title, so
   it takes weight **`B`**, not `A`. Nothing in `meetings` earns `A`. The name a reader would call
   the sitting — *Weed Control Board* — lives in `commissions.name`, one table away, and **a
   `GENERATED ALWAYS` column may not reference another table**. Denormalising the commission name
   onto every meeting to make one index possible would put a second copy of a fact in the database
   for the convenience of a query; a meeting is already reachable through its agenda items, which
   are indexed, and through the venue. So `meetings.search_vector` covers `location` and says so.
2. **Nothing holds the extracted text of an artifact.** `extractDocumentText` runs in the parse
   stage, its output is turned into agenda items, and the text itself is discarded. There is no
   column to index. Migration 035 adds `artifact_texts` — one row per artifact, holding the text and
   a generated vector over it at weight `C`. Same row, so `GENERATED ALWAYS` is legal here; a vector
   on `artifacts` fed from another table would not have been.
3. **Migration numbering continues from 034.** `034_create_document_versions.ts` landed with P5.

## Design

### Schema — migration 035

Four generated columns, four GIN indexes, one new table.

```
agenda_items.search_vector  tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')) stored

meetings.search_vector      tsvector generated always as (
    setweight(to_tsvector('english', coalesce(location, '')), 'B')) stored

members.search_vector       tsvector generated always as (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(title, '')), 'B')) stored

artifact_texts (
  artifact_id  uuid primary key references artifacts on delete cascade,
  text         text not null,
  char_count   integer not null,
  extracted_at timestamptz not null default now(),
  search_vector tsvector generated always as (
      setweight(to_tsvector('english', coalesce(text, '')), 'C')) stored
)
```

`to_tsvector` with a **literal** configuration is `IMMUTABLE`; the one-argument form reads
`default_text_search_config` and is not, so it may not appear in a generated column. Every call in
this migration names `'english'` explicitly. Verified against the running Postgres 16 before the
migration was written.

`artifact_texts` cascades from `artifacts` — unlike `document_versions.artifact_id`, which
deliberately does not. The distinction: a version row is *evidence of a citation* and must fail
loudly if its artifact goes; extracted text is a derived convenience that can be re-extracted from
the bytes, and orphaning it would leave a searchable body with nothing behind it.

**Weighting is `A` title, `B` description, `C` body,** so a title match outranks a passing mention.
`ts_rank_cd` with the default weights `{0.1, 0.2, 0.4, 1.0}` (D,C,B,A) delivers that ordering, and a
test asserts it rather than trusting it.

### The parse stage writes the text it already extracted

`handlers.ts` `parse` calls `extractDocumentText`, then throws the text away. It now upserts
`artifact_texts` for `ctx.artifact.id` before extracting items, and counts
`artifact_text_written` in the run. Nothing else changes about the stage: no new fetch, no new
network path, no change to what is stored in MinIO.

Only agenda documents reach that line — `parse` returns early for minutes and packets, and for
unsupported bytes. That is a real limit on coverage and is stated on the search page rather than
implied away.

### The query

One SQL statement, four branches unioned, built once and used for both the page and the total so
the two cannot disagree.

- `websearch_to_tsquery('english', $q)` — quoted phrases and `-exclusions` the way a person expects.
- Match with `search_vector @@ query`, which is what the GIN indexes answer.
- Rank with `ts_rank_cd(search_vector, query)`; order by rank desc, then kind, then id, so paging is
  stable.
- Snippet with `ts_headline`, over the field that carries the body of the record: an agenda item's
  description (falling back to its title), a member's title, an artifact's text, a meeting's
  location.

**`ts_headline` marks matches with `chr(2)`/`chr(3)`, not with HTML.** The frontend splits the
string on those sentinels and renders `<mark>` elements itself. Returning `<b>` from the database
would mean the page had to trust and inject server-rendered markup, and the text being highlighted
comes from scraped PDFs — that is an XSS hole opened for a typographic effect.

An empty or whitespace-only `q`, and a `q` made entirely of stopwords, both produce an empty
`tsquery` that matches nothing. The endpoint answers `{ data: [], total: 0 }` with **200**. Search
of an empty database is the same path and the same answer. Production has zero rows today, so this
is the *normal* case, not the edge one.

### The publication wall

**Only published records are searchable.** Search that ignores `meetings.published_at` is a hole
straight through the review process: it would let anyone retrieve withheld content by guessing a
word, which is worse than the enumeration the 404-not-403 rule already prevents.

Every meeting-derived branch of the union is constrained by the same helper the other public paths
use — `whereMeetingPublished` — reached through:

| kind | path to the wall |
|---|---|
| `agenda_item` | `agenda_items.meeting_id → meetings.published_at` |
| `meeting` | `meetings.published_at` |
| `document` | `artifact_texts → document_versions → meeting_documents → meetings.published_at` |
| `member` | none — `members` has no meeting, and `/api/members` is already public |

`members` is deliberately outside the wall because it is already outside it: `GET /api/members`
lists every member to anyone. Search must not be *more* permissive than the rest of the API; making
it *less* permissive than a route that already exists would be a different, invented rule.

`search.test.ts` asserts an unpublished meeting, its agenda items, and its documents' text are
absent from results for a term they all contain, and that publishing the meeting makes all three
appear — the second half matters, because a test that only proves nothing is returned also passes
when search is broken.

### The endpoint

`GET /api/search?q=&limit=&offset=` → `{ data, total, query }`, public and unauthenticated. Results
are discriminated by `kind`:

```ts
type SearchResult =
  | { kind: "agenda_item"; id; title; snippet; rank; meeting_id; meeting_date;
      commission_name; jurisdiction_name; item_number }
  | { kind: "meeting";     id; title; snippet; rank; meeting_id; meeting_date;
      commission_name; jurisdiction_name }
  | { kind: "member";      id; title; snippet; rank; jurisdiction_name }
  | { kind: "document";    id; title; snippet; rank; meeting_id; meeting_date;
      commission_name; jurisdiction_name; document_type; sha256 }
```

`limit` defaults to 20, clamped to 1–100; `offset` clamps at 0 — the same clamping the meetings
router uses, because two different pagination policies on one API is a defect waiting for a
consumer.

### The UI

`/search` in the masthead, a single text field, results as hairline rows in the deployed design
system. No new dependency, no new palette token: `frontend/tailwind.config.ts` as it stands.

- The query lives in the URL (`?q=`), so a search is linkable and the back button works.
- A result row shows its kind as a kicker, its title, its dateline, and the snippet with matches in
  `<mark>` — `bg-accent-100 text-ink`, both existing tokens.
- Empty query renders the guidance, not "no results". Zero results renders "No published record
  matches" — *published* is in the sentence, because on a site with a review queue "nothing found"
  and "nothing published" are different statements.
- Failure renders the accent error line the other pages use.

## Deliberately not built

Named here rather than silently omitted:

- **Fuzzy matching / typo tolerance** (`pg_trgm`, similarity). Would need a second index strategy and
  a threshold nobody has evidence to set.
- **Synonym expansion and custom dictionaries.** A thesaurus that maps *variance* to *deviation* is
  an editorial judgement about the record, made in a config file, invisible in the result.
- **Semantic similarity.** This is the withdrawn embeddings work. It stays withdrawn.
- **Per-user search history and saved searches.** There are no public user accounts, and storing
  what an anonymous reader of a transparency site searched for is a surveillance feature.
- **Cross-field phrase precision.** Concatenating weighted vectors with `||` shifts the second
  operand's positions, so a phrase query can match across a title/description boundary — `"park was
  discussed"` matches a row whose title ends *park* and whose description begins *discussion*.
  Verified on the running database. The fix is a position gap Postgres does not offer on generated
  columns; the effect is an occasional over-broad phrase hit, never a leak of unpublished content.

## Tasks

1. **Migration 035** — the three generated columns, `artifact_texts`, four GIN indexes.
2. **`services/search.ts`** — the union query, the result types, limit/offset clamping.
3. **`routes/search.ts`** + mount at `/api/search` in `app.ts`.
4. **Parse stage** writes `artifact_texts`.
5. **`test/search.test.ts`**, registered in `backend/package.json`'s `test` script — which
   enumerates every file by path, so an unregistered test never runs.
6. **Frontend**: `types`, `hooks/useSearch.ts`, `pages/SearchPage.tsx`, the `/search` route, the nav
   item, the msw handler, `SearchPage.test.tsx`, and the nav assertion in `Layout.test.tsx` updated
   to include Search.

## Acceptance

From the spec, plus the invariant:

- [ ] A meeting whose agenda mentions a term is returned; one that does not is not.
- [ ] Results rank title matches above body matches.
- [ ] **An unpublished meeting, its agenda items and its document text never appear** — asserted.
- [ ] Search of an empty database returns an empty result set, not an error.
- [ ] Stemming holds: *meeting* matches *meetings*, asserted so a refactor cannot silently drop it.
- [ ] `websearch_to_tsquery` honours `"quoted phrases"` and `-exclusions`.
- [ ] Snippets carry the matching sentence with the match marked.

## Gate

```bash
docker compose up -d db
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
bash ./deploy/test-deploy-aws-ssm.sh
```

Baseline not to regress: backend 703 / 176, frontend 196 / 26, deploy self-test 61 passed / 0, zero
lint errors in both packages.

# P7 — the public-records request generator

> Plan of record for `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P7.
> Written 2026-08-10, before any code. Read the spec's *Legal grounding* subsection first —
> it is the reason this plan is shaped the way it is.

## What this is

Every gap the system already knows about becomes a pre-filled Montana public-records request:
letter text naming the requester, the record and the statute, drawn entirely from data.

Two surfaces produce **identical text**:

| Surface | Auth | Writes a row |
|---|---|---|
| `/public-records` on the public site | none | **no** |
| `/admin/records` in the Pressroom console | operator | yes — `records_requests`, status `draft` |

## The rule that shapes everything

**No statute, citation, deadline or fee provision is hardcoded anywhere in this codebase.**

MCA 2025 §2-6-1006 states its deadlines — acknowledge within 5 business days, respond within
90 days, requester has 30 days to answer a clarification — for *"an executive branch agency"* and
*"a public agency that is not a local government."* **Bozeman and Gallatin County are local
governments.** They fall under a different subsection that nobody on this project has read. Both
§2-6-1006 and §2-6-1009 are additionally marked **(Temporary)** in the 2025 edition, carrying
effective and termination dates.

So the numbers above appear in this plan, in the spec, and in no executable file. They are the
example of the failure, not a default.

Consequences, each of which gets a test:

1. `jurisdiction_records_law` holds citation, URL, deadlines and custodian **per jurisdiction**,
   with `verified_on` / `verified_by` recording who last checked it against the source.
2. The table **ships empty**. Populating it is a blocking operator task, recorded in
   `docs/STATUS.md`.
3. With no row for a jurisdiction the generator **refuses**, and the refusal names the table, the
   jurisdiction, and the columns a person must supply. There is no fallback citation, no national
   template, no "generic Montana" default.
4. `verified_on` older than 365 days raises a warning that renders in the console.

### The fee-waiver paragraph carries no citation — deliberate

The spec asks for "a fee-waiver request where applicable under §2-6-1006". §2-6-1006 is the fee
section, and its fee provisions are subject to the same local-government split as its deadlines.
So the generated letter **requests** a waiver or reduction of fees and asks to be notified before
any charge is incurred — a request, which needs no legal authority — and **asserts no statutory
entitlement to one**. If a jurisdiction's fee provision is later verified, it belongs in
`jurisdiction_records_law.notes` and in a follow-up change, not in a string literal here.
Recorded as a correction to the spec.

## Schema — migration `036_create_jurisdiction_records_law.ts`

```
jurisdiction_records_law (
  jurisdiction_id   uuid  pk  references jurisdictions on delete cascade,
  statute_citation  text  not null,
  statute_url       text  not null,
  acknowledge_days  int   null,   -- business days to acknowledge; null = not established
  respond_days      int   null,   -- calendar days to respond;     null = not established
  custodian_name    text  null,
  custodian_email   text  null,
  custodian_address text  null,
  verified_on       date  not null,
  verified_by       uuid  null references operators on delete set null,
  notes             text  null,
  created_at, updated_at
)
```

`jurisdiction_id` is the primary key: one law row per jurisdiction, and the absence of a row is
the refusal condition. Checks: both day counts `> 0` when present, `verified_on <= current_date`
(a verification dated in the future is a typo, and this table is the one place a typo becomes a
legal assertion), and both text columns non-blank.

The migration's `up` **inserts nothing**. A comment says why, at length.

## Gaps — derived from data, never a list

`backend/src/services/records/gaps.ts`. Four kinds, each a query:

| kind | derivation |
|---|---|
| `missing_minutes` | a `completed` meeting whose `date` is past, with `minutes_url IS NULL` and no `meeting_documents` row of `document_type = 'minutes'` |
| `unpublished_exhibit` | an `agenda_items` row whose `title`/`description` names an exhibit, attachment, appendix or enclosure, where the meeting has no `meeting_documents` row of type `attachment`, `packet`, `resolution` or `ordinance` |
| `disabled_source` | `ingestion_sources.enabled = false` — the body of records that source would otherwise cover, with its `disabled_reason` as context |
| `failed_fetch` | an `ingestion_jobs` row at stage `fetch` in status `failed` or `blocked`, whose `target` names a document URL and title |

Nothing enumerates jurisdictions, meetings or sources by name. Add a source, a body or a
jurisdiction and the gaps appear.

**Scope.** `missing_minutes` and `unpublished_exhibit` are anchored to a meeting and are offered
publicly **only when that meeting is published** — through `whereMeetingPublished`, not a retyped
`whereNotNull`. `disabled_source` and `failed_fetch` describe *our ingestion*, not the public
record; they are operator-only. A public gap list that named a source we cannot fetch or a job
that failed would be publishing our operational state as though it were the county's.

A gap id is `<kind>:<uuid>` — derived, stable, and re-resolvable, so a client hands back an id
rather than a payload the server would have to trust.

## The letter

`backend/src/services/records/letter.ts`, a pure function over
`{ gap, law, requester, today }` returning a string. No database, no clock of its own, no I/O —
which is what makes "identical text on both surfaces" testable by string equality.

Contents, in order: date; custodian block (falling back to "Public Records Custodian" and the
jurisdiction name when `custodian_*` is null); requester block; a subject line; the request
itself, naming the record, the meeting date, the commission and the document title; the citation
and — **only when `acknowledge_days` / `respond_days` are non-null** — the deadlines; the
uncited fee paragraph; a preference for electronic copies; a plain close.

**It does not allege wrongdoing, delay or bad faith.** No "failure to", no "despite", no
"overdue", no "as required". A `letter.test.ts` case asserts the rendered text of every gap kind
contains none of a list of accusatory terms.

## Nothing sends

- `generator.ts`, `gaps.ts` and `letter.ts` import nothing from `services/delivery/*`,
  `services/email-delivery`, `services/notification` or `resend`. A test reads the three files
  and asserts it.
- A test generates on both surfaces and asserts `deliveries`, `notifications` and
  `notification_deliveries` gained **zero** rows.
- The public route writes no row at all: a test counts `records_requests` either side.

## Routes

Public — `backend/src/routes/public-records.ts`, mounted at `/api/public-records`:

- `GET  /gaps` — published-scope gaps
- `POST /letter` — `{ gap_id, requester }` → `{ letter, gap, law, warnings }`, no row

Operator — added to `backend/src/routes/admin/records.ts`, above the existing `/requests/:id`
handlers so no path is shadowed:

- `GET  /gaps` — operator-scope gaps
- `GET  /law` — every jurisdiction, its law row or `null`, and a `stale` flag
- `POST /draft-request` — `{ gap_id, requester }` → the same letter **plus** a `records_requests`
  row in `draft`

Both refuse with **409** and a message naming the jurisdiction and the missing columns when the
law row is absent. 409, not 400: the caller's request is well-formed; the *server's* record is
incomplete, and saying so is the point.

## Frontend

- `PublicRecordsPage.tsx` at `/public-records`: gap list, requester form, generated letter in a
  read-only textarea with a copy control, and a standing sentence that this site sends nothing.
- Colophon link, and a link from `MethodologyPage` — where the statutory route is already
  promised in prose. This is that promise as a button.
- `MeetingDetailPage`: a "Request this record" link to `/public-records?meeting=<id>`, rendered
  only when the loaded meeting has no minutes document. Derived from what the page already has.
- `AdminRecordsPage`: a *Gaps in the record* section with a Draft request control, and a
  *Records law* section that renders the missing-row refusal and the stale-verification warning.

## Tests to register

`backend/package.json`'s `test` script enumerates every file. Add:

- `test/records-gaps.test.ts`
- `test/records-letter.test.ts`
- `test/records-generator.test.ts`
- `test/public-records.test.ts`

Frontend picks up `*.test.tsx` automatically: `PublicRecordsPage.test.tsx`, plus additions to
`AdminRecordsPage.test.tsx` and `chrome-links.test.tsx`.

## Order of work

1. Migration 036 + `docs/STATUS.md` operator task. Commit.
2. `gaps.ts` + tests. Commit.
3. `letter.ts` + tests (refusal, no-accusation, deadline omission). Commit.
4. `generator.ts` + routes, public and operator, + tests (refusal, nothing sends, no row).
   Commit.
5. Frontend. Commit.
6. Gate: four commands per package, plus `deploy/test-deploy-aws-ssm.sh`. Commit STATUS.

## Baseline not to regress

backend 721 / 177, frontend 211 / 27, zero lint errors either side,
`deploy/test-deploy-aws-ssm.sh` 61 passed / 0.

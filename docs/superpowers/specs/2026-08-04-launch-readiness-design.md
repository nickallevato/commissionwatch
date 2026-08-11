# W8 — Launch Readiness (corrections, open data, tested backups, accessibility)

> Status: approved 2026-08-04
> Gates **Launch 1**. Depends on W0 (green build) and W2 (ingestion queue, artifacts). The corrections surface for narrative findings depends on W3; the corrections surface for votes and flags does not, and ships at Launch 1.

## Goal

Close the four gaps that separate "a site that works" from "a site that can be published under a real name." Each is a promise the project makes in public and can be held to: how a finding was produced, how to get it fixed, how to get the underlying data, that the data survives the server dying, and that the site is usable by people who do not read it with a mouse and working colour vision.

None of these are features. They are the conditions under which the features are defensible.

---

## 1. Corrections and dispute policy

A civic accountability site that cannot itself be corrected has no standing to demand accountability from anyone. The mechanism has to exist before the first finding publishes, not after the first complaint.

### The Methodology page — `/methodology`

Static, in the primary navigation, linked from the footer of every page and from every finding. It states, in plain language and in this order:

1. **Who publishes this.** The accountable individual by name. Not "the team." A named person with an address for service. (Amended 2026-08-11: the responsible-organisation half was dropped at the operator's request; the named-individual requirement is unchanged and is the half the obligation rests on.)
2. **Where the data comes from.** Every adapter from W2, with its jurisdiction, its source URL, its fetch cadence, and its current health. The adapter table on this page reads from `ingestion_sources` — it cannot drift from reality, because it is not prose.
3. **How a document becomes a record.** Fetch → content-hash → store artifact → parse → analyse. The page states the invariant plainly: **every stage after `fetch` reads from a stored artifact, never from the live web**, so what you see was derived from a specific document with a specific SHA-256, which is named on the page.
4. **How anomaly flags are computed.** All six detectors described in one paragraph each, in terms a reader can check: what the detector looks for, what threshold fires it, what it does *not* mean. A flag is a reason to look, never a conclusion.
5. **How findings are generated and reviewed.** The model and the prompt version that produced each finding are recorded in `findings` and displayed on the finding. **The generation prompt itself is published in the repository and linked from this page.** A transparency project that keeps its own prompt secret is asking for a trust it will not extend.
6. **The publication gate.** Nothing naming a person publishes without an operator approving it, and the approving operator and timestamp are recorded.

### What the system does not do

Its own section on the page, because the boundaries are the part people get wrong:

- It does not assert motive, intent, corruption, or illegality. It describes what the record shows — votes, timing, procedure, patterns.
- It does not transcribe meeting video or attribute spoken statements to speakers.
- It does not use non-public records, leaked material, or anything obtained other than as a member of the public.
- It does not score, rank, or grade officials.
- It does not predict votes.
- It does not infer party affiliation for nonpartisan offices. `members.party` is null unless the office is partisan and a source states it.
- It does not accept payment, from anyone, to publish, suppress, amend, or prioritise anything. Stated flatly, with the funding source named.
- It does not auto-publish. Ever.

### The dispute route — `/corrections/dispute`

One named route, reachable in three clicks from anywhere on the site, plus `corrections@commissionwatch.bmux.sh` which files into the same table. A dispute is a first-class record, not an inbox.

The form asks for: the URL or item being disputed, what specifically is wrong, what the correct fact is, the evidence for it, and who is submitting (name, organisation, capacity — subject of the claim / representative / member of the public). Only the URL and the description of the error are required. **A dispute is never gated on identifying yourself**; an anonymous dispute pointing at a document that proves the site wrong is still right.

### The response commitment

Published on the page, and measured against the table rather than asserted:

| Stage | Commitment |
|---|---|
| Automated acknowledgement with a reference number | Immediate |
| Human acknowledgement, dispute triaged | 2 business days |
| Substantive response — corrected, upheld with reasoning, or clarified | 10 business days |
| If the item is credibly shown to be materially wrong: item unpublished pending review | 24 hours from that determination |
| Correction published | 3 business days from determination |

Two mechanisms stop this from being decoration:

**Unpublishing is not deleting.** An item pulled pending review is replaced at its own URL by a notice saying it is under review and when, with the original text preserved in `corrections.original_text`. The URL never 404s and never silently changes meaning.

**The clock is public.** `/corrections` displays, computed live from `disputes`: open disputes, median days to substantive response over the last 12 months, and the count resolved as corrected versus upheld. Any dispute open past 10 business days appears on the public log automatically as "open, unresolved, N days" — subject and date only, with the submitter's identity shown only if they opted in. The project cannot quietly sit on a complaint, because sitting on it publishes itself.

### The corrections log — `/corrections`

Stable, permanent, indexed, in the primary navigation. Reverse chronological. Each entry has its own permanent URL at `/corrections/CW-2026-0004`, is included in the sitemap, and is never removed.

**A correction is never a silent edit.** The rule holds structurally, not by discipline:

- Before a published item is amended, the exact published text is snapshotted into `corrections.original_text`. The snapshot happens in the same transaction as the amendment; there is no code path that amends without it.
- The corrected item carries a permanent, non-dismissible notice linking to its correction entry. Not a tooltip, not a footnote in grey — in the flow of the page.
- The correction entry shows the original claim, the corrected claim, the correction type, the reason, the date of original publication, the date of correction, and the source document that establishes the correction.
- `corrections` is append-only, enforced by a Postgres trigger that raises on `UPDATE` and `DELETE`. The only way to change a correction is to publish a correction to the correction. **This is asserted by a test**, alongside the publication invariant, because the append-only property is the entire value of the log.

### Data model

#### `disputes`
`id`, `reference` (`CW-D-2026-0117`, unique, generated), `subject_type` (`finding` | `finding_claim` | `anomaly_flag` | `vote` | `member` | `meeting`), `subject_id`, `subject_url`, `claimed_error` (text, not null), `asserted_correct_fact` (text), `evidence_urls` (text[]), `evidence_artifact_ids` (uuid[]), `submitter_name`, `submitter_org`, `submitter_email`, `submitter_capacity` (`subject` | `representative` | `public` | `anonymous`), `consent_to_publish_identity` (boolean, default false), `received_at`, `acknowledged_at`, `responded_at`, `resolved_at`, `status` (`received` | `acknowledged` | `investigating` | `resolved_corrected` | `resolved_upheld` | `resolved_clarified` | `withdrawn`), `resolution_note`, `correction_id` (nullable FK).

Submitter columns are PII. They are never exported, never returned by a public API route, and never rendered publicly unless `consent_to_publish_identity` is true.

#### `corrections`
`id`, `reference` (`CW-2026-0004`, unique, sequential, never reused), `subject_type`, `subject_id`, `subject_url`, `original_text` (not null), `corrected_text` (nullable — null for a full retraction), `correction_type` (`factual_error` | `misattribution` | `omitted_context` | `retraction` | `clarification` | `typographical`), `materiality` (`substantive` | `minor`), `reason` (not null), `source_artifact_id` (nullable FK — a correction backed by a document names it), `dispute_id` (nullable FK), `original_published_at`, `corrected_at`, `published_at`, `approved_by`.

`dispute_id` is nullable because most corrections should be self-initiated. A corrections log that only ever fires when someone complains is a complaints log.

`materiality` drives display: `substantive` corrections surface on the front page for 7 days. `typographical` ones do not, and the type is stated so nobody has to take the classification on faith.

---

## 2. Public data export and licensing

The claim "here is what the record shows" is only checkable if you can get the record. Export is not a nice-to-have on a transparency project; it is the proof.

### Surface

`/data` — a human page describing the dataset, the schema, the licence, the update cadence, and the withheld fields. Carries `Dataset` JSON-LD so it is discoverable through Google Dataset Search.

| Path | Contents |
|---|---|
| `/data/latest/` | Stable path, always the most recent successful export |
| `/data/latest/{table}.csv` | One CSV per exported table, RFC 4180, UTF-8, `\n`, ISO 8601 UTC timestamps |
| `/data/latest/{table}.jsonl` | JSON Lines — one record per line, so a 2 GB table streams |
| `/data/latest/commissionwatch-{date}.zip` | Full bundle, every table, plus the manifest |
| `/data/latest/manifest.json` | Per-file SHA-256, row counts, `generated_at`, schema migration id, licence, source commit |
| `/data/latest/datapackage.json` | Frictionless Data descriptor — field types and constraints, so the export loads into standard tooling without hand-written glue |
| `/data/archive/{date}/` | Dated snapshots |

Retention: every nightly kept 30 days, the 1st-of-month export kept indefinitely. At launch scale the whole corpus is tens of megabytes; the archive is what makes "what did the site say in March" answerable.

### Exported tables

`jurisdictions`, `commissions`, `meetings`, `agenda_items`, `meeting_documents`, `members`, `votes`, `anomaly_flags`, `findings` (published only), `finding_claims`, `corrections`, `ingestion_sources`, `ingestion_runs`, `artifacts` (metadata only), `restore_drills`.

`ingestion_runs` and `restore_drills` are in the export deliberately. The operational record of how the data was gathered, and whether it survives, is part of the data.

### Withheld, and why

| Withheld | Reason |
|---|---|
| `alert_subscriptions` — whole table | Subscriber email addresses. No public interest whatsoever |
| `notifications` — whole table | Recipient-linked |
| `alert_subscriptions.verify_token`, `.unsubscribe_token` | Credentials |
| `delivery_channels.config_encrypted`, `channel_routes`, `deliveries` (W7) | Credentials and operational routing |
| `disputes.submitter_*` | PII. The substance of a dispute publishes; the person does not, absent consent |
| `document_embeddings.embedding` | 1536-dimension vectors, derivative and regenerable from the artifacts. Row metadata (document, model, chunk range) is exported; the floats are not |
| `findings` where `status <> 'published'` | Exporting drafts would route around the review gate. **Asserted by a test** |
| Artifact object bytes | Not our documents to relicense. Every `artifacts` row carries the original `source_url` and the SHA-256, so anyone can fetch the same file from the government and verify byte-for-byte that it is the one we parsed |
| `members.party` where the office is nonpartisan | Not withholding — it was never inferred. Null means unknown, not "independent" |

`members.email` **is** exported when it is the official government address the jurisdiction itself publishes. Withholding a published official contact from a transparency dataset would be theatre. Personal addresses are never collected, so there are none to withhold.

The withheld list ships as a table on `/data`, not as an omission a reader has to notice.

### Licence

| Layer | Licence |
|---|---|
| The compiled dataset — selection, structure, generated text, findings | **CC BY 4.0**, attribution to "CommissionWatch — commissionwatch.bmux.sh" |
| The code | **MIT** (already in `LICENSE`) |
| The underlying government documents | Public records. **No licence asserted by this project.** They are not ours |

Stated explicitly on `/data`: individual facts are not copyrightable, and the licence covers the compilation, not the truth that a commissioner voted no on 14 July.

One further thing is asked and marked as a request rather than a term, because CC BY prohibits imposing additional restrictions and pretending otherwise would be a false claim: **if you republish a finding, republish its corrections status with it.** The API exposes `corrections` on every finding response so that this costs nothing.

### The API

Versioned at `/api/v1`. The existing unversioned routes (`/api/meetings`, `/api/members`, …) alias to v1 for a 180-day window, emitting `Deprecation: true` and a `Sunset` header, and then stop.

The stability contract, published on `/data`:

- Within v1, changes are additive only. Fields are never removed, renamed, or retyped. Enum values may be added, so clients must tolerate values they do not recognise.
- A breaking change means `/api/v2`. v1 then runs for a further 180 days with a `Sunset` header before removal.
- OpenAPI 3.1 at `/api/v1/openapi.json`. **A contract test asserts every mounted v1 route appears in the document and every documented route is mounted**, because an API description maintained by hand is an API description that is wrong.

Mechanics: cursor pagination (`limit` default 50, max 200, opaque `next_cursor`); `Cache-Control: public, max-age=300, stale-while-revalidate=600` with `ETag` and `If-None-Match`; `Access-Control-Allow-Origin: *` on GET, since it is public data; no API key, because putting a signup form in front of public records is friction that buys nothing.

Rate limit: 60 requests/minute per IP, burst 120, `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` on every response, `429` with `Retry-After` on breach. **The 429 body names the export URL**, because someone hitting the rate limit is almost always someone who wants the whole dataset and does not know it is sitting there as a zip file.

### Generating exports without hammering the database

The export is **not** generated from the production database. It is generated from the nightly restore, described in §3.

At 03:15 America/Denver, after the backup has been restored into a scratch container and verified, the export job reads from *that* database — a `REPEATABLE READ READ ONLY` transaction with server-side cursors, so nothing is buffered in memory and nothing competes with live traffic. The primary sees zero export load.

This coupling is the point, and it runs in both directions:

- The export cannot be generated unless the backup restored, so **a broken backup produces a stale export, which is visible on a public page.**
- The restore is exercised every single night against real production data rather than quarterly against a hope.

Written artifacts go to the MinIO bucket `public-exports`, which Caddy serves as static files with a one-hour cache. **Serving an export never touches Postgres.** The scratch container is destroyed when the job finishes.

If the export job fails, `/data` displays the age of the current export and the failure, and W7 emits `export.failed` to Discord. It does not quietly serve yesterday's files as though they were today's.

---

## 3. Backups with a tested restore

An untested backup is a belief. The deliverable here is not the snapshot; it is the recorded evidence that a restore was performed and the result was correct.

### What is backed up

**Postgres**, two ways, because they answer different questions:

| Mechanism | Cadence | Purpose |
|---|---|---|
| `pg_basebackup` | Nightly 02:00 America/Denver | Base for point-in-time recovery |
| `pg_receivewal`, streaming continuously to `/backup/wal` | Continuous, `archive_timeout = 300s` | Bounds RPO at 5 minutes |
| `pg_dump -Fc -Z6` | Nightly 02:00 | Portable, inspectable, restorable into a different major version |

**MinIO**: `mc mirror` to the offsite bucket nightly at 02:20. Artifacts are content-addressed and immutable, so the mirror is append-only and incremental. Bucket versioning is on, so a mistaken delete is recoverable.

### Retention and offsite

Offsite is `s3://commissionwatch-backups` in `us-west-2`, separate AWS account from the host.

| Prefix | Retention |
|---|---|
| Local `/backup` volume on the host | 7 nightlies |
| `nightly/` | 30 days |
| `weekly/` (Sunday) | 90 days |
| `monthly/` (1st) | 365 days |
| `yearly/` (1 Jan) | 7 years |

Three properties that matter more than the schedule:

1. **The backup writer cannot delete.** Its IAM policy grants `s3:PutObject` and `s3:ListBucket` only. A compromise of the host cannot destroy the backups.
2. **Object Lock in compliance mode, 30 days, on `nightly/`.** Not even the root credential can shorten it. This is the specific control that survives ransomware.
3. **The dump is encrypted client-side with `age` before upload**, to a recipient public key held in the environment, private key held offline by the operator. SSE-KMS is also on, but an S3 credential leak must not yield the database, and server-side encryption alone does not prevent that.

### Targets

| Metric | Target | Path |
|---|---|---|
| RPO | **≤ 5 minutes** | Base backup + WAL replay |
| RPO | ≤ 24 hours | Logical dump only, if WAL is unavailable |
| RTO | **≤ 60 minutes** to full public service on new hardware | Quarterly rebuild drill |
| Database restore time | ≤ 15 minutes | Nightly drill threshold — exceeding it fails the drill |

These are targets. The numbers actually achieved are recorded per drill in `restore_drills` and published on `/methodology`, so the gap between target and reality is visible rather than assumed.

### The nightly drill

Not a checksum. A restore, followed by running the real application against the restored data.

```
02:00  pg_basebackup + pg_dump -Fc  →  /backup
02:00  primary writes backup_manifest: per-table row counts, migration id, taken_at
02:20  mc mirror MinIO  →  s3://commissionwatch-backups
02:25  age-encrypt + upload dump and basebackup (PutObject only)
02:30  spin up scratch container `commissionwatch-restore`
       pg_restore from the *offsite copy*, downloaded and decrypted
02:50  verification suite (below)
03:15  export job reads the restored DB  →  public-exports
03:30  tear down scratch container; write restore_drills row
```

The nightly restores from the **offsite** copy, not the local one. Restoring from the disk you are trying to protect against losing proves nothing.

### How the drill is verified, not assumed

`pg_restore` exiting 0 proves bytes moved. These seven checks prove the system works. Any failure fails the drill.

1. **Exit status.** Necessary, never sufficient. Listed first so it is clear it is not the test.
2. **Schema version.** `knex_migrations` in the restored database matches the migration count committed at the backup's source commit. Catches a stale dump restoring cleanly.
3. **Row-count reconciliation.** Every exported table's restored count is compared against the `backup_manifest` the *primary* wrote at dump time. Any drift fails. Comparing the restore against itself would be circular.
4. **Referential integrity.** All foreign key constraints re-validated on the restored database, plus an explicit orphan query across every FK edge. A dump restored with constraints untrusted looks fine and is not.
5. **Application smoke test.** The production backend image is started against the restored database, and the designated read-only subset of the API contract tests runs against it. `GET /api/v1/meetings?limit=1` must return a real meeting whose votes resolve to real members. **This is the check that makes it a drill rather than a file copy.**
6. **Cross-store canary.** A known meeting UUID, seeded at launch and asserted by reference, must be present with its exact vote tally, and the artifact SHA-256s its `finding_claims` cite must resolve to real objects in the mirrored MinIO bucket. Backups that restore the database and lose the documents are the classic and most expensive failure — every citation on the site would break while every page still rendered.
7. **Freshness.** The latest `ingestion_runs.finished_at` in the restored database is within 26 hours of drill start. Catches a backup pipeline that is silently backing up a frozen replica.

### `restore_drills`

`id`, `drill_type` (`nightly_automated` | `quarterly_rebuild`), `started_at`, `finished_at`, `backup_taken_at`, `backup_source` (`offsite` | `local`), `backup_sha256`, `backup_bytes`, `restore_seconds`, `measured_rpo_seconds` (backup content freshness against drill start), `measured_rto_seconds` (quarterly only), `checks` (jsonb — one entry per check above, with pass/fail and measured value), `status` (`passed` | `failed`), `failure_reason`, `operator`, `runbook_commit`.

Exported publicly. `/methodology` renders the last drill's date, status, and measured restore time.

### The quarterly rebuild drill

The nightly proves the database restores. It does not prove *the operator can rebuild the service*. Once a quarter, on a fresh host, with the local backup volume deliberately made unavailable:

1. Provision a clean host from the deployment config in the repository.
2. Restore Postgres and MinIO from offsite only.
3. Bring up backend, frontend, and Caddy.
4. Verify the public site serves real data, citations resolve to documents, and the export downloads and passes its own manifest checksums.
5. Record the wall-clock time from step 1 to step 4 as `measured_rto_seconds`.

**The drill is executed by following `docs/runbooks/restore.md` literally, not from memory.** If a step is missing, ambiguous, or wrong, the drill fails and the runbook is corrected — that is the point. The runbook commit is recorded on the drill row, so a passed drill certifies a specific version of the document.

The result publishes on `/methodology`: "Last full rebuild drill: 2026-08-04, restored in 41 minutes." Publishing the date is what stops the practice from quietly lapsing; a stale date is a visible fact rather than a private one.

A failed drill of either kind emits `backup.drill_failed` through W7 and marks the public status page degraded.

---

## 4. Accessibility and shareability

### WCAG 2.2 AA is the conformance target

Not aspirationally. It is checked in CI, and the checks are computed rather than eyeballed.

#### Contrast, computed against the approved palette

All ratios below are computed by WCAG 2.x relative luminance, and hold the two sanctioned page grounds — `paper` `#FFFDF8` and the alternate band `paper-sunk` `#F6F3EA`. The band is included because it is exactly what gets skipped.

| Foreground | on `paper` #FFFDF8 | on `paper-sunk` #F6F3EA | Verdict |
|---|---|---|---|
| `ink` `#16161A` | **17.75:1** | 16.26:1 | Passes AAA. Body text |
| `ink-soft` `#3A3A40` | **11.11:1** | 10.18:1 | Passes AAA |
| `accent` `#B03A2E` | **5.92:1** | 5.42:1 | Passes AA at all sizes |
| `muted` `#6E6A62` | **5.30:1** | 4.85:1 | Passes AA at all sizes — but the margin on the band is 0.35, so `muted` is the floor and nothing may be lightened past it |
| `pass` `#1E6B45` | **6.37:1** | 5.83:1 | Passes AA |
| `sev3` amber `#C2860C` | **3.08:1** | 2.82:1 | **Fails AA for text** |
| `sev2` grey `#8A857C` | **3.61:1** | 3.31:1 | **Fails AA for text** |
| `rule` `#E8E3D8` | 1.26:1 | 1.15:1 | Decorative hairlines only |
| `paper` `#FFFDF8` on `accent` fill | **5.92:1** | — | Passes AA. Reversed chips are fine |
| `ink` `#16161A` on `sev3` fill | **5.76:1** | — | Passes AA. Amber works as a fill, not as ink |

Three corrections to the token layer follow, and they are the only palette changes:

- **`sev3` `#C2860C` is a fill colour, never a text or icon colour on paper.** As a background under `ink` it is 5.76:1 and permitted. Where amber *text* is genuinely required, a new token `sev3-text` `#7A5200` gives **6.81:1** on paper and 6.24:1 on the band.
- **`sev2` `#8A857C` is likewise fill-only.** Severity text at that rank uses `muted` `#6E6A62` (5.30:1).
- **`rule` `#E8E3D8` at 1.26:1 cannot carry a form control's boundary.** SC 1.4.11 requires 3:1 for the visual boundary of a UI component. Decorative hairlines between articles are exempt and keep `rule`. Input borders, select borders, and checkbox outlines take a new token `control-border` `#918978` — **3.41:1** on paper, 3.13:1 on the band. This matters for the dispute form in §1, which is the site's only real form.

**The focus ring** is `accent` at 2px with `outline-offset: 2px`, already in `index.css`. The offset places the ring on the page ground, so it measures 5.92:1 on paper and 5.42:1 on the band — clearing the 3:1 requirement of SC 1.4.11 on both, including over an accent-filled button, where the ring never touches the fill.

**These ratios are enforced by a test, not by this document.** A unit test imports the token values from `tailwind.config.ts`, computes the ratio for every sanctioned foreground/background pair, and asserts each clears its threshold. Editing a hex to something prettier fails CI. Numbers in a spec rot; numbers in a test do not.

#### Severity is never conveyed by colour alone

SC 1.4.1. Every severity and every vote outcome carries three encodings:

1. The word — "Critical", "High", "Medium", "Low"; "Passed", "Failed".
2. A distinct glyph shape, distinguishable in greyscale.
3. A rank, where rank is meaningful.

Enforced structurally rather than by review: there is exactly one `<SeverityTag>` component and one `<VoteOutcome>` component. **Two tests**: no component outside those two references a `sev1`–`sev5`, `pass`, or `fail` token; and the rendered output of each contains the severity or outcome word as text. The existing `AnomalyBadge` and `VoteBreakdown` are refactored onto them.

`pass` `#1E6B45` against `fail` `#B03A2E` is the standard deuteranopia collision. It is retained, because with word plus shape the colour is redundant reinforcement rather than the signal.

#### Focus order and keyboard

- A skip link is the first element in the DOM, visually hidden until focused, targeting `<main id="main" tabindex="-1">`.
- DOM order equals visual order. The front page's rail comes after the main column in the DOM and is placed with CSS grid — never with `order`, never with absolute positioning, because both desync reading order from appearance.
- **No positive `tabindex` anywhere.** Lint rule plus test.
- Landmarks, one each: `<header>`, `<nav aria-label="Sections">`, `<main>`, `<aside aria-label="Live flags">`, `<footer>`.
- **SPA route changes move focus.** `react-router-dom` does not do this, and it is the most-missed accessibility defect in React sites: after navigation, keyboard focus is still on the link in the old page's nav and a screen reader announces nothing. On every route change, focus moves to the new view's `<h1 tabindex="-1">` and a polite live region announces the new page title. Asserted by test across all routes.
- Every interactive target is at least **24×24 CSS px** (SC 2.5.8). The current `.cite` chip computes to roughly 21px tall — 10px font, 1.5 line-height, 2px vertical padding, 1px borders — and takes `min-height: 24px` with vertical padding adjusted to match. The chips are the densest interactive element on the site and would have been the failure.
- SC 2.4.11, focus not obscured: the masthead does not stick. If it ever does, sticky height is mirrored into `scroll-margin-top` on focusable elements in the same commit.
- SC 2.5.7, dragging: nothing on the public site is drag-only. W6's graph explorer must ship keyboard pan and zoom controls alongside drag — noted there as a dependency of this section.
- SC 3.3.8, accessible authentication: the operator login accepts paste into the password field and uses no puzzle, transcription, or image-recognition step.

Separately from conformance — WCAG sets no minimum font size — the `.kicker` and `.label-sm` classes are currently `0.5rem`, which is 8px of letter-spaced uppercase. That is below any defensible legibility floor. Both go to `0.6875rem` (11px). Called out as an editorial rule, not a WCAG claim, because conflating the two makes the conformance claim less trustworthy.

#### Screen-reader labelling

- Vote grids and rundown sheets are real `<table>` elements with `<caption>`, `<th scope="col">`, and `<th scope="row">`. Not divs with grid classes.
- Abbreviated figures get a spelled-out accessible name: "4–1" renders with `aria-label="4 to 1, passed"`.
- Citation chips carry meaningful link text — "Source: Gallatin County agenda, 14 July 2026, page 3". Never "source", never a bare icon. The chip is the project's whole evidentiary claim; an unlabelled one is a broken promise to exactly the users who cannot see it.
- Decorative SVG is `aria-hidden="true"`. Meaningful SVG gets `role="img"` and a `<title>`.
- Dates render as `<time datetime="2026-07-14">14 July 2026</time>`.
- The live-flags rail is `aria-live="polite"`. Nothing on the site is `assertive`; a new anomaly flag does not warrant interrupting someone mid-sentence.
- Dispute-form errors: `aria-invalid` on the field, `aria-describedby` to the message, an error summary at the top of the form linking to each offending field, and error text that never relies on colour.

#### Fixing the shell

`frontend/index.html` currently ships `<html lang="en" class="dark">` with `<body class="bg-gray-900 text-gray-100">`, while `tailwind.config.ts` sets `darkMode: "class"` and the design system states there is no dark theme. Every `dark:` variant in the codebase is therefore permanently active, and the shell paints dark grey before React mounts. It is fixed here rather than filed elsewhere, because §4 rewrites that `<head>` anyway.

#### Testing

- `axe-core` run against every page component in vitest — dev dependency, no runtime cost.
- The computed-contrast test over the token layer, described above.
- The keyboard-order test: render, tab through, assert the sequence.
- The two colour-alone tests.
- The route-change focus test.
- Manual keyboard-only and VoiceOver passes on the front page, a meeting detail, a finding, and the dispute form before Launch 1. Automated tooling catches roughly a third of real barriers; the remainder is someone using the site without a mouse.

### Shareability

#### Per-route metadata in an SPA

Social scrapers do not execute JavaScript, so React cannot produce Open Graph tags. User-agent sniffing is the usual workaround and is rejected here — it is fragile and it is cloaking.

Instead the frontend's Node server injects tags into the built shell server-side. For a known shareable route pattern it fetches metadata from `/api/v1/meta?path=…` and substitutes the head block; for anything else it serves site defaults. **Timeout 200ms, and on timeout it serves defaults**: a share card is never worth a slow page.

Shareable patterns: `/`, `/meetings/:id`, `/members/:id`, `/findings/:slug`, `/corrections/:reference`, `/methodology`, `/data`.

**The meta endpoint may not read a finding whose status is not `published`.** The publication gate reaches into the metadata layer, or an unapproved draft leaks through a link preview. Asserted by test.

#### Tags

Every page: `<title>`, `<meta name="description">` (150–160 characters), `<link rel="canonical">` absolute, `<meta name="robots" content="index,follow,max-image-preview:large">`.

Open Graph: `og:type` (`website` for the front page, `article` for findings and corrections), `og:site_name`, `og:title`, `og:description` (≤ 200 characters, truncated at a word boundary with an ellipsis), `og:url` absolute, `og:image` absolute, `og:image:width` `1200`, `og:image:height` `630`, `og:image:alt`, `og:locale` `en_US`. Findings and corrections add `article:published_time` and `article:modified_time`.

Twitter: `twitter:card` `summary_large_image`, `twitter:title`, `twitter:description`, `twitter:image`, `twitter:image:alt`. **No `twitter:site`** until an account exists — inventing a handle is a small lie in the head of every page.

Cards: one 1200×630 PNG per route type, generated at build time from the design tokens — paper ground, ink serif headline, accent rule — committed under `frontend/public/og/`. Per-finding generated cards need a rendering service and are out of scope; a correct static card beats an absent dynamic one.

JSON-LD: `Organization` on the front page, naming the publisher; `Article` on findings with `citation` entries pointing at the source documents, which makes the provenance machine-readable; `Dataset` on `/data` with `distribution`, `license`, and `creator`.

#### `sitemap.xml`

Generated by the nightly export job — from the restored database, same as everything else in §2 — and written as a static file that Caddy serves. It costs the primary nothing.

Included: static pages, every meeting with published data, every member, every published finding, every correction. `<lastmod>` from `updated_at`. Excluded: `/admin`, paginated pages beyond the first, and any finding not `published`.

A sitemap index kicks in above 50,000 URLs or 50 MB per file. That is years away at launch volume, but the rule is stated so nobody discovers the limit by hitting it.

#### `robots.txt`

```
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /data/archive/

Sitemap: https://commissionwatch.bmux.sh/sitemap.xml
```

**All crawlers are allowed, including AI crawlers.** Publishing a dataset under CC BY and then blocking GPTBot would be incoherent. Abusive crawl rates are handled where they should be — rate limiting at Caddy — rather than by an honour-system directive. `Crawl-delay` is omitted because Google ignores it and stating it would imply a control that does not exist.

`/data/archive/` is excluded so 30 nightly snapshots of the same tables do not flood the index. `/data/latest/` is crawlable, which is the copy anyone should be citing anyway.

There is one more reason this file matters. Every request to `bozemanmt.gov`, including for its own `robots.txt`, returns `403` from an Akamai edge. A transparency project that blocked crawlers the way its subject blocks us would be a poor joke.

#### Verification

None of this is testable while the Caddyfile's `import allowlist` is in place. Once W4 drops it, the launch checklist verifies from an off-network host: the Facebook sharing debugger and a Slack unfurl against a finding URL and a correction URL, Google's Rich Results Test against the `Article` and `Dataset` markup, `curl` for `robots.txt` and `sitemap.xml`, and Search Console sitemap submission.

---

## Sequencing

| | Ships at | Depends on |
|---|---|---|
| Methodology page, dispute route, corrections log, `corrections` + `disputes` schema | **Launch 1** | W0 |
| Export, licence, `/api/v1`, OpenAPI | **Launch 1** | W2 |
| Backups, nightly drill, `restore_drills` | **Before Launch 1 opens to the public** | W4 |
| First quarterly rebuild drill | Within 30 days of Launch 1 | — |
| WCAG 2.2 AA, contrast test, OG/sitemap/robots | **Launch 1** | W1 |
| Corrections surface on narrative findings | Launch 2 | W3 |

The backup drill gates public launch rather than following it. Losing a database before anyone is reading is embarrassing; losing one after a jurisdiction has been told to rely on the site is different.

## Out of scope

- Dynamically generated per-finding Open Graph images
- Multi-language content or `hreflang`
- A public bug bounty or formal vulnerability disclosure programme
- Warm standby or automated failover — RTO 60 minutes on a single host is the accepted posture
- WCAG AAA. Where a AAA criterion is already met, as the ink-on-paper ratios are, it is stated as fact and not claimed as conformance
- Public user accounts for dispute tracking; the reference number in the acknowledgement email is the whole mechanism

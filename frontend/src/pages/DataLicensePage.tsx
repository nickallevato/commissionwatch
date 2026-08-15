import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type {
  DataArchiveIndex,
  DataManifest,
  DataManifestDataset,
} from "@/types";

/**
 * `/data` (and its original address `/data-license`) — the dataset, the terms
 * under which it can be reused, what is withheld from it and why, and how to
 * verify any record against the government document it came from.
 *
 * Three layers are licensed separately and are never conflated: the compiled
 * dataset (CC BY 4.0), the code (MIT, per the repository LICENSE file), and the
 * underlying government documents (public records, no license asserted here).
 *
 * **The dataset table is a query, not a list.** It is read from
 * `GET /api/data` — the export's own manifest — so the tables, their columns,
 * their row counts and how each row traces to a stored document are whatever
 * the API actually serves. A schema table maintained by hand is a schema table
 * that is wrong eventually, which is the failure this project exists to find in
 * other people's publications. Everything that does not depend on the record —
 * the license, the attribution line, the withheld list — is static and still
 * renders when the API does not.
 *
 * The page carries `Dataset` JSON-LD so the export is discoverable through
 * Google Dataset Search. Nothing in that block is asserted anywhere else on the
 * page: a machine-readable claim nobody reads is exactly where a false one
 * survives longest.
 */

const REVISED = "August 10, 2026";
const SITE = "commissionwatch.bmux.sh";
const REPO_URL = "https://github.com/nickallevato/commissionwatch";
const CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/";
const CORRECTIONS_EMAIL = "corrections@commissionwatch.bmux.sh";

/* ---------------------------------------------------------------------------
   The three layers
   ------------------------------------------------------------------------- */

interface Layer {
  readonly layer: string;
  readonly license: string;
  readonly note: string;
}

const LAYERS: readonly Layer[] = [
  {
    layer: "The compiled dataset",
    license: "CC BY 4.0",
    note: "The selection, structure, and generated text: meetings, agenda items, members, votes, flags, and any published findings, as assembled here.",
  },
  {
    layer: "The code",
    license: "MIT",
    note: "Everything in the repository — crawlers, parsers, detectors, API, and this site.",
  },
  {
    layer: "The government documents",
    license: "No license asserted",
    note: "Agendas, minutes, and the files they link to are public records produced by the jurisdictions. They are not ours to relicense.",
  },
];

/* ---------------------------------------------------------------------------
   What is withheld
   ------------------------------------------------------------------------- */

interface Withheld {
  readonly what: string;
  readonly why: string;
}

const WITHHELD: readonly Withheld[] = [
  {
    what: "Alert subscriptions, in full",
    why: "Subscriber email addresses. There is no public interest in them whatsoever.",
  },
  {
    what: "Notifications, in full",
    why: "Every row is linked to a recipient.",
  },
  {
    what: "Verification and unsubscribe tokens",
    why: "Credentials. Publishing them would let anyone act as a subscriber.",
  },
  {
    what: "Delivery channel configuration",
    why: "Encrypted credentials and operational routing.",
  },
  {
    what: "Who filed a dispute",
    why: "The substance of a dispute publishes. The person does not, unless they ask for it to.",
  },
  {
    what: "Document embedding vectors",
    why: "Derivative and regenerable from the documents. The row metadata is exported; the floats are not.",
  },
  {
    what: "Findings that are not published",
    why: "Exporting drafts would route around the review gate, which is the point of having one.",
  },
  {
    what: "The bytes of source documents",
    why: "Not ours to redistribute. Every record names the source URL and the SHA-256 instead, so you can fetch the original from the government and verify it is the same file.",
  },
  {
    what: "Meetings an operator has not published",
    why: "A sweep produces a candidate; an operator produces a publication. A withheld meeting, its agenda items, its documents, its votes and any finding about it are all absent from the export — including the content address of its documents, because a document URL can carry a meeting's title in its query string.",
  },
  {
    what: "The storage key of a stored document",
    why: "An internal address for bytes that are not redistributed. The content address and the URL the government published it at are exported instead, which are the two things that let you check the file.",
  },
  {
    what: "Operator accounts and sessions",
    why: "Credentials and the identity of the person who approved a record. Who publishes this site is named on the methodology page; a login is not a public record.",
  },
  {
    what: "The text of an ingestion failure",
    why: "It is written by whatever threw and routinely quotes a document URL, which can belong to a meeting no operator has published. The public collection status carries the counts instead.",
  },
];

/* ---------------------------------------------------------------------------
   API surface, as mounted
   ------------------------------------------------------------------------- */

/**
 * The public API surface, mirrored from the routers mounted in
 * `backend/src/app.ts`.
 *
 * It listed six of these when the backend mounted twenty-seven. Everything
 * added after this page was written — matters, search, the source viewer,
 * places, transcripts, metrics, the corrections log, the calendar, the bulk
 * export itself — was absent, and to a reader an endpoint absent from the list
 * of endpoints is an endpoint that does not exist. That is the same failure the
 * `/bot` page had, and the sitemap had, and the corrections log had: a
 * hand-kept list beside a growing router drifts by default rather than by
 * accident.
 *
 * `DataLicensePage.test.tsx` now reads `app.ts` and fails on any public mount
 * that is neither listed here nor excluded there with a written reason.
 */
const ENDPOINTS: readonly string[] = [
  "/api/jurisdictions",
  "/api/meetings",
  "/api/members",
  "/api/officials",
  "/api/votes",
  "/api/anomalies",
  "/api/matters",
  "/api/search",
  "/api/places",
  "/api/source",
  "/api/transcripts",
  "/api/calendar",
  "/api/corrections",
  "/api/public-records",
  "/api/data",
  "/api/metrics",
  "/api/ingestion",
  "/api/health",
  "/api/version",
];

/* ---------------------------------------------------------------------------
   Small parts
   ------------------------------------------------------------------------- */

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <>
      <h2
        id={id}
        className="scroll-mt-8 font-display text-2xl tracking-headline sm:text-[1.75rem]"
      >
        {children}
      </h2>
      <hr className="mt-3 rule-hi" />
    </>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 max-w-prose text-[0.9375rem] leading-relaxed text-ink-soft">
      {children}
    </p>
  );
}

/* ---------------------------------------------------------------------------
   Dataset JSON-LD
   ------------------------------------------------------------------------- */

const SITE_ORIGIN = "https://commissionwatch.bmux.sh";

/**
 * `Dataset` structured data, so the export is findable through Google Dataset
 * Search rather than only by someone who already knows this site exists.
 *
 * Every claim in it is one the page states in words too. The distributions are
 * generated from the manifest, so the block can never advertise a file the API
 * does not serve — an invented `contentUrl` is a 404 that a search engine
 * publishes on this project's behalf.
 *
 * Rendered as a text child of `<script>`, not through `dangerouslySetInnerHTML`:
 * `JSON.stringify` escapes nothing for HTML, so the one hazard is a `</script>`
 * sequence inside a value, and the replace below closes it. The values come from
 * our own manifest rather than from a document, but the export's whole subject
 * is third-party text and the next field added here may well carry some.
 */
function DatasetJsonLd({ datasets }: { datasets: DataManifestDataset[] }) {
  const distribution = datasets.flatMap((dataset) => [
    {
      "@type": "DataDownload",
      name: `${dataset.name} (CSV)`,
      encodingFormat: "text/csv",
      contentUrl: `${SITE_ORIGIN}${dataset.csv_url}`,
    },
    {
      "@type": "DataDownload",
      name: `${dataset.name} (JSON)`,
      encodingFormat: "application/json",
      contentUrl: `${SITE_ORIGIN}${dataset.json_url}`,
    },
  ]);

  const payload = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "CommissionWatch — local government meeting record",
    description:
      "Published meetings, agenda items, documents, officials, votes and reviewed findings for the local government bodies CommissionWatch monitors, with the SHA-256 content address of the source document each record was read out of.",
    url: `${SITE_ORIGIN}/data`,
    license: CC_BY_URL,
    isAccessibleForFree: true,
    creator: {
      "@type": "Organization",
      name: "CommissionWatch",
      url: SITE_ORIGIN,
    },
    keywords: [
      "local government",
      "civic transparency",
      "public meetings",
      "open data",
      "Montana",
    ],
    spatialCoverage: "Montana, United States",
    distribution,
  };

  return (
    <script type="application/ld+json">
      {JSON.stringify(payload).replace(/<\/script/gi, "<\\/script")}
    </script>
  );
}

/** One row of the export table: what it holds, how big it is, where to get it. */
function DatasetRow({ dataset }: { dataset: DataManifestDataset }) {
  return (
    <tr className="border-b border-rule align-top">
      <td className="py-3 pr-4">
        <span className="font-mono text-sm font-semibold text-ink">
          {dataset.name}
        </span>
        <span className="mt-1 block max-w-prose text-sm leading-relaxed text-muted">
          {dataset.description}
        </span>
        <span className="mt-1 block max-w-prose text-xs leading-relaxed text-ink-soft">
          {dataset.provenance ??
            "No source document is recorded for these rows, so they carry no artifact reference."}
        </span>
        <span className="mt-1 block max-w-prose font-mono text-xs leading-relaxed text-muted">
          {dataset.columns.join(", ")}
        </span>
      </td>
      <td className="py-3 pr-4 text-right text-sm text-ink tabular">
        {dataset.row_count}
      </td>
      <td className="py-3 text-right">
        <span className="flex flex-wrap justify-end gap-2">
          <a className="cite" href={dataset.csv_url}>
            CSV
          </a>
          <a className="cite" href={dataset.json_url}>
            JSON
          </a>
        </span>
      </td>
    </tr>
  );
}

/* ---------------------------------------------------------------------------
   The dated archive — what the page may claim about it
   ------------------------------------------------------------------------- */

/**
 * What this site can say about asking it what it said in March.
 *
 * The paragraph under "How often it changes" used to assert flatly that there
 * is no dated archive. That was true, and stopped being true the moment an
 * operator flips `dated_export_archive` in the admin console — putting a false
 * statement on the one public page whose subject is what this project does and
 * does not offer. So the copy is read off the capability instead of off
 * somebody's memory to edit it.
 *
 * The signal is `GET /api/data/archive` itself: with the flag off that route
 * answers **404**, which is the same "this site has no dated archive" the
 * paragraph states, and with it on it returns the boundary the reader needs.
 * Nothing new is exposed — no registry, no manifest, no other key's state, not
 * even the existence of a feature flag. An unauthenticated caller learns only
 * what they would learn by requesting the public endpoint directly.
 *
 * `unknown` is not folded into `off`. A network failure is not evidence that
 * the archive is absent, and the page states neither claim until it knows.
 */
type ArchiveState =
  | { readonly status: "unknown" }
  | { readonly status: "off" }
  | { readonly status: "on"; readonly answerableFrom: string | null };

function ArchiveCadence({ state }: { state: ArchiveState }) {
  if (state.status === "unknown") return null;

  if (state.status === "off") {
    return (
      <Prose>
        There is no nightly snapshot and no dated archive — that is honest about
        what exists rather than a promise, and it means there is currently no
        way to ask this site what it said in March.
      </Prose>
    );
  }

  return (
    <>
      <Prose>
        Dated snapshots are kept, so you can ask what this site published on a
        given day.{" "}
        <a className="cite" href="/api/data/archive">
          /api/data/archive
        </a>{" "}
        lists every snapshot and the dates it can answer for. An archived export
        is re-read through today&rsquo;s publication rule rather than served as
        a stored copy, so a record withdrawn since is absent from it and counted
        as withheld.
      </Prose>
      <Prose>
        {state.answerableFrom === null ? (
          <>
            No snapshot has been taken yet, so there is nothing to ask for
            before now. What this site published on any earlier date was never
            recorded and is not reconstructed.
          </>
        ) : (
          <>
            The archive answers from{" "}
            <span className="figure">
              {new Date(state.answerableFrom).toLocaleDateString()}
            </span>{" "}
            onward — the first snapshot. Publication state is a single mutable
            column, so what was public before that cannot be reconstructed from
            the record, and the archive does not guess.
          </>
        )}
      </Prose>
    </>
  );
}

/* ---------------------------------------------------------------------------
   Page
   ------------------------------------------------------------------------- */

export function DataLicensePage() {
  const [manifest, setManifest] = useState<DataManifest | null>(null);
  const [manifestFailed, setManifestFailed] = useState(false);
  const [archive, setArchive] = useState<ArchiveState>({ status: "unknown" });

  const load = useCallback(async (): Promise<DataManifest | null> => {
    try {
      const res = await fetch("/api/data");
      if (!res.ok) return null;
      return (await res.json()) as DataManifest;
    } catch {
      return null;
    }
  }, []);

  /**
   * Resolves the archive state from the public endpoint's own answer.
   *
   * 404 is the definite "off" — the route is declared and answers 404 by
   * design while the feature is off. Any other failure is `unknown`, because a
   * proxy error is not evidence about the archive.
   */
  const loadArchive = useCallback(async (): Promise<ArchiveState> => {
    try {
      const res = await fetch("/api/data/archive");
      if (res.status === 404) return { status: "off" };
      if (!res.ok) return { status: "unknown" };
      const index = (await res.json()) as DataArchiveIndex;
      return { status: "on", answerableFrom: index.answerable_from };
    } catch {
      return { status: "unknown" };
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const loaded = await load();
      if (ignore) return;
      if (loaded === null) setManifestFailed(true);
      else setManifest(loaded);
    })();
    return () => {
      ignore = true;
    };
  }, [load]);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const state = await loadArchive();
      if (!ignore) setArchive(state);
    })();
    return () => {
      ignore = true;
    };
  }, [loadArchive]);

  return (
    <div className="mx-auto max-w-3xl">
      {manifest !== null && <DatasetJsonLd datasets={manifest.datasets} />}

      <header>
        <p className="kicker">Bulk export</p>
        <h1 className="headline mt-2 text-4xl sm:text-5xl">Open data</h1>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-ink-soft">
          &ldquo;Here is what the record shows&rdquo; is only a checkable claim
          if you can get the record. Here is the record, in bulk, with the terms
          for taking it and using it — including to contradict us.
        </p>
        <p className="mt-4 text-xs text-muted">
          Revised <span className="figure">{REVISED}</span>
        </p>
      </header>

      <article className="mt-10 border-t border-rule pt-8">
        {/* -------------------------------------------------- Layers */}
        <section aria-labelledby="layers">
          <SectionHeading id="layers">Three layers, three licenses</SectionHeading>
          <Prose>
            What you are reusing determines the terms. These are never
            conflated, because the third layer is not ours.
          </Prose>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">
                License applying to each layer of the site
              </caption>
              <thead>
                {/* `label-sm` sets `display: inline-block`, which would take a
                    `<th>` out of the table layout — so it goes on a span. */}
                <tr className="border-b border-ink">
                  <th scope="col" className="pb-2 pr-4 text-left align-bottom">
                    <span className="label-sm">Layer</span>
                  </th>
                  <th scope="col" className="w-44 pb-2 text-right align-bottom">
                    <span className="label-sm">License</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {LAYERS.map((layer) => (
                  <tr key={layer.layer} className="border-b border-rule align-top">
                    <td className="py-3 pr-4">
                      <span className="text-sm font-semibold text-ink">
                        {layer.layer}
                      </span>
                      <span className="mt-1 block max-w-prose text-sm leading-relaxed text-muted">
                        {layer.note}
                      </span>
                    </td>
                    <td className="py-3 text-right text-sm text-ink">
                      {layer.license}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 flex flex-wrap gap-2">
            <a className="cite" href={CC_BY_URL} target="_blank" rel="noreferrer">
              CC BY 4.0 · creativecommons.org
            </a>
            <a className="cite" href={REPO_URL} target="_blank" rel="noreferrer">
              MIT · github.com/nickallevato/commissionwatch
            </a>
          </p>
        </section>

        {/* -------------------------------------------------- Attribution */}
        <section className="mt-12" aria-labelledby="attribution">
          <SectionHeading id="attribution">How to attribute</SectionHeading>
          <Prose>
            Under CC BY 4.0 you may copy, redistribute, and build on this
            dataset for any purpose, including commercially, as long as you
            credit it. One line is enough:
          </Prose>
          <p className="mt-4 border-l-2 border-accent pl-4 font-mono text-sm leading-relaxed text-ink">
            Data from CommissionWatch — {SITE}, CC BY 4.0.
          </p>
          <Prose>
            The license covers the compilation, not the facts. That a
            commissioner voted no on the fourteenth of July is not
            copyrightable, is not ours, and needs no permission from anyone.
            What is licensed is the work of assembling those facts into a
            structured, checkable record.
          </Prose>
          <div className="mt-6 border-l-2 border-rule pl-4">
            <p className="label-sm">A request, not a term</p>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              If you republish a finding, republish its corrections status with
              it. This is asked, not required — CC BY forbids imposing extra
              restrictions, and pretending otherwise would be a false claim
              about the license. The API carries corrections on every finding so
              that honoring it costs nothing.
            </p>
          </div>
        </section>

        {/* -------------------------------------------------- Getting the data */}
        <section className="mt-12" aria-labelledby="getting">
          <SectionHeading id="getting">Getting the data</SectionHeading>
          <Prose>
            The API is public, read-only, unauthenticated, and returns JSON.
            There is no key and no signup form: putting one in front of public
            records is friction that buys nothing. Cross-origin requests are
            allowed, so you can read it straight from a browser.
          </Prose>
          <ul className="mt-4 flex flex-wrap gap-2">
            {ENDPOINTS.map((endpoint) => (
              <li key={endpoint} className="cite figure">
                {endpoint}
              </li>
            ))}
          </ul>
          <Prose>
            Be reasonable with it. If you want everything, take the bulk export
            below rather than crawling the API — it is the same record in one
            request per table, and it costs both of us less.
          </Prose>
        </section>

        {/* -------------------------------------------------- The bulk export */}
        <section className="mt-12" aria-labelledby="export">
          <SectionHeading id="export">The bulk export</SectionHeading>
          <Prose>
            Every table below is public, unauthenticated and served in two
            formats: JSON, and CSV to RFC 4180. Nothing is paginated at the
            surface — each file is the whole of that table&rsquo;s published
            rows, written out as they are read rather than assembled in memory,
            so a large corpus downloads rather than failing.{" "}
            <a className="cite" href="/api/data">
              /api/data
            </a>{" "}
            is the manifest: the same list, machine-readable, with the column
            names and row counts.
          </Prose>
          <Prose>
            <strong className="font-semibold text-ink">
              Only records an operator has published appear here.
            </strong>{" "}
            A sweep produces a candidate and an operator produces a publication;
            a meeting still in review is absent from the export along with
            everything hanging off it, and a finding that has not been approved
            is absent whatever the state of its meeting.
          </Prose>

          {manifestFailed && (
            <p
              role="alert"
              className="mt-6 max-w-prose border-l-2 border-accent bg-paper px-4 py-3 text-sm text-ink-soft"
            >
              The export manifest could not be loaded, so this page cannot list
              the tables or their sizes right now. The files themselves are at{" "}
              <span className="font-mono text-sm">/api/data</span>.
            </p>
          )}

          {manifest !== null && (
            <>
              <div className="mt-6 overflow-x-auto">
                <table className="w-full min-w-[40rem] border-collapse text-left">
                  <caption className="sr-only">
                    Every exported table, its row count and its download links
                  </caption>
                  <thead>
                    <tr className="border-b border-ink">
                      <th scope="col" className="pb-2 pr-4 text-left align-bottom">
                        <span className="label-sm">Table</span>
                      </th>
                      <th scope="col" className="w-24 pb-2 pr-4 text-right align-bottom">
                        <span className="label-sm">Rows</span>
                      </th>
                      <th scope="col" className="w-32 pb-2 text-right align-bottom">
                        <span className="label-sm">Download</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifest.datasets.map((dataset) => (
                      <DatasetRow key={dataset.name} dataset={dataset} />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-xs text-muted tabular">
                Schema version{" "}
                <span className="figure">
                  {manifest.schema_migration ?? "not reported"}
                </span>
                . Manifest generated{" "}
                <span className="figure">
                  {new Date(manifest.generated_at).toLocaleString()}
                </span>
                .
              </p>
            </>
          )}
        </section>

        {/* -------------------------------------------------- Provenance */}
        <section className="mt-12" aria-labelledby="provenance">
          <SectionHeading id="provenance">
            Every row carries its source
          </SectionHeading>
          <Prose>
            A row without an artifact reference is a claim without a source,
            which is the thing this project exists not to publish. So a meeting,
            its agenda items, its documents and its votes each carry{" "}
            <span className="font-mono text-sm">source_artifact_sha256</span> —
            the SHA-256 of the stored copy of the document they were read out
            of. The{" "}
            <span className="font-mono text-sm">artifact_references</span> table
            carries the full mapping: every stored version of every linked
            document, with the URL the bytes actually came from after redirects.
          </Prose>
          <Prose>
            Three tables have no such column, and that is stated rather than
            filled in with a blank. Officials, jurisdictions and commissions are
            structural records: the schema stores no source document for them,
            so an empty provenance column would read as a lost source when the
            truth is that there never was one.
          </Prose>
        </section>

        {/* -------------------------------------------------- Cadence */}
        <section className="mt-12" aria-labelledby="cadence">
          <SectionHeading id="cadence">How often it changes</SectionHeading>
          <Prose>
            The export is generated from the live record when you request it, so
            it is exactly as fresh as two things: the last time a source was
            swept, and the last time an operator published what the sweep found.
          </Prose>
          <ArchiveCadence state={archive} />
          <Prose>
            Each source has its own schedule and its own health.{" "}
            <Link
              to="/status"
              className="underline underline-offset-2 hover:text-accent"
            >
              Collection status
            </Link>{" "}
            reports when each one last succeeded, and marks a source that has
            gone quiet past its own expected interval rather than leaving it
            looking calm.
          </Prose>
          <Prose>
            If you want the meeting schedule rather than the whole record,{" "}
            <Link
              to="/calendar"
              className="underline underline-offset-2 hover:text-accent"
            >
              the calendar
            </Link>{" "}
            publishes an iCalendar feed per jurisdiction that you can subscribe
            to directly.
          </Prose>
        </section>

        {/* -------------------------------------------------- Withheld */}
        <section className="mt-12" aria-labelledby="withheld">
          <SectionHeading id="withheld">
            What is withheld, and why
          </SectionHeading>
          <Prose>
            An omission you have to notice is not transparency. Everything held
            back from the public data is listed here, with the reason.
          </Prose>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">
                Data withheld from the public dataset, with the reason for each
              </caption>
              <thead>
                <tr className="border-b border-ink">
                  <th
                    scope="col"
                    className="w-56 pb-2 pr-4 text-left align-bottom"
                  >
                    <span className="label-sm">Withheld</span>
                  </th>
                  <th scope="col" className="pb-2 text-left align-bottom">
                    <span className="label-sm">Reason</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {WITHHELD.map((row) => (
                  <tr key={row.what} className="border-b border-rule align-top">
                    <td className="py-3 pr-4 text-sm font-semibold text-ink">
                      {row.what}
                    </td>
                    <td className="py-3 text-sm leading-relaxed text-ink-soft">
                      {row.why}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Prose>
            An official&rsquo;s government email address is{" "}
            <em>not</em> withheld where the jurisdiction publishes it itself.
            Withholding a published official contact from a transparency dataset
            would be theatre. Personal addresses are never collected, so there
            are none to withhold. Party affiliation is blank for nonpartisan
            offices because it was never inferred — blank means unknown, not
            independent.
          </Prose>
        </section>

        {/* -------------------------------------------------- Verifying */}
        <section className="mt-12" aria-labelledby="verifying">
          <SectionHeading id="verifying">Verifying a record</SectionHeading>
          <Prose>
            Every record traces to a document the jurisdiction published. Take
            the source URL from the meeting page, fetch the file from the
            government yourself, and compare its SHA-256 with the one recorded
            here. If the hashes match, you are holding the exact file this site
            parsed. If they do not, the document changed after we read it, and
            that is worth knowing on its own.
          </Prose>
          <Prose>
            If you find a record that the source document does not support,
            write to{" "}
            <a
              href={`mailto:${CORRECTIONS_EMAIL}`}
              className="underline underline-offset-2 hover:text-accent"
            >
              {CORRECTIONS_EMAIL}
            </a>
            . How that is handled, and on what clock, is set out in the{" "}
            <Link
              to="/methodology"
              className="underline underline-offset-2 hover:text-accent"
            >
              methodology
            </Link>
            .
          </Prose>
        </section>

        {/* -------------------------------------------------- Not legal advice */}
        <hr className="mt-12 border-t border-rule" />
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted">
          This page describes the terms this project offers. It is not legal
          advice, and it does not speak for the jurisdictions whose documents
          the record is built from.
        </p>
      </article>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ACTION_PRIMARY,
  ACTION_QUIET,
  ACTION_ROW,
  ACTION_SMALL,
  Dropzone,
  FIELD,
  FlagBar,
  FOCUS_RING,
  KeyValues,
  StatusPill,
  Tile,
  Tiles,
  WorkTitle,
} from "@/components/PressroomUI";

/**
 * `/admin/records` — public-records requests and the documents they produce.
 * Screen 06 of the approved mockup.
 *
 * Operator-only, and not merely as a convenience: the extraction shown here
 * names people, and this is the only surface on which it is readable. Every
 * flag a document raises is written `held` and never reaches the public
 * anomalies API.
 *
 * **One pipeline, two doors.** A hand-delivered PDF gets the same parse,
 * extraction, detection and provenance display as a scraped one; the only
 * difference in the record is that `source_url` is null.
 *
 * **Deduplication is free.** Identical bytes collide on the unique
 * `artifacts.sha256` and are rejected rather than reprocessed. That is drawn
 * here as a row, not hidden as a no-op, because "we already had this" is a
 * fact about the custodian's response worth seeing.
 *
 * The correction form appends. It submits a whole replacement set, and the
 * superseded version stays in the history — what the machine originally said
 * is part of the record on a project whose subject is the public record.
 */

interface RecordsRequest {
  id: string;
  subject: string;
  status: string;
  submitted_at: string | null;
  responded_at: string | null;
}

/** `artifacts`, as `GET /api/admin/records/requests/:id` returns them. */
interface RequestArtifact {
  id: string;
  sha256: string;
  storage_key: string;
  content_type: string | null;
  source_url: string | null;
  byte_size: number;
  fetched_at: string;
}

interface ExtractedValue {
  value: string;
  confidence: "high" | "medium" | "low";
  pattern: string;
}

interface ExtractedEntities {
  people: ExtractedValue[];
  organizations: ExtractedValue[];
  amounts: ExtractedValue[];
  dates: ExtractedValue[];
}

interface Extraction {
  id: string;
  artifact_id: string;
  entities: ExtractedEntities;
  extractor_version: string;
  supersedes_id: string | null;
  note: string | null;
  created_at: string;
}

/** P7 — a gap in the record, derived by the API from the record itself. */
interface RecordGap {
  id: string;
  kind: string;
  jurisdiction_name: string;
  summary: string;
}

/** P7 — one jurisdiction's records law, or the absence of one. */
interface JurisdictionLawStatus {
  jurisdiction_id: string;
  jurisdiction_name: string;
  law: { statute_citation: string; verified_on: string } | null;
  verification_age_days: number | null;
  stale: boolean;
  advisory: string;
}

const GAP_KIND_LABELS: Record<string, string> = {
  missing_minutes: "Minutes not in the record",
  unpublished_exhibit: "Exhibit not published",
  disabled_source: "Source not collecting",
  failed_fetch: "Fetch did not complete",
};

const FIELDS: ReadonlyArray<{ key: keyof ExtractedEntities; label: string }> = [
  { key: "people", label: "People" },
  { key: "organizations", label: "Organisations" },
  { key: "amounts", label: "Amounts" },
  { key: "dates", label: "Dates" },
];

/** A request in one of these is finished with; anything else is still open. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["fulfilled", "denied", "withdrawn"]);

type LoadResult = { ok: true; requests: RecordsRequest[] } | { ok: false };

export function AdminRecordsPage() {
  const [requests, setRequests] = useState<RecordsRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [subject, setSubject] = useState("");
  const [creating, setCreating] = useState(false);

  const [uploadRequestId, setUploadRequestId] = useState("");
  const [filename, setFilename] = useState("");
  const [documentText, setDocumentText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [history, setHistory] = useState<Extraction[]>([]);

  // The documents a request produced, and the hashes that arrived twice.
  const [artifacts, setArtifacts] = useState<RequestArtifact[]>([]);
  const [duplicates, setDuplicates] = useState<readonly string[]>([]);

  // P7 — the request generator.
  const [gaps, setGaps] = useState<RecordGap[]>([]);
  const [lawStatuses, setLawStatuses] = useState<JurisdictionLawStatus[]>([]);
  const [requesterName, setRequesterName] = useState("");
  const [requesterEmail, setRequesterEmail] = useState("");
  const [drafting, setDrafting] = useState("");
  const [letter, setLetter] = useState("");
  const [letterWarnings, setLetterWarnings] = useState<string[]>([]);
  const [refusal, setRefusal] = useState("");

  // Fetching and applying are separated so the effect below can await the
  // request and touch state only in the continuation. An effect body that calls
  // setState synchronously causes a cascading render, and — worse here — a fast
  // unmount would set state on a component that is already gone.
  const fetchRequests = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch("/api/admin/records/requests", { credentials: "same-origin" });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as { data: RecordsRequest[] };
      return { ok: true, requests: body.data };
    } catch {
      return { ok: false };
    }
  }, []);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setRequests(result.requests);
      setError("");
    } else {
      setError("Records requests could not be loaded.");
    }
    setLoading(false);
  }, []);

  /** Reload after a write. Showing the spinner here is a response to a click. */
  const load = useCallback(async () => {
    setLoading(true);
    applyResult(await fetchRequests());
  }, [applyResult, fetchRequests]);

  useEffect(() => {
    // `loading` already starts true, so nothing needs setting on the way in.
    let ignore = false;
    void (async () => {
      const result = await fetchRequests();
      if (ignore) return;
      applyResult(result);
    })();
    return () => {
      ignore = true;
    };
  }, [applyResult, fetchRequests]);

  /**
   * P7 — the gaps and the records law, loaded together on mount.
   *
   * Neither is fatal to this page: the upload and correction surfaces work
   * whether or not a jurisdiction has a verified statute, so a failure here
   * leaves the lists empty rather than replacing the page with an error.
   */
  useEffect(() => {
    let ignore = false;
    void (async () => {
      const [gapsRes, lawRes] = await Promise.all([
        fetch("/api/admin/records/gaps", { credentials: "same-origin" }).catch(() => null),
        fetch("/api/admin/records/law", { credentials: "same-origin" }).catch(() => null),
      ]);
      if (ignore) return;

      if (gapsRes?.ok) {
        const body = (await gapsRes.json()) as { data: RecordGap[] };
        if (!ignore) setGaps(body.data);
      }
      if (lawRes?.ok) {
        const body = (await lawRes.json()) as { data: JurisdictionLawStatus[] };
        if (!ignore) setLawStatuses(body.data);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  /**
   * The documents one request produced.
   *
   * Keyed off the same control that decides where an upload lands, so an
   * operator is never looking at one request's documents while filing into
   * another's. Nothing is requested until a request is chosen.
   */
  const fetchArtifacts = useCallback(
    async (requestId: string): Promise<RequestArtifact[] | null> => {
      if (requestId === "") return null;
      try {
        const res = await fetch(`/api/admin/records/requests/${requestId}`, {
          credentials: "same-origin",
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { artifacts: RequestArtifact[] };
        return body.artifacts;
      } catch {
        // A failed document listing must not take the upload surface with it.
        return null;
      }
    },
    [],
  );

  // The fetch is separated from the state it lands in so the effect body
  // touches state only in the continuation, never synchronously.
  useEffect(() => {
    let ignore = false;
    void (async () => {
      const rows = await fetchArtifacts(uploadRequestId);
      if (ignore || rows === null) return;
      setArtifacts(rows);
    })();
    return () => {
      ignore = true;
    };
  }, [fetchArtifacts, uploadRequestId]);

  /**
   * Draft a letter for one gap.
   *
   * The API refuses when the jurisdiction has no verified records law, and the
   * refusal is rendered **verbatim**: it names the table, the jurisdiction and
   * the columns somebody has to fill in, and paraphrasing it would throw away
   * the only part of it that can be acted on.
   *
   * Nothing is sent. The row this creates is a `draft`, and the letter is text
   * for the operator to copy into their own mail client.
   */
  async function draftRequest(gapId: string) {
    setDrafting(gapId);
    setLetter("");
    setLetterWarnings([]);
    setRefusal("");
    try {
      const res = await fetch("/api/admin/records/draft-request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gap_id: gapId,
          requester: { name: requesterName, email: requesterEmail },
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setRefusal(body?.error ?? "That request could not be drafted.");
        return;
      }

      const body = (await res.json()) as { letter: string; warnings: string[] };
      setLetter(body.letter);
      setLetterWarnings(body.warnings);
      await load();
    } finally {
      setDrafting("");
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/admin/records/requests", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That request could not be created.");
        return;
      }
      setSubject("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function handleUpload(event: FormEvent) {
    event.preventDefault();
    setUploading(true);
    setError("");

    // Base64 in a JSON body rather than multipart, matching the API. The bytes
    // are the document; `text` is what extraction reads.
    const contentBase64 = btoa(unescape(encodeURIComponent(documentText)));
    const path = uploadRequestId
      ? `/api/admin/records/requests/${uploadRequestId}/documents`
      : "/api/admin/records/documents";

    try {
      const res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename,
          content_type: "text/plain",
          content_base64: contentBase64,
          text: documentText,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That document could not be uploaded.");
        return;
      }

      const body = (await res.json()) as {
        artifact: { id: string; sha256?: string };
        created: boolean;
      };
      if (!body.created) {
        setError("Those exact bytes were already stored, so nothing was reprocessed.");
        if (typeof body.artifact.sha256 === "string") {
          const sha = body.artifact.sha256;
          setDuplicates((seen) => (seen.includes(sha) ? seen : [...seen, sha]));
        }
      }
      await loadExtraction(body.artifact.id);
      const rows = await fetchArtifacts(uploadRequestId);
      if (rows !== null) setArtifacts(rows);
      setDocumentText("");
      setFilename("");
    } finally {
      setUploading(false);
    }
  }

  /** Read a dropped or chosen file as text and fill the upload form with it. */
  function acceptFiles(files: FileList) {
    const file = files[0];
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      setDocumentText(typeof reader.result === "string" ? reader.result : "");
    };
    reader.readAsText(file);
  }

  async function loadExtraction(artifactId: string) {
    const res = await fetch(`/api/admin/records/documents/${artifactId}/extraction`, {
      credentials: "same-origin",
    });
    if (!res.ok) {
      setExtraction(null);
      setHistory([]);
      return;
    }
    const body = (await res.json()) as { current: Extraction; history: Extraction[] };
    setExtraction(body.current);
    setHistory(body.history);
  }

  async function removeValue(field: keyof ExtractedEntities, value: string) {
    if (!extraction) return;
    const entities: ExtractedEntities = {
      ...extraction.entities,
      [field]: extraction.entities[field].filter((entry) => entry.value !== value),
    };

    const res = await fetch(`/api/admin/records/documents/${extraction.artifact_id}/extraction`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entities, note: `Removed "${value}" from ${field}` }),
    });
    if (res.ok) await loadExtraction(extraction.artifact_id);
  }

  const summary = useMemo(() => {
    const open = requests.filter((item) => !CLOSED_STATUSES.has(item.status));
    const unverified = lawStatuses.filter((status) => status.law === null || status.stale);
    return { open: open.length, unverified: unverified.length };
  }, [requests, lawStatuses]);

  return (
    <>
      <WorkTitle
        title="Records requests"
        stamp={
          loading
            ? "loading…"
            : `${requests.length} request${requests.length === 1 ? "" : "s"} · ${gaps.length} open gap${
                gaps.length === 1 ? "" : "s"
              }`
        }
      />

      <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
        A document obtained by hand takes the same path as a scraped one: hashed,
        stored, and read by the same detectors. Anything raised here is held for
        review and never appears on the public site.
      </p>

      {error && (
        <p role="alert" className="border-l-2 border-accent bg-accent-50 px-4 py-3 text-sm text-ink-soft">
          {error}
        </p>
      )}

      <Tiles>
        <Tile label="Requests" value={requests.length} sub={`${summary.open} still open`} />
        <Tile
          label="Gaps in the record"
          value={gaps.length}
          tone={gaps.length > 0 ? "warn" : "good"}
          sub="derived, not listed"
        />
        <Tile
          label="Documents"
          value={artifacts.length}
          sub={
            uploadRequestId === ""
              ? "choose a request below"
              : `${duplicates.length} duplicate rejected`
          }
        />
        <Tile
          label="Jurisdictions without a statute"
          value={summary.unverified}
          tone={summary.unverified > 0 ? "bad" : "good"}
          sub="no letter can be drafted"
        />
      </Tiles>

      <div className="flex flex-col gap-3 border border-rule px-4 py-3.5">
        <span className="label-sm">Requests</span>
        {loading ? (
          <p className="label-sm" role="status">
            Loading requests…
          </p>
        ) : requests.length === 0 ? (
          <p className="text-sm text-muted">No requests yet.</p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {requests.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                <span className="text-sm text-ink">{item.subject}</span>
                <StatusPill tone={CLOSED_STATUSES.has(item.status) ? "ok" : "warn"}>
                  {item.status.replace(/_/g, " ")}
                </StatusPill>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleCreate} className="flex max-w-lg items-end gap-3">
          <div className="flex-1">
            <label htmlFor="request-subject" className="label-sm">
              New request
            </label>
            <input
              id="request-subject"
              required
              value={subject}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSubject(event.target.value)}
              className={`${FIELD} ${FOCUS_RING}`}
            />
          </div>
          <button type="submit" disabled={creating} className={`${ACTION_PRIMARY} ${FOCUS_RING}`}>
            {creating ? "Adding…" : "Add"}
          </button>
        </form>
      </div>

      {/* The split: documents received on paper, what was pulled out of them
          on the sunk ground beside it. */}
      <div className="grid grid-cols-1 border border-rule lg:grid-cols-[1.35fr_1fr]">
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <span className="label-sm">Documents received</span>

          {uploadRequestId === "" ? (
            <p className="text-sm text-muted">
              Choose a request below to list the documents it produced.
            </p>
          ) : artifacts.length === 0 ? (
            <p className="text-sm text-muted">No document has arrived against this request.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[24rem] border-collapse text-left text-[13px]">
                <caption className="sr-only">Documents received against this request</caption>
                <thead>
                  <tr>
                    <th scope="col" className="label-sm border-b border-rule py-2 pr-3">File</th>
                    <th scope="col" className="label-sm border-b border-rule py-2 pr-3">sha256</th>
                    <th scope="col" className="label-sm border-b border-rule py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {artifacts.map((row) => {
                    const duplicate = duplicates.includes(row.sha256);
                    return (
                      <tr
                        key={row.id}
                        className={`border-b border-rule last:border-b-0 ${
                          duplicate ? "bg-paper-sunk" : ""
                        }`}
                      >
                        <td className="py-2 pr-3">
                          <span className="block break-all text-ink">{row.storage_key}</span>
                          <span className="block text-[11.5px] text-muted">
                            {row.byte_size} bytes · {row.content_type ?? "unknown type"}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-ink-soft">
                          {row.sha256.slice(0, 4)}…{row.sha256.slice(-4)}
                        </td>
                        <td className="py-2">
                          {duplicate ? (
                            <StatusPill tone="warn">Duplicate</StatusPill>
                          ) : (
                            <StatusPill tone="ok">Stored</StatusPill>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Dropzone
            id="document-drop"
            title="Drop a document, or choose a file"
            hint="Hashed on arrival. Identical bytes collide on sha256 and are never reprocessed."
            onFiles={acceptFiles}
            disabled={uploading}
          />

          <form onSubmit={handleUpload} className="max-w-lg space-y-4">
            <div>
              <label htmlFor="document-filename" className="label-sm">
                Filename
              </label>
              <input
                id="document-filename"
                required
                value={filename}
                onChange={(event) => setFilename(event.target.value)}
                className={`${FIELD} ${FOCUS_RING}`}
              />
            </div>

            <div>
              <label htmlFor="document-request" className="label-sm">
                Attach to request
              </label>
              <select
                id="document-request"
                value={uploadRequestId}
                onChange={(event) => {
                  // Clear here rather than in the effect: the documents on
                  // screen must never belong to a request other than the one
                  // an upload would file into.
                  setArtifacts([]);
                  setUploadRequestId(event.target.value);
                }}
                className={`${FIELD} ${FOCUS_RING}`}
              >
                <option value="">No request</option>
                {requests.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.subject}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="document-text" className="label-sm">
                Document text
              </label>
              <textarea
                id="document-text"
                required
                rows={6}
                value={documentText}
                onChange={(event) => setDocumentText(event.target.value)}
                className={`${FIELD} ${FOCUS_RING}`}
              />
            </div>

            <button type="submit" disabled={uploading} className={`${ACTION_PRIMARY} ${FOCUS_RING}`}>
              {uploading ? "Uploading…" : "Upload"}
            </button>
          </form>
        </div>

        <div className="flex flex-col gap-3 border-t border-rule bg-paper-sunk px-4 py-3.5 lg:border-l lg:border-t-0">
          <span className="label-sm">Extraction</span>
          {extraction === null ? (
            <p className="text-sm text-muted">
              Upload a document to see what the extractors found in it.
            </p>
          ) : (
            <>
              <KeyValues
                testId="extraction-summary"
                items={[
                  {
                    key: "Organisations",
                    value: `${extraction.entities.organizations.length} found`,
                  },
                  { key: "Amounts", value: `${extraction.entities.amounts.length} found` },
                  { key: "Dates", value: `${extraction.entities.dates.length} found` },
                  {
                    key: "People",
                    value:
                      extraction.entities.people.length === 0
                        ? "none found"
                        : `${extraction.entities.people.length} — held`,
                    tone: extraction.entities.people.length === 0 ? "plain" : "warn",
                  },
                  { key: "Source", value: "records request (no URL)" },
                  { key: "Pipeline", value: "identical to scraped" },
                ]}
              />

              {extraction.entities.people.length > 0 && (
                <FlagBar label="Held" testId="held-entities">
                  This extraction names{" "}
                  <b className="font-semibold text-ink">
                    {extraction.entities.people.length} person
                    {extraction.entities.people.length === 1 ? "" : "s"}
                  </b>
                  , so nothing raised from it publishes — it waits for the review
                  queue exactly as a scraped finding does.
                </FlagBar>
              )}

              <p className="max-w-prose text-[11.5px] leading-relaxed text-muted">
                Confidence is a heuristic, not a judgement. The person heuristic in
                particular matches any two capitalised words, so a room name reads
                the same as a name — remove anything that is not what it claims to
                be. Corrections append; nothing is overwritten.
              </p>

              {FIELDS.map((field) => (
                <div key={field.key}>
                  <h2 className="label-sm">{field.label}</h2>
                  {extraction.entities[field.key].length === 0 ? (
                    <p className="mt-1 text-sm text-muted">None.</p>
                  ) : (
                    <ul className="mt-1.5 divide-y divide-rule border-y border-rule">
                      {extraction.entities[field.key].map((entry) => (
                        <li
                          key={entry.value}
                          className="flex flex-wrap items-baseline justify-between gap-3 py-2"
                        >
                          <span className="text-sm text-ink">{entry.value}</span>
                          <span className="flex items-baseline gap-3">
                            <span className="label-sm">
                              {entry.confidence} · {entry.pattern}
                            </span>
                            <button
                              type="button"
                              onClick={() => void removeValue(field.key, entry.value)}
                              className={`${ACTION_QUIET} ${ACTION_SMALL} ${FOCUS_RING}`}
                            >
                              Remove
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}

              <p className="label-sm">
                {history.length} version{history.length === 1 ? "" : "s"} on record
              </p>
            </>
          )}
        </div>
      </div>

      {/* ---- P7: the records law, and the gaps it unlocks ---------------- */}

      <section className="flex flex-col gap-3 border border-rule px-4 py-3.5" aria-labelledby="records-law">
        <h2 id="records-law" className="label-sm">
          Records law
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-muted">
          A request cites the statute recorded for its jurisdiction, and nothing
          else. Montana&rsquo;s published deadlines are written for executive
          branch agencies and for public agencies that are not local
          governments; a city and a county fall under a different subsection.
          Until a person has read that subsection and recorded it here, no
          letter can be drafted for that jurisdiction — which is the intended
          behaviour, not a fault.
        </p>

        {lawStatuses.length === 0 ? (
          <p className="text-sm text-muted">No jurisdictions on file.</p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {lawStatuses.map((status) => (
              <li key={status.jurisdiction_id} className="py-3">
                <p className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-sm text-ink">{status.jurisdiction_name}</span>
                  <span className={`label-sm ${status.law === null || status.stale ? "text-accent" : ""}`}>
                    {status.law === null
                      ? "No statute recorded"
                      : status.stale
                        ? "Verification out of date"
                        : status.law.statute_citation}
                  </span>
                </p>
                <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">{status.advisory}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 border border-rule px-4 py-3.5" aria-labelledby="gaps">
        <h2 id="gaps" className="label-sm">
          Gaps in the record
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-muted">
          Derived from the record, not from a list. Drafting produces letter text
          and a request in <em>draft</em>. It sends nothing — copy the letter and
          send it yourself, under your own name.
        </p>

        <div className="flex max-w-lg flex-wrap gap-4">
          <div className="flex-1">
            <label htmlFor="requester-name" className="label-sm">
              Requester name
            </label>
            <input
              id="requester-name"
              value={requesterName}
              onChange={(event) => setRequesterName(event.target.value)}
              className={`${FIELD} ${FOCUS_RING}`}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="requester-email" className="label-sm">
              Requester email
            </label>
            <input
              id="requester-email"
              type="email"
              value={requesterEmail}
              onChange={(event) => setRequesterEmail(event.target.value)}
              className={`${FIELD} ${FOCUS_RING}`}
            />
          </div>
        </div>

        {gaps.length === 0 ? (
          <p className="text-sm text-muted">No gaps are open.</p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {gaps.map((gap) => (
              <li key={gap.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                <span className="max-w-prose">
                  <span className="label-sm block">
                    {GAP_KIND_LABELS[gap.kind] ?? gap.kind} · {gap.jurisdiction_name}
                  </span>
                  <span className="mt-1 block text-sm text-ink">{gap.summary}</span>
                </span>
                <span className={ACTION_ROW}>
                  <button
                    type="button"
                    disabled={drafting !== ""}
                    onClick={() => void draftRequest(gap.id)}
                    className={`${ACTION_QUIET} ${ACTION_SMALL} ${FOCUS_RING}`}
                  >
                    {drafting === gap.id ? "Drafting…" : "Draft request"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {refusal && (
          <p
            role="alert"
            className="max-w-prose border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm leading-relaxed text-ink-soft"
          >
            {refusal}
          </p>
        )}

        {letter && (
          <div>
            {letterWarnings.map((warning) => (
              <p
                key={warning}
                className="mt-2 max-w-prose border-l-2 border-rule bg-paper-sunk px-4 py-3 text-sm leading-relaxed text-ink-soft"
              >
                {warning}
              </p>
            ))}
            <label htmlFor="draft-letter" className="label-sm mt-4 block">
              Draft letter
            </label>
            <textarea
              id="draft-letter"
              readOnly
              rows={20}
              value={letter}
              className={`${FIELD} text-xs leading-relaxed ${FOCUS_RING}`}
            />
          </div>
        )}
      </section>
    </>
  );
}

import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";

/**
 * `/admin/records` — public-records requests and the documents they produce.
 *
 * Operator-only, and not merely as a convenience: the extraction shown here
 * names people, and this is the only surface on which it is readable. Every
 * flag a document raises is written `held` and never reaches the public
 * anomalies API.
 *
 * The correction form appends. It submits a whole replacement set, and the
 * superseded version stays in the history — what the machine originally said
 * is part of the record on a project whose subject is the public record.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const fieldClass =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink hover:border-ink";

interface RecordsRequest {
  id: string;
  subject: string;
  status: string;
  submitted_at: string | null;
  responded_at: string | null;
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

const FIELDS: ReadonlyArray<{ key: keyof ExtractedEntities; label: string }> = [
  { key: "people", label: "People" },
  { key: "organizations", label: "Organisations" },
  { key: "amounts", label: "Amounts" },
  { key: "dates", label: "Dates" },
];

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

      const body = (await res.json()) as { artifact: { id: string }; created: boolean };
      if (!body.created) {
        setError("Those exact bytes were already stored, so nothing was reprocessed.");
      }
      await loadExtraction(body.artifact.id);
      setDocumentText("");
      setFilename("");
    } finally {
      setUploading(false);
    }
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

  return (
    <div>
      <p className="kicker">Operator console</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">Records requests</h1>
      <div className="rule-hi mt-4" role="presentation" />

      <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-soft">
        A document obtained by hand takes the same path as a scraped one: hashed,
        stored, and read by the same detectors. Anything raised here is held for
        review and never appears on the public site.
      </p>

      {error && (
        <p role="alert" className="mt-6 border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm text-ink-soft">
          {error}
        </p>
      )}

      <h2 className="mt-10 font-display text-xl font-semibold text-ink">Requests</h2>
      {loading ? (
        <p className="mt-3 label-sm" role="status">
          Loading requests…
        </p>
      ) : requests.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No requests yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {requests.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-3 py-4">
              <span className="text-sm text-ink">{item.subject}</span>
              <span className="label-sm">{item.status.replace(/_/g, " ")}</span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleCreate} className="mt-6 flex max-w-lg items-end gap-3">
        <div className="flex-1">
          <label htmlFor="request-subject" className="label-sm">
            New request
          </label>
          <input
            id="request-subject"
            required
            value={subject}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setSubject(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className={`border border-ink bg-ink px-4 py-2.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50 ${focusRing}`}
        >
          {creating ? "Adding…" : "Add"}
        </button>
      </form>

      <h2 className="mt-12 font-display text-xl font-semibold text-ink">Add a document</h2>
      <form onSubmit={handleUpload} className="mt-4 max-w-lg space-y-5">
        <div>
          <label htmlFor="document-filename" className="label-sm">
            Filename
          </label>
          <input
            id="document-filename"
            required
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
        </div>

        <div>
          <label htmlFor="document-request" className="label-sm">
            Attach to request
          </label>
          <select
            id="document-request"
            value={uploadRequestId}
            onChange={(event) => setUploadRequestId(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
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
            className={`${fieldClass} ${focusRing}`}
          />
        </div>

        <button
          type="submit"
          disabled={uploading}
          className={`border border-ink bg-ink px-4 py-2.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50 ${focusRing}`}
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>
      </form>

      {extraction && (
        <section className="mt-12">
          <h2 className="font-display text-xl font-semibold text-ink">Extraction</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
            Confidence is a heuristic, not a judgement. The person heuristic in
            particular matches any two capitalised words, so a room name reads
            the same as a name — remove anything that is not what it claims to
            be. Corrections append; nothing is overwritten.
          </p>

          {FIELDS.map((field) => (
            <div key={field.key} className="mt-6">
              <h3 className="label-sm">{field.label}</h3>
              {extraction.entities[field.key].length === 0 ? (
                <p className="mt-1 text-sm text-muted">None.</p>
              ) : (
                <ul className="mt-2 divide-y divide-rule border-y border-rule">
                  {extraction.entities[field.key].map((entry) => (
                    <li
                      key={entry.value}
                      className="flex flex-wrap items-baseline justify-between gap-3 py-2.5"
                    >
                      <span className="text-sm text-ink">{entry.value}</span>
                      <span className="flex items-baseline gap-3">
                        <span className="label-sm">
                          {entry.confidence} · {entry.pattern}
                        </span>
                        <button
                          type="button"
                          onClick={() => void removeValue(field.key, entry.value)}
                          className={`border border-rule px-2 py-1 text-[11px] font-semibold uppercase tracking-label text-muted hover:border-ink hover:text-ink ${focusRing}`}
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

          <p className="mt-6 label-sm">
            {history.length} version{history.length === 1 ? "" : "s"} on record
          </p>
        </section>
      )}
    </div>
  );
}

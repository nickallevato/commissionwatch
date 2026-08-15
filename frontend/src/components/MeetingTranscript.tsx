import { Link } from "react-router-dom";
import { Absence } from "@/components/ui/Absence";
import { useTranscriptCoverage } from "@/hooks/useTranscriptCoverage";
import {
  absenceReasonFor,
  coverageForMeeting,
  unanimousState,
} from "@/lib/transcript-coverage";
import type {
  MeetingDocument,
  MeetingTranscriptDocument,
  MeetingTranscriptSummary,
} from "@/types";

/**
 * What the custodian published as a transcript of this meeting's recording.
 *
 * The distinction this section exists for is the one
 * `migrations/089_create_transcript_status.ts` was created to hold open. Three
 * states, three different statements:
 *
 *   published    the custodian published captions and we have them
 *   absent       the custodian published *nothing* — an 8-byte empty caption
 *                file, which is a fact about their record and not a broken
 *                fetcher. It is era-shaped: 8 of 8 sampled 2013–2020 clips are
 *                empty, 1 of 22 from 2021–2026.
 *   unavailable  we could not fetch or could not parse. That one is **ours**.
 *
 * Rendering `absent` as a failure would accuse the city of losing a record they
 * chose not to make. Rendering `unavailable` as an absence would publish our
 * outage as their silence. `<Absence>` carries exactly this distinction:
 * `absent-upstream` says the source published none, `request-failed` says we
 * could not ask and links to the status page.
 *
 * **This used to be a statement about a calendar year.** Until 2026-08-15 the
 * only public read of `transcript_status` was `/api/transcripts/coverage`,
 * grouped by jurisdiction, body and year, and the `meeting_documents` row a
 * meeting page could see proves nothing — it is written at discovery, so the
 * 8-byte empty caption file produces exactly the same row as a three-hour
 * transcript. So the page spoke only when a whole year was unanimous and
 * otherwise said it could not tell. `GET /api/meetings/:id` now returns a
 * `transcript` field and the page can stop guessing.
 *
 * Two things about that field shape this component, and both were deliberate
 * on the backend:
 *
 * **It is per document, not per meeting.** `transcript_status` is keyed on
 * `meeting_document_id` because Bozeman files one sitting as two rows, each
 * with its own clip. A meeting whose first half published and whose second half
 * we could not fetch is two statements, so every entry is rendered and none is
 * summarised away.
 *
 * **`transcript: null` is a fifth state.** `unchecked` means there is a
 * document we never asked about; `null` means there is nothing to ask about.
 * Folding them together would turn "the archive lists no recording" into "we
 * have not got round to it", or the reverse.
 *
 * The year-coverage fallback survives for the one case that is genuinely
 * unanswerable per meeting: a response with no `transcript` key at all, which
 * is what an older backend sends. See `MeetingDetail.transcript`.
 */

export interface MeetingTranscriptProps {
  jurisdiction: string;
  /** The body's name as `commissions.name` holds it — coverage groups on it. */
  body: string;
  /** `meetings.date`, `YYYY-MM-DD`. */
  date: string;
  /**
   * `GET /api/meetings/:id` → `transcript`. `undefined` means the response did
   * not carry the field and is the only case that falls back to the year.
   */
  transcript?: MeetingTranscriptSummary | null;
  documents: MeetingDocument[];
}

export function MeetingTranscript({
  jurisdiction,
  body,
  date,
  transcript,
  documents,
}: MeetingTranscriptProps) {
  return (
    <section aria-labelledby="transcript-heading" className="mt-10">
      <div className="rule-hi" />
      <div className="pt-3">
        <span className="kicker">From the recording</span>
        <h2
          id="transcript-heading"
          className="font-display text-2xl leading-headline tracking-headline text-ink"
        >
          Transcript
        </h2>
      </div>

      {transcript === undefined ? (
        <YearCoverage
          jurisdiction={jurisdiction}
          body={body}
          date={date}
          documents={documents}
        />
      ) : transcript === null ? (
        // The fifth state. `none-exist` is the right reason and the strongest
        // one `<Absence>` has: this is not a caption file that came back empty
        // and not a document we have yet to check — the archive lists no
        // recording for this sitting, so there is nothing for a transcript to
        // be missing from.
        <div className="mt-4" data-testid="transcript-none">
          <Absence reason="none-exist" subject="recording of this meeting">
            No caption file has been asked for, because there is no clip filed
            against this meeting to ask about.
          </Absence>
        </div>
      ) : (
        <TranscriptDocuments transcript={transcript} documents={documents} />
      )}
    </section>
  );
}

/* ------------------------------------------------------- per-document state */

function TranscriptDocuments({
  transcript,
  documents,
}: {
  transcript: MeetingTranscriptSummary;
  documents: MeetingDocument[];
}) {
  const entries = transcript.documents;

  return (
    <div className="mt-4">
      {/* Said out loud rather than left for the reader to infer from two
        headings: a sitting filed as two clips is two statements, and a reader
        who missed that would read the first one as the meeting's. */}
      {entries.length > 1 ? (
        <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
          The custodian files this sitting as{" "}
          <span className="figure">{entries.length}</span> recordings. Each one
          is stated separately below; none of them speaks for the others.
        </p>
      ) : null}

      <div className={entries.length > 1 ? "mt-4 space-y-6" : "space-y-6"}>
        {entries.map((entry) => (
          <TranscriptEntry
            key={entry.meeting_document_id}
            entry={entry}
            document={documents.find(
              (doc) => doc.id === entry.meeting_document_id,
            )}
          />
        ))}
      </div>
    </div>
  );
}

function TranscriptEntry({
  entry,
  document,
}: {
  entry: MeetingTranscriptDocument;
  document: MeetingDocument | undefined;
}) {
  return (
    <article data-testid="transcript-document" data-state={entry.state}>
      <h3 className="font-sans text-base font-semibold tracking-normal text-ink">
        {document?.title ??
          (entry.clip_id ? `Recording ${entry.clip_id}` : "Recording")}
      </h3>

      {entry.state === "published" ? (
        <>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
            The custodian published captions for this recording, and we hold
            them. The text is searchable with the rest of the record.
          </p>
          {document ? (
            <p className="mt-2">
              <a
                className="cite"
                href={document.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {document.title}
              </a>
            </p>
          ) : null}
        </>
      ) : (
        <>
          <Absence reason={absenceReasonFor(entry.state)} subject="transcript" />
          {entry.state === "absent" ? (
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              The caption file served for this recording is empty. That is what
              the custodian published, not a document we failed to collect.
            </p>
          ) : null}
          {entry.state === "unchecked" ? (
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              The archive lists this recording. Nobody has yet asked it for a
              caption file, so we know nothing about what it holds.
            </p>
          ) : null}
        </>
      )}

      <Provenance entry={entry} />
    </article>
  );
}

/**
 * The two figures that make a statement about a recording checkable, and the
 * date it was last true.
 *
 * `cue_count` is printed only when it is a number. It is null for `unavailable`
 * and `unchecked` — the states where we did not read any bytes — and a zero
 * there would read exactly like the `absent` case, which is the custodian's
 * empty caption file and a real zero. Our ignorance is not their silence, so
 * the line is absent rather than confidently wrong.
 *
 * `observed_sha256` is text, not a link. Migration 089 deliberately kept it out
 * of a foreign key to `artifacts`, so the hash can be true of bytes that were
 * never stored — and `/source/{sha}` would answer 404 for those, which reads as
 * a broken citation rather than an unstored one.
 */
function Provenance({ entry }: { entry: MeetingTranscriptDocument }) {
  const parts: string[] = [];
  if (entry.cue_count !== null) {
    parts.push(
      entry.cue_count === 1
        ? "1 caption cue indexed"
        : `${entry.cue_count} caption cues indexed`,
    );
  }
  if (entry.last_checked_at) {
    parts.push(`last checked ${entry.last_checked_at.slice(0, 10)}`);
  }
  if (parts.length === 0 && !entry.observed_sha256) return null;

  return (
    <p className="mt-2 text-xs leading-relaxed text-muted">
      {parts.join(" · ")}
      {entry.observed_sha256 ? (
        <>
          {parts.length > 0 ? " · " : null}
          <span title={entry.observed_sha256} className="font-mono">
            {entry.observed_sha256.slice(0, 12)}
          </span>{" "}
          is the sha256 of the bytes we read.
        </>
      ) : null}
    </p>
  );
}

/* ------------------------------------------------- fallback: the whole year */

/**
 * What this component said about every meeting before `/api/meetings/:id`
 * carried a transcript field, kept for the one response that still cannot
 * answer per meeting.
 *
 * `unanimousState` speaks about this sitting only when every meeting in its
 * calendar year shares one state; a mixed year reports the year's four figures
 * and claims nothing about this meeting, because attributing one meeting's
 * outcome to another in the `unavailable` direction publishes our outage as the
 * custodian's record. See `lib/transcript-coverage.ts`.
 *
 * The coverage request is fired from inside this branch rather than from the
 * component above, so the common path costs no round trip for a figure it will
 * not use.
 */
function YearCoverage({
  jurisdiction,
  body,
  date,
  documents,
}: {
  jurisdiction: string;
  body: string;
  date: string;
  documents: MeetingDocument[];
}) {
  const { data, isLoading, isError } = useTranscriptCoverage();
  const row = coverageForMeeting(data ?? [], jurisdiction, body, date);
  const state = unanimousState(row);
  // The document row proves nothing about the caption file's contents, which is
  // why this whole branch exists — but once the year has said "published", it
  // is the address of the thing that was published.
  const captionFile = documents.find((doc) => doc.document_type === "transcript");

  if (isLoading) {
    return <p className="mt-4 text-sm text-muted">Loading transcript coverage…</p>;
  }
  if (isError || !data) {
    return <Absence reason="request-failed" subject="The transcript record" />;
  }
  if (state === "published") {
    return (
      <div className="mt-4" data-testid="transcript-published">
        <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
          The custodian published captions for this meeting, and we hold them.
          The text is searchable with the rest of the record.
        </p>
        {captionFile ? (
          <p className="mt-2">
            <a
              className="cite"
              href={captionFile.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {captionFile.title}
            </a>
          </p>
        ) : null}
      </div>
    );
  }
  if (state !== null) {
    return (
      <div className="mt-4" data-testid={`transcript-${state}`}>
        <Absence reason={absenceReasonFor(state)} subject="transcript" />
        {state === "absent" ? (
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
            The caption file served for this recording is empty. That is what
            the custodian published, not a document we failed to collect.
          </p>
        ) : null}
      </div>
    );
  }
  if (row) {
    // A mixed year. Nothing here is a claim about this sitting — the four
    // figures are the year's, and they are labelled as the year's.
    return (
      <div className="mt-4" data-testid="transcript-year">
        <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
          We do not publish a per-meeting transcript state yet. For {body} in{" "}
          <span className="figure">{row.year}</span>:{" "}
          <span className="figure">{row.published}</span> meetings have captions,{" "}
          <span className="figure">{row.absent}</span> have an empty caption file
          the custodian published,{" "}
          <span className="figure">{row.unavailable}</span> we could not collect,
          and <span className="figure">{row.unchecked}</span> have not been
          checked.
        </p>
        {row.unavailable > 0 ? (
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
            The meetings we could not collect are ours, not theirs.{" "}
            <Link className="cite" to="/status">
              Collection status
            </Link>
          </p>
        ) : null}
      </div>
    );
  }
  return <Absence reason="not-yet-ingested" subject="transcripts for this body" />;
}

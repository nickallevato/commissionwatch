import { Link } from "react-router-dom";
import { Absence } from "@/components/ui/Absence";
import { useTranscriptCoverage } from "@/hooks/useTranscriptCoverage";
import {
  absenceReasonFor,
  coverageForMeeting,
  unanimousState,
} from "@/lib/transcript-coverage";
import type { MeetingDocument } from "@/types";

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
 * **The state is per year, not per meeting, because that is all the API
 * exposes.** `/api/transcripts/coverage` groups by jurisdiction, body and
 * calendar year; `/api/meetings/:id` returns `meeting_documents` rows with a
 * `document_type` and no state. A transcript row is written at discovery, so
 * its presence means the archive lists a recording and nothing about whether
 * the caption file has words in it. `unanimousState` therefore speaks about
 * this meeting only when every meeting in its year shares one state, and the
 * mixed case reports the year's four figures and claims nothing further. See
 * `lib/transcript-coverage.ts`.
 */

export interface MeetingTranscriptProps {
  jurisdiction: string;
  /** The body's name as `commissions.name` holds it — coverage groups on it. */
  body: string;
  /** `meetings.date`, `YYYY-MM-DD`. */
  date: string;
  documents: MeetingDocument[];
}

function transcriptDocument(
  documents: MeetingDocument[],
): MeetingDocument | undefined {
  return documents.find((doc) => doc.document_type === "transcript");
}

export function MeetingTranscript({
  jurisdiction,
  body,
  date,
  documents,
}: MeetingTranscriptProps) {
  const { data, isLoading, isError } = useTranscriptCoverage();
  const row = coverageForMeeting(data ?? [], jurisdiction, body, date);
  const state = unanimousState(row);
  const doc = transcriptDocument(documents);

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

      {isLoading ? (
        <p className="mt-4 text-sm text-muted">Loading transcript coverage…</p>
      ) : isError || !data ? (
        <Absence reason="request-failed" subject="The transcript record" />
      ) : state === "published" ? (
        <div className="mt-4" data-testid="transcript-published">
          <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
            The custodian published captions for this meeting, and we hold them.
            The text is searchable with the rest of the record.
          </p>
          {doc ? (
            <p className="mt-2">
              <a
                className="cite"
                href={doc.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {doc.title}
              </a>
            </p>
          ) : null}
        </div>
      ) : state !== null ? (
        <div className="mt-4" data-testid={`transcript-${state}`}>
          <Absence reason={absenceReasonFor(state)} subject="transcript" />
          {state === "absent" ? (
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              The caption file served for this recording is empty. That is what
              the custodian published, not a document we failed to collect.
            </p>
          ) : null}
        </div>
      ) : row ? (
        // A mixed year. Nothing here is a claim about this sitting — the four
        // figures are the year's, and they are labelled as the year's.
        <div className="mt-4" data-testid="transcript-year">
          <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
            We do not publish a per-meeting transcript state yet. For {body} in{" "}
            <span className="figure">{row.year}</span>:{" "}
            <span className="figure">{row.published}</span> meetings have
            captions, <span className="figure">{row.absent}</span> have an empty
            caption file the custodian published,{" "}
            <span className="figure">{row.unavailable}</span> we could not
            collect, and <span className="figure">{row.unchecked}</span> have
            not been checked.
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
      ) : (
        <Absence reason="not-yet-ingested" subject="transcripts for this body" />
      )}
    </section>
  );
}

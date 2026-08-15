import type { AnomalyFlag, Meeting, MeetingDocument } from "@/types";

/**
 * Which record a finding was drawn from, resolved once.
 *
 * **A finding is not a claim, and it cannot use `<Citation>`.** `CitationRef`
 * demands an artifact hash and a quote offset, and `minute_claims` has both at
 * NOT NULL. `anomaly_flags` has neither: the public payload is the row —
 * `flag_type`, `description`, `severity`, `source`, `metadata`, `created_at`,
 * an optional `artifact_id` — and no quotation of anything. The stored
 * artifacts a finding rests on are resolved server-side in
 * `services/review/evidence.ts` and served only to the operator console at
 * `/api/admin/review`, where an approver reads them. Handing a decorative
 * source line to `<Citation>` would render "no unsourced claim reaches the
 * public site" as a false positive on every finding on the site, which is worse
 * than the site admitting it cites a document rather than a sentence.
 *
 * So what the two finding surfaces share is *this* — one rule for naming the
 * document — instead of the two they had. The meeting page resolved a named
 * `metadata.source_document`, preferred the agenda for a flag about how a
 * meeting was noticed and the minutes for one about what happened in the room;
 * `AnomalyCard` on the findings ledger ignored the metadata entirely and always
 * preferred the minutes. Two answers to "where did this come from" for the same
 * row, and a reader who followed one of them was reading a different document
 * than a reader who followed the other.
 *
 * Not a component, and in a `.ts` for that reason: a non-component export
 * beside one costs a react-refresh warning. See `citation-source.ts`.
 */

export interface FindingSourceRef {
  /** How a reader should refer to it — a document title, or "minutes". */
  label: string;
  /** Where we got it. Null when no document is on file to point at. */
  url: string | null;
}

/**
 * The document whose title or type names `kind`.
 *
 * Both are checked because `meeting_documents.document_type` is free text from
 * the adapter and a custodian's "Minutes — 12 March" may arrive typed `other`.
 */
function findDocument(
  documents: readonly MeetingDocument[],
  kind: string,
): MeetingDocument | undefined {
  return documents.find(
    (doc) =>
      doc.document_type.toLowerCase().includes(kind) ||
      doc.title.toLowerCase().includes(kind),
  );
}

/**
 * The record a finding cites, or the honest admission that none is on file.
 *
 * Only sources that actually exist on the meeting are named. When nothing is
 * published the label says so rather than implying a document that was never
 * written — a chip pointing at the wrong PDF is worse than no chip, because it
 * invites a reader to check and the check appears to confirm.
 */
export function resolveFindingSource(
  anomaly: AnomalyFlag,
  meeting: Meeting | undefined,
  documents: readonly MeetingDocument[] = [],
): FindingSourceRef {
  const named = anomaly.metadata?.source_document;
  if (typeof named === "string" && named.length > 0) {
    const match = documents.find((doc) => doc.title === named);
    const url = anomaly.metadata?.source_url;
    return {
      label: named,
      url: match?.url ?? (typeof url === "string" ? url : null),
    };
  }

  const agendaDoc = findDocument(documents, "agenda");
  const minutesDoc = findDocument(documents, "minutes");
  const agenda: FindingSourceRef | null =
    agendaDoc || meeting?.agenda_url
      ? {
          label: agendaDoc?.title ?? "agenda",
          url: agendaDoc?.url ?? meeting?.agenda_url ?? null,
        }
      : null;
  const minutes: FindingSourceRef | null =
    minutesDoc || meeting?.minutes_url
      ? {
          label: minutesDoc?.title ?? "minutes",
          url: minutesDoc?.url ?? meeting?.minutes_url ?? null,
        }
      : null;

  if (anomaly.flag_type === "missing_minutes") {
    return minutes ?? { label: "no minutes on file", url: null };
  }
  // How the meeting was noticed is evidenced by the agenda; what happened in
  // the room is evidenced by the minutes.
  if (
    anomaly.flag_type === "last_minute_agenda_change" ||
    anomaly.flag_type === "emergency_session"
  ) {
    return agenda ?? minutes ?? { label: "meeting record", url: null };
  }
  return minutes ?? agenda ?? { label: "meeting record", url: null };
}

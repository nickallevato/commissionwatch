import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * The grammar of nothing.
 *
 * Empty states on this site are load-bearing statements, not placeholders.
 * "Bozeman: last successful sweep 6 days ago" is a *feature*; "no data" is a lie
 * of omission — a transparency project that silently stops ingesting is worse
 * than one that says it has.
 *
 * Every page had been writing its own, and they had already drifted: some
 * distinguish a failed request from an empty record and some do not, and the
 * ones that do phrase it differently. The distinction is the whole point. A
 * reader who is told "none" when the truth is "we could not ask" has been given
 * the strongest possible claim on the weakest possible evidence.
 *
 * **There is deliberately no reason meaning "we don't know".** If the system
 * cannot say why something is empty, that is a defect in the ingestion ledger
 * rather than a copy problem, and it must surface as `sweep-failed` or as an
 * explicit `unknown` that links to the status page — never as blankness.
 */

export type AbsenceReason =
  /** A sweep has never run for this source. Nothing is wrong; nothing happened. */
  | "not-yet-ingested"
  /** A sweep ran and failed. This is ours, and it links to the status page. */
  | "sweep-failed"
  /** Records exist and an operator has not published them. Held, not missing. */
  | "withheld"
  /** The record itself shows none. The strongest claim here, and rarely true. */
  | "none-exist"
  /** Ingested, not yet through review. Work waiting, not work hidden. */
  | "not-reviewed"
  /**
   * The source published nothing at this address.
   *
   * Distinct from `none-exist`: "the county published no minutes for this
   * meeting" and "the meeting had no minutes" are different statements, and the
   * transcripts work needs exactly this distinction — an 8-byte empty caption
   * file is a publication of nothing, which is not the same as no publication.
   */
  | "absent-upstream"
  /** We could not ask. Never conflated with an empty answer. */
  | "request-failed";

interface Copy {
  /** `{subject}` is substituted with the caller's noun. */
  readonly sentence: string;
  /** Whether this absence is a failure of ours rather than a fact about them. */
  readonly ours: boolean;
}

const COPY: Record<AbsenceReason, Copy> = {
  "not-yet-ingested": {
    sentence: "No sweep has collected {subject} yet.",
    ours: false,
  },
  "sweep-failed": {
    sentence:
      "The last attempt to collect {subject} failed, so this may be incomplete.",
    ours: true,
  },
  withheld: {
    sentence: "{subject} exist for this record and have not been published yet.",
    ours: false,
  },
  "none-exist": {
    sentence: "The record shows no {subject}.",
    ours: false,
  },
  "not-reviewed": {
    sentence: "No {subject} from this record have been reviewed yet.",
    ours: false,
  },
  "absent-upstream": {
    sentence: "The source published no {subject} here.",
    ours: false,
  },
  "request-failed": {
    sentence:
      "{subject} could not be loaded. That is a failure on our side, not a statement that there are none.",
    ours: true,
  },
};

export interface AbsenceProps {
  reason: AbsenceReason;
  /**
   * The plural noun this is about — "matters", "findings", "minutes".
   * Lowercase; the sentence templates place it.
   */
  subject: string;
  /** Anything further the caller can say that the reason cannot. */
  children?: ReactNode;
}

export function Absence({ reason, subject, children }: AbsenceProps) {
  const copy = COPY[reason];
  const sentence = copy.sentence.replace("{subject}", subject);
  // Capitalise only when the subject opens the sentence, so "{subject} exist…"
  // reads correctly without every caller passing a capitalised noun.
  const text = sentence.charAt(0).toUpperCase() + sentence.slice(1);

  return (
    <p className="mt-8 max-w-prose text-sm leading-relaxed text-ink-soft">
      {text}
      {copy.ours ? (
        <>
          {" "}
          <Link to="/status" className="underline underline-offset-2">
            Collection status
          </Link>{" "}
          says what we have been able to reach.
        </>
      ) : null}
      {children ? <> {children}</> : null}
    </p>
  );
}

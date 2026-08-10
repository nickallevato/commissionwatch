import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * `/public-records` — the statutory route, offered to anyone.
 *
 * The scraping policy on the Methodology page commits to offering the
 * public-records route alongside the vendor-robots exception. Until now that
 * offer was a sentence. This is the sentence with a button on it: a reader
 * picks a gap in the published record, supplies their own name and email, and
 * gets a letter to send under their own name.
 *
 * Three things this page does not do, each of them deliberate:
 *
 * - **It sends nothing.** The API drafts text and hands it back. There is no
 *   send control here because there is no send path anywhere, and the page says
 *   so plainly rather than leaving a reader to wonder what happened after they
 *   clicked.
 * - **It stores nothing.** No request row, no record of who asked for what. A
 *   reader exercising a statutory right is not a thing this project logs.
 * - **It shows only published records.** The gap list comes back through the
 *   publication wall, so a meeting an operator has not published cannot be
 *   named here or requested from here.
 *
 * When a jurisdiction has no verified records law the API refuses and this page
 * shows the refusal in full. That is the correct outcome, not an error state to
 * be smoothed over: a letter citing the wrong statute is worse than no letter.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const fieldClass =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink hover:border-ink";

const buttonClass =
  "border border-ink bg-ink px-4 py-2.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50";

interface RecordGap {
  id: string;
  kind: string;
  jurisdiction_name: string;
  summary: string;
  requested_record: string;
  meeting_id: string | null;
  meeting_date: string | null;
  commission_name: string | null;
}

interface LetterResponse {
  letter: string;
  warnings: string[];
}

const KIND_LABELS: Record<string, string> = {
  missing_minutes: "Minutes not in the record",
  unpublished_exhibit: "Exhibit not published",
};

export function PublicRecordsPage() {
  const [params] = useSearchParams();
  const meetingId = params.get("meeting");

  const [gaps, setGaps] = useState<RecordGap[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [organization, setOrganization] = useState("");
  const [address, setAddress] = useState("");

  const [drafting, setDrafting] = useState(false);
  const [letter, setLetter] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [refusal, setRefusal] = useState("");

  const loadGaps = useCallback(async (): Promise<RecordGap[] | null> => {
    try {
      const query = meetingId ? `?meeting_id=${encodeURIComponent(meetingId)}` : "";
      const res = await fetch(`/api/public-records/gaps${query}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { data: RecordGap[] };
      return body.data;
    } catch {
      return null;
    }
  }, [meetingId]);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await loadGaps();
      if (ignore) return;
      if (result === null) {
        setLoadError("The list of gaps could not be loaded.");
      } else {
        setGaps(result);
        setLoadError("");
      }
      setLoading(false);
    })();
    return () => {
      ignore = true;
    };
  }, [loadGaps]);

  async function handleDraft(event: FormEvent) {
    event.preventDefault();
    setDrafting(true);
    setLetter("");
    setWarnings([]);
    setRefusal("");

    try {
      const res = await fetch("/api/public-records/letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gap_id: selected,
          requester: { name, email, organization, address },
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        // Shown verbatim. The refusal names the table, the jurisdiction and the
        // columns somebody has to fill in; paraphrasing it would throw away the
        // only part that can be acted on.
        setRefusal(body?.error ?? "That request could not be drafted.");
        return;
      }

      const body = (await res.json()) as LetterResponse;
      setLetter(body.letter);
      setWarnings(body.warnings);
    } catch {
      setRefusal("That request could not be drafted.");
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div>
      <p className="kicker">Public records</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">Request a record</h1>
      <div className="rule-hi mt-4" role="presentation" />

      <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-soft">
        Where a document is referenced in the published record and is not in it,
        Montana&rsquo;s public information law gives you a route to it directly.
        This page drafts that letter for you, naming the record and citing the
        statute recorded for that jurisdiction.
      </p>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
        <strong className="font-semibold text-ink">
          Nothing is sent on your behalf, and nothing you type here is stored.
        </strong>{" "}
        The letter is yours: copy it, edit it, and send it from your own email
        under your own name.
      </p>

      <section className="mt-10" aria-labelledby="gaps">
        <h2 id="gaps" className="font-display text-xl font-semibold text-ink">
          Gaps in the published record
        </h2>

        {loading ? (
          <p className="mt-3 label-sm" role="status">
            Loading…
          </p>
        ) : loadError ? (
          <p role="alert" className="mt-4 border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm text-ink-soft">
            {loadError}
          </p>
        ) : gaps.length === 0 ? (
          <p className="mt-3 max-w-prose text-sm text-muted">
            No gaps are open in the published record right now. That is a
            statement about what has been published, not about what exists.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-rule border-y border-rule">
            {gaps.map((gap) => (
              <li key={gap.id} className="py-4">
                <label className="flex items-baseline gap-3">
                  <input
                    type="radio"
                    name="gap"
                    value={gap.id}
                    checked={selected === gap.id}
                    onChange={() => setSelected(gap.id)}
                    className={focusRing}
                  />
                  <span>
                    <span className="label-sm block">
                      {KIND_LABELS[gap.kind] ?? gap.kind} · {gap.jurisdiction_name}
                    </span>
                    <span className="mt-1 block text-sm text-ink">{gap.summary}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={handleDraft} className="mt-10 max-w-lg space-y-5">
        <h2 className="font-display text-xl font-semibold text-ink">Your details</h2>
        <p className="text-sm text-muted">
          These appear in the letter so a custodian can reply to you. They are
          not sent anywhere by this site.
        </p>

        <div>
          <label htmlFor="requester-name" className="label-sm">
            Name
          </label>
          <input
            id="requester-name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
        </div>

        <div>
          <label htmlFor="requester-email" className="label-sm">
            Email
          </label>
          <input
            id="requester-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
        </div>

        <div>
          <label htmlFor="requester-organization" className="label-sm">
            Organisation (optional)
          </label>
          <input
            id="requester-organization"
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
        </div>

        <div>
          <label htmlFor="requester-address" className="label-sm">
            Postal address (optional)
          </label>
          <input
            id="requester-address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
        </div>

        <button type="submit" disabled={drafting || selected === ""} className={`${buttonClass} ${focusRing}`}>
          {drafting ? "Drafting…" : "Draft the letter"}
        </button>
      </form>

      {refusal && (
        <section className="mt-10 max-w-prose" aria-labelledby="refusal">
          <h2 id="refusal" className="font-display text-xl font-semibold text-ink">
            No letter was drafted
          </h2>
          <p role="alert" className="mt-3 border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm leading-relaxed text-ink-soft">
            {refusal}
          </p>
        </section>
      )}

      {letter && (
        <section className="mt-10" aria-labelledby="letter">
          <h2 id="letter" className="font-display text-xl font-semibold text-ink">
            Your letter
          </h2>

          {warnings.length > 0 && (
            <ul className="mt-3 max-w-prose space-y-2">
              {warnings.map((warning) => (
                <li
                  key={warning}
                  className="border-l-2 border-rule bg-paper-sunk px-4 py-3 text-sm leading-relaxed text-ink-soft"
                >
                  {warning}
                </li>
              ))}
            </ul>
          )}

          <label htmlFor="letter-text" className="sr-only">
            Letter text
          </label>
          <textarea
            id="letter-text"
            readOnly
            rows={24}
            value={letter}
            className={`${fieldClass} font-mono text-xs leading-relaxed ${focusRing}`}
          />
          <p className="mt-3 max-w-prose text-sm text-muted">
            Read it before you send it. It states what record you are asking for
            and cites the statute on file for that jurisdiction; it makes no
            claim about anyone&rsquo;s conduct, and you should not add one.
          </p>
        </section>
      )}
    </div>
  );
}

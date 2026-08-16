import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatTimestamp } from "@/lib/dates";
import type { PublicCorrection, PublicCorrectionResponse } from "@/types";

/**
 * `/corrections` — the stated policy, and the log that proves it is kept.
 *
 * The policy alone would be a paragraph of intent, and this project's whole
 * subject is the difference between a published commitment and a kept one. So
 * the page is the commitment above and the evidence below, on one screen, and
 * the evidence is a query rather than a maintained list: a corrections log kept
 * by hand is a corrections log that lies eventually.
 *
 * **No response-time promise appears here.** The Methodology page used to
 * promise "2 business days", "10 business days", "24 hours" and "3 business
 * days"; nothing in this codebase measured, tracked or alerted on any of them.
 * Four unenforced clocks on the page belonging to the project that exists to
 * catch unenforced claims. What replaces them is what is actually true and
 * checkable, and each sentence below corresponds to a mechanism.
 *
 * **The log shows corrections to records that are published now.** That is a
 * real limit and it is stated rather than left to be discovered: a correction
 * to a record an operator has withheld would disclose the withheld record, so
 * it does not appear, and it appears the moment the record is published.
 */

const CORRECTIONS_EMAIL = "corrections@commissionwatch.bmux.sh";

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** What the project will do, each backed by something in the code. */
const WILL: readonly string[] = [
  "Read every dispute. It goes into the same queue an operator works through to decide what publishes, and it is seen by a person.",
  "Record what was decided and why, permanently, in a log that cannot be edited or deleted — the database refuses both.",
  "Publish every correction to a published record on this page, with what it said before, what it says now, and the stated reason.",
  "Name the dispute that prompted a correction, by its reference, so a change can be traced back to the person who asked for it.",
  "Leave the evidence alone. A correction records a new value beside the old one; the stored document a claim came from is never edited.",
];

/** And what it will not, stated so nobody has to infer it. */
const WILL_NOT: readonly string[] = [
  "Publish your dispute. What you write is a private communication to this project. It is never published, and the database permits no state in which it could be.",
  "Ask for identity documents. Three things are collected — what is contested, your account of it, and a contact — and nothing else about you is stored.",
  "Edit a record because a dispute was filed. Upholding a dispute is a decision to look again; the correction that follows is a separate, recorded act.",
  "Promise a response time. Nothing in this project measures one, and a clock nothing enforces is the kind of claim this site exists to find in other people's publications.",
  "Email you. No part of this product sends mail. Your reference is shown on screen when you submit — keep it.",
];

export function CorrectionsPage() {
  const [corrections, setCorrections] = useState<PublicCorrection[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const res = await fetch("/api/corrections?limit=100");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as PublicCorrectionResponse;
        if (ignore) return;
        setCorrections(body.data);
        setTotal(body.total);
        setError("");
      } catch {
        if (!ignore) setError("The corrections log could not be loaded.");
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <header>
        <p className="kicker">Accountability</p>
        <h1 className="headline mt-2 text-4xl sm:text-5xl">
          Corrections and disputes
        </h1>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-ink-soft">
          This site publishes claims about named people, drawn from documents
          those people&rsquo;s governments published. It will sometimes be wrong.
          A project that asks other people for accountability and cannot itself
          be corrected in public has no standing to ask, so this page states how
          to contest something here, what happens next, and every correction
          that has been made.
        </p>
      </header>

      {/* ------------------------------------------------------ how to contest */}
      <section className="mt-12" aria-labelledby="contest">
        <h2
          id="contest"
          className="scroll-mt-8 font-display text-2xl tracking-headline"
        >
          How to contest a record
        </h2>
        <hr className="mt-3 rule-hi" />
        <p className="mt-4 max-w-prose text-[0.9375rem] leading-relaxed text-ink-soft">
          Open the page you disagree with, use{" "}
          <Link className="cite" to="/corrections/dispute">
            Contest a record
          </Link>
          , and say what is wrong and why. You need three things: the record, a
          sentence about what is contested, and a way to reach you. That is all
          this project asks for and all it stores.
        </p>
        <p className="mt-4 max-w-prose text-[0.9375rem] leading-relaxed text-ink-soft">
          You can also write to{" "}
          <a
            href={`mailto:${CORRECTIONS_EMAIL}`}
            className={`underline underline-offset-2 hover:text-accent ${focusRing}`}
          >
            {CORRECTIONS_EMAIL}
          </a>
          . You do not have to say who you are beyond a contact — an anonymous
          dispute pointing at a document that proves this site wrong is still
          right, and the document is what settles it either way.
        </p>
      </section>

      {/* ---------------------------------------------------- what happens next */}
      <section className="mt-12" aria-labelledby="next">
        <h2 id="next" className="scroll-mt-8 font-display text-2xl tracking-headline">
          What happens next
        </h2>
        <hr className="mt-3 rule-hi" />
        <ol className="mt-4 max-w-prose">
          {[
            "You get a reference on screen. Keep it — nothing is emailed, and it is how you refer to your dispute later.",
            "It enters the operator review queue: the same queue that decides what publishes on this site at all. It is not a public form and nothing about it appears anywhere until a person has read it.",
            "An operator either upholds it or declines it, with a written reason, and that decision is appended to a log that cannot be rewritten.",
            "If it is upheld, the record is corrected as a separate, deliberate act with its own reason — and the correction appears in the log below, naming your reference.",
          ].map((step, index) => (
            <li
              key={step}
              className="grid grid-cols-[2rem_1fr] gap-x-4 border-t border-rule py-4 first:border-t-0 first:pt-0"
            >
              <span className="figure pt-0.5 text-sm text-accent">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-sm leading-relaxed text-ink-soft">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* --------------------------------------------------- will / will not */}
      <section className="mt-12" aria-labelledby="commitments">
        <h2
          id="commitments"
          className="scroll-mt-8 font-display text-2xl tracking-headline"
        >
          What this project will and will not do
        </h2>
        <hr className="mt-3 rule-hi" />

        <div className="mt-6 grid gap-8 md:grid-cols-2">
          <div>
            <p className="label-sm">Will</p>
            <ul className="mt-2">
              {WILL.map((item) => (
                <li
                  key={item}
                  className="border-t border-rule py-3 text-sm leading-relaxed text-ink-soft first:border-t-0"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="label-sm">Will not</p>
            <ul className="mt-2">
              {WILL_NOT.map((item) => (
                <li
                  key={item}
                  className="border-t border-rule py-3 text-sm leading-relaxed text-ink-soft first:border-t-0"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-8 border-l-2 border-accent pl-4">
          <p className="label-sm">The invariant</p>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink">
            The evidence is never edited. A correction records a new value beside
            the old one, and the stored document a claim was drawn from stays
            exactly as it was fetched, at the hash it was fetched under. A
            transparency project that edits its own evidence has nothing left to
            stand on.
          </p>
        </div>
      </section>

      {/* -------------------------------------------------------------- the log */}
      <section className="mt-12" aria-labelledby="log">
        <h2 id="log" className="scroll-mt-8 font-display text-2xl tracking-headline">
          The corrections log
        </h2>
        <hr className="mt-3 rule-hi" />

        <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted">
          Every correction to a record that is published on this site, newest
          first, read straight from the log the site writes as it works. It is
          not a list anybody maintains.{" "}
          <strong className="font-semibold text-ink">
            Corrections to records that are not published do not appear here
          </strong>{" "}
          — showing them would disclose the record being withheld — and one
          appears the moment its record is published.
        </p>

        {loading ? (
          <p className="mt-6 label-sm" role="status">
            Loading…
          </p>
        ) : error ? (
          <p
            role="alert"
            className="mt-6 border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm text-ink-soft"
          >
            {error}
          </p>
        ) : corrections.length === 0 ? (
          <p className="mt-6 max-w-prose text-sm text-muted">
            No correction has been made to a published record. That is a
            statement about the log, not a claim that nothing has ever been
            wrong.
          </p>
        ) : (
          <>
            <p className="mt-6 label-sm tabular">
              {total} correction{total === 1 ? "" : "s"}
            </p>
            <ul className="mt-4 divide-y divide-rule border-y border-rule">
              {corrections.map((correction) => (
                <li key={correction.id} className="py-5">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="label-sm tabular">
                      {formatTimestamp(correction.created_at)}
                    </span>
                    <span className="label-sm">{correction.record_label}</span>
                    {correction.dispute_reference && (
                      <span className="text-[11px] font-semibold uppercase tracking-label text-accent">
                        Prompted by dispute {correction.dispute_reference}
                      </span>
                    )}
                  </div>

                  <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink">
                    {correction.summary}
                  </p>
                  <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
                    <span className="label-sm mr-2">Reason</span>
                    {correction.reason}
                  </p>

                  {correction.meeting_id && (
                    <p className="mt-2">
                      <Link className="cite" to={`/meetings/${correction.meeting_id}`}>
                        The record this changed
                      </Link>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <hr className="mt-12 border-t border-rule" />
      <p className="mt-4 text-sm text-muted">
        How this site produces what it publishes:{" "}
        <Link
          to="/methodology"
          className={`underline underline-offset-2 hover:text-accent ${focusRing}`}
        >
          methodology
        </Link>
        .
      </p>
    </div>
  );
}

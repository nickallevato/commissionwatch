import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { DisputableTable, DisputeReceipt } from "@/types";

/**
 * `/corrections/dispute` — a person named in a record contests it.
 *
 * Four things this page is careful about, because the person using it is
 * usually the subject of something they believe is wrong about them:
 *
 * - **It asks for three things.** What is contested, your account of it, and a
 *   contact. No identity document, no address, no account, no proof that you
 *   are who you say. The record either says what it says or it does not, and a
 *   document settles that regardless of who filed the dispute.
 * - **It says what happens, before you type.** It goes to a person, it is never
 *   published, it changes no record by itself, and nothing is emailed. A form
 *   that leaves someone waiting on an acknowledgement nobody sends is worse
 *   than no form.
 * - **The reference is the receipt.** It is shown after submission and is the
 *   only copy — see above about email — so the page says to keep it, in the
 *   place where keeping it is still possible.
 * - **Refusals are shown verbatim.** The API's messages name the actual
 *   problem; paraphrasing one into "something went wrong" would leave a person
 *   contesting a record about themselves with nothing to act on.
 *
 * The record can arrive as `?table=…&id=…` from a link on the record's own
 * page, or be recovered from a pasted address. A reader should not have to know
 * what a UUID is to contest something written about them.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const fieldClass =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink hover:border-ink";

const buttonClass =
  "border border-ink bg-ink px-4 py-2.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50";

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const TABLE_LABEL: Record<DisputableTable, string> = {
  meetings: "a meeting",
  agenda_items: "an agenda item",
  meeting_documents: "a document",
  anomaly_flags: "a finding",
};

const LIMITS = { contested: 300, account: 4000, contact: 200 } as const;

function isDisputableTable(value: string): value is DisputableTable {
  return (
    value === "meetings" ||
    value === "agenda_items" ||
    value === "meeting_documents" ||
    value === "anomaly_flags"
  );
}

/**
 * The record id out of an address a reader pasted.
 *
 * `/meetings/<uuid>` is the only shape a public page carries today, so that is
 * the only shape this recognises — guessing at others would produce a target
 * the API rejects and a refusal the reader cannot act on.
 */
function recordFromUrl(value: string): { table: DisputableTable; id: string } | null {
  const match = UUID_RE.exec(value);
  if (match === null) return null;
  if (!/\/meetings\//.test(value)) return null;
  return { table: "meetings", id: match[0] };
}

export function DisputePage() {
  const [params] = useSearchParams();
  const paramTable = params.get("table") ?? "";
  const paramId = params.get("id") ?? "";
  const linked =
    isDisputableTable(paramTable) && UUID_RE.test(paramId)
      ? { table: paramTable, id: paramId }
      : null;

  const [address, setAddress] = useState("");
  const [contested, setContested] = useState("");
  const [account, setAccount] = useState("");
  const [contact, setContact] = useState("");

  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<DisputeReceipt | null>(null);
  const [refusal, setRefusal] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setRefusal("");

    const record = linked ?? recordFromUrl(address);
    if (record === null) {
      setRefusal(
        "That address does not name a record on this site. Copy the address of the page you disagree with — it looks like /meetings/… — or write to the corrections address on the Methodology page.",
      );
      return;
    }

    setSending(true);
    try {
      const res = await fetch("/api/corrections/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_table: record.table,
          target_id: record.id,
          contested,
          account,
          contact,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setRefusal(body?.error ?? "That dispute could not be filed.");
        return;
      }

      setReceipt((await res.json()) as DisputeReceipt);
    } catch {
      setRefusal("That dispute could not be filed.");
    } finally {
      setSending(false);
    }
  }

  if (receipt !== null) {
    return (
      <div className="mx-auto max-w-3xl">
        <p className="kicker">Accountability</p>
        <h1 className="headline mt-1 text-3xl sm:text-4xl">Your dispute is filed</h1>
        <div className="rule-hi mt-4" role="presentation" />

        <div className="mt-8 border-l-2 border-accent bg-paper-sunk px-5 py-4">
          <p className="label-sm">Your reference</p>
          <p className="figure mt-1 text-2xl text-ink">{receipt.reference}</p>
        </div>

        <p className="mt-6 max-w-prose text-sm leading-relaxed text-ink">
          <strong className="font-semibold">Write it down now.</strong> Nothing
          is emailed to you — this project sends no mail — so this screen is the
          only copy of your reference.
        </p>
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-ink-soft">
          It is in the operator review queue, which is the same queue that
          decides what publishes on this site at all. A person reads it. It is
          not published, and it changes no record by itself. If it is upheld,
          the correction that follows appears on{" "}
          <Link className="cite" to="/corrections">
            the corrections log
          </Link>{" "}
          naming this reference.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <p className="kicker">Accountability</p>
      <h1 className="headline mt-1 text-3xl sm:text-4xl">Contest a record</h1>
      <div className="rule-hi mt-4" role="presentation" />

      <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-soft">
        If something on this site about you, or about anyone, is wrong, say so
        here. This is the route the{" "}
        <Link className="cite" to="/corrections">
          corrections policy
        </Link>{" "}
        describes.
      </p>

      <ul className="mt-6 max-w-prose border-y border-rule">
        {[
          "It goes to a person. It enters the operator review queue and is read there.",
          "It is never published. What you write is a private communication to this project.",
          "It changes no record by itself. Upholding it is a decision to look again, and any correction that follows is a separate act with its own stated reason.",
          "Nothing is emailed to you. You get a reference on this screen — keep it.",
          "Three things are asked for and nothing else about you is stored. No identity documents.",
        ].map((line) => (
          <li
            key={line}
            className="border-t border-rule py-3 text-sm leading-relaxed text-ink-soft first:border-t-0"
          >
            {line}
          </li>
        ))}
      </ul>

      <form onSubmit={handleSubmit} className="mt-10 space-y-6">
        {linked === null ? (
          <div>
            <label htmlFor="dispute-address" className="label-sm">
              The address of the page you disagree with
            </label>
            <input
              id="dispute-address"
              required
              value={address}
              placeholder="https://commissionwatch.bmux.sh/meetings/…"
              onChange={(event) => setAddress(event.target.value)}
              className={`${fieldClass} ${focusRing}`}
            />
            <p className="mt-1.5 text-xs text-muted">
              Copy it from your browser&rsquo;s address bar.
            </p>
          </div>
        ) : (
          <p className="border-l-2 border-rule bg-paper-sunk px-4 py-3 text-sm text-ink-soft">
            You are contesting {TABLE_LABEL[linked.table]} on this site.
          </p>
        )}

        <div>
          <label htmlFor="dispute-contested" className="label-sm">
            What is wrong
          </label>
          <input
            id="dispute-contested"
            required
            maxLength={LIMITS.contested}
            value={contested}
            onChange={(event) => setContested(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
          <p className="mt-1.5 text-xs text-muted">
            One sentence. Which part of the record you are contesting.
          </p>
        </div>

        <div>
          <label htmlFor="dispute-account" className="label-sm">
            Your account of it
          </label>
          <textarea
            id="dispute-account"
            required
            rows={8}
            maxLength={LIMITS.account}
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
          <p className="mt-1.5 text-xs text-muted">
            What the record should say, and — if you have one — the document that
            shows it. A document settles this faster than anything else.
          </p>
        </div>

        <div>
          <label htmlFor="dispute-contact" className="label-sm">
            How to reach you
          </label>
          <input
            id="dispute-contact"
            required
            maxLength={LIMITS.contact}
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
          <p className="mt-1.5 text-xs text-muted">
            An email address or a phone number. It is not verified and nothing is
            sent to it automatically.
          </p>
        </div>

        <button type="submit" disabled={sending} className={`${buttonClass} ${focusRing}`}>
          {sending ? "Filing…" : "File this dispute"}
        </button>
      </form>

      {refusal && (
        <p
          role="alert"
          className="mt-8 max-w-prose border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm leading-relaxed text-ink-soft"
        >
          {refusal}
        </p>
      )}
    </div>
  );
}

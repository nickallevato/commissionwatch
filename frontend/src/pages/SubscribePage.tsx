import { useState, type FormEvent } from "react";
import { useJurisdictions } from "../hooks/useJurisdictions";

/**
 * `/subscribe` — public self-serve alerts.
 *
 * Rebuilt from the archive's SubscriptionsPage into the deployed design
 * system. Two things changed beyond the visual treatment:
 *
 * - It talks to `/api/alerts`, the unified surface, where a subscription is a
 *   destination plus a filter plus a cadence rather than an email column and
 *   a `digest_only` boolean standing in for one.
 * - It never reads a stored destination back to populate the form. The archive
 *   did; under W7's masking rule that is neither possible nor permitted.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const fieldClass =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink hover:border-ink";

interface CadenceOption {
  readonly value: "immediate" | "daily" | "weekly";
  readonly label: string;
  readonly detail: string;
}

const CADENCES: readonly CadenceOption[] = [
  { value: "immediate", label: "As it happens", detail: "One message per finding." },
  { value: "daily", label: "Daily digest", detail: "One message a day, if there is anything." },
  { value: "weekly", label: "Weekly digest", detail: "One message a week, if there is anything." },
];

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

export function SubscribePage() {
  const { data: jurisdictions, isLoading } = useJurisdictions();
  const [destination, setDestination] = useState("");
  const [jurisdictionId, setJurisdictionId] = useState("");
  const [cadence, setCadence] = useState<CadenceOption["value"]>("daily");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setStatus({ kind: "submitting" });

    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_type: "email",
          destination,
          jurisdiction_id: jurisdictionId || null,
          cadence,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setStatus({
          kind: "error",
          message: body?.error ?? "That subscription could not be created.",
        });
        return;
      }

      setStatus({ kind: "sent" });
    } catch {
      setStatus({ kind: "error", message: "The request could not be sent. Try again." });
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <p className="kicker">Alerts</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">Follow the record</h1>
      <div className="rule-hi mt-4" role="presentation" />

      <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-soft">
        Get told when something is flagged in a jurisdiction you care about. Every
        alert links back to the meeting record it came from, and nothing is sent
        until you confirm the address — one message, one link, no account.
      </p>

      {status.kind === "sent" ? (
        <div className="mt-8 border-l-2 border-accent bg-paper-sunk px-4 py-4" role="status">
          <p className="text-sm text-ink">
            Check that address for a confirmation link. Nothing is sent to it until
            you follow that link.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-8 space-y-6">
          {status.kind === "error" && (
            <p role="alert" className="border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm text-ink-soft">
              {status.message}
            </p>
          )}

          <div>
            <label htmlFor="destination" className="label-sm">
              Email
            </label>
            <input
              id="destination"
              name="destination"
              type="email"
              required
              autoComplete="email"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              className={`${fieldClass} ${focusRing}`}
            />
          </div>

          <div>
            <label htmlFor="jurisdiction" className="label-sm">
              Jurisdiction
            </label>
            <select
              id="jurisdiction"
              name="jurisdiction"
              value={jurisdictionId}
              onChange={(event) => setJurisdictionId(event.target.value)}
              className={`${fieldClass} ${focusRing}`}
            >
              <option value="">Every jurisdiction</option>
              {(jurisdictions ?? []).map((jurisdiction) => (
                <option key={jurisdiction.id} value={jurisdiction.id}>
                  {jurisdiction.name}
                </option>
              ))}
            </select>
            {isLoading && <p className="mt-1 text-xs text-muted">Loading jurisdictions…</p>}
          </div>

          <fieldset>
            <legend className="label-sm">How often</legend>
            <ul className="mt-2 divide-y divide-rule border-y border-rule">
              {CADENCES.map((option) => (
                <li key={option.value}>
                  <label className="flex cursor-pointer items-baseline gap-3 py-3">
                    <input
                      type="radio"
                      name="cadence"
                      value={option.value}
                      checked={cadence === option.value}
                      onChange={() => setCadence(option.value)}
                      className={focusRing}
                    />
                    <span>
                      <span className="block text-sm text-ink">{option.label}</span>
                      <span className="block text-xs text-muted">{option.detail}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <button
            type="submit"
            disabled={status.kind === "submitting"}
            className={`w-full border border-ink bg-ink px-4 py-2.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50 sm:w-auto ${focusRing}`}
          >
            {status.kind === "submitting" ? "Subscribing…" : "Subscribe"}
          </button>
        </form>
      )}

      <p className="mt-10 max-w-prose text-xs leading-relaxed text-muted">
        Your address is stored encrypted and is never shown back to you or to
        anyone else, including the operator&rsquo;s own console. Every message
        carries an unsubscribe link that works without signing in.
      </p>
    </div>
  );
}

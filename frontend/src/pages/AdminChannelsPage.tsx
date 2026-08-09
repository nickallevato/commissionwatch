import { useCallback, useEffect, useState, type FormEvent } from "react";

/**
 * `/admin/channels` — the operator's delivery destinations.
 *
 * **The form never reads a credential back to populate itself.** The archive's
 * SubscriptionsPage did exactly that; under W7's masking rule it is neither
 * possible nor permitted, because the API does not return a stored webhook URL
 * to anyone. The list shows a masked value and the form accepts a replacement.
 *
 * Only `owner_kind = 'operator'` channels appear here. A reader's subscription
 * is their personal data and is reachable only by their own token.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const fieldClass =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink hover:border-ink";

interface Channel {
  id: string;
  channel_type: string;
  name: string;
  enabled: boolean;
  config_masked: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

export function AdminChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [formError, setFormError] = useState("");
  const [name, setName] = useState("");
  const [channelType, setChannelType] = useState("discord");
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      const res = await fetch("/api/admin/channels", { credentials: "same-origin" });
      if (!res.ok) {
        setStatus({ kind: "error", message: "Channels could not be loaded." });
        return;
      }
      const body = (await res.json()) as { data: Channel[] };
      setChannels(body.data);
      setStatus({ kind: "idle" });
    } catch {
      setStatus({ kind: "error", message: "Channels could not be loaded." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    setSubmitting(true);

    const config =
      channelType === "email"
        ? { email: secret }
        : channelType === "sms"
          ? { phone: secret }
          : { webhook_url: secret };

    try {
      const res = await fetch("/api/admin/channels", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_type: channelType, name, config }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(body?.error ?? "That channel could not be created.");
        return;
      }

      // Cleared immediately: a credential left in a form field is a credential
      // sitting in the DOM for as long as the tab is open.
      setSecret("");
      setName("");
      await load();
    } catch {
      setFormError("The request could not be sent.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <p className="kicker">Operator console</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">Delivery channels</h1>
      <div className="rule-hi mt-4" role="presentation" />

      <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-soft">
        Where this project sends what it finds. Stored credentials are encrypted
        and are never returned by the API — including to this page. To change
        one, enter the new value; there is nothing to edit in place.
      </p>

      {status.kind === "error" && (
        <p role="alert" className="mt-6 border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm text-ink-soft">
          {status.message}
        </p>
      )}

      <h2 className="mt-10 font-display text-xl font-semibold text-ink">Configured</h2>
      {status.kind === "loading" ? (
        <p className="mt-3 label-sm" role="status">
          Loading channels…
        </p>
      ) : channels.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No channels yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {channels.map((channel) => (
            <li key={channel.id} className="flex flex-wrap items-baseline justify-between gap-3 py-4">
              <span>
                <span className="block text-sm font-semibold text-ink">{channel.name}</span>
                <span className="block text-xs text-muted">
                  {channel.channel_type} · {channel.config_masked}
                </span>
              </span>
              <span className="label-sm">{channel.enabled ? "Enabled" : "Disabled"}</span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-12 font-display text-xl font-semibold text-ink">Add a channel</h2>
      <form onSubmit={handleSubmit} className="mt-4 max-w-lg space-y-5">
        {formError && (
          <p role="alert" className="border-l-2 border-accent bg-paper-sunk px-4 py-3 text-sm text-ink-soft">
            {formError}
          </p>
        )}

        <div>
          <label htmlFor="channel-name" className="label-sm">
            Name
          </label>
          <input
            id="channel-name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
        </div>

        <div>
          <label htmlFor="channel-type" className="label-sm">
            Type
          </label>
          <select
            id="channel-type"
            value={channelType}
            onChange={(event) => setChannelType(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          >
            <option value="discord">Discord</option>
            <option value="webhook">Webhook</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
        </div>

        <div>
          <label htmlFor="channel-secret" className="label-sm">
            {channelType === "email"
              ? "Address"
              : channelType === "sms"
                ? "Phone number (E.164)"
                : "Webhook URL"}
          </label>
          <input
            id="channel-secret"
            required
            autoComplete="off"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            className={`${fieldClass} ${focusRing}`}
          />
          <p className="mt-1 text-xs text-muted">
            Stored encrypted. It will not be shown back to you after this.
          </p>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className={`border border-ink bg-ink px-4 py-2.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50 ${focusRing}`}
        >
          {submitting ? "Adding…" : "Add channel"}
        </button>
      </form>
    </div>
  );
}

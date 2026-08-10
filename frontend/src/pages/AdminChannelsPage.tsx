import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ACTION,
  ACTION_PRIMARY,
  ACTION_QUIET,
  ACTION_ROW,
  ACTION_SMALL,
  FIELD,
  FlagBar,
  FOCUS_RING,
  SegmentedControl,
  SeverityStripe,
  SpendMeter,
  StatusPill,
  WorkTitle,
  type SegmentOption,
  type Severity,
} from "@/components/PressroomUI";

/**
 * `/admin/channels` — the operator's delivery destinations. Screen 05.
 *
 * A route is *send events of this type, at or above this severity, for this
 * jurisdiction, to this channel, at this cadence* — five facts, and the two
 * that are a choice from a short fixed list get a segmented control rather
 * than a `<select>`, because on this screen the whole point is seeing where
 * the threshold sits without opening anything.
 *
 * **The form never reads a credential back to populate itself.** The archive's
 * SubscriptionsPage did exactly that; under W7's masking rule it is neither
 * possible nor permitted, because the API does not return a stored webhook URL
 * to anyone. The list shows a masked value with a `Stored` tag and the form
 * accepts a replacement.
 *
 * Only `owner_kind = 'operator'` channels appear here. A reader's subscription
 * is their personal data and is reachable only by their own token.
 */

interface Channel {
  id: string;
  channel_type: string;
  name: string;
  enabled: boolean;
  config_masked: string;
}

/** `channel_routes`, as `GET /api/admin/channels/:id` returns them. */
interface ChannelRoute {
  id: string;
  channel_id: string;
  event_type: string;
  min_severity: string | null;
  jurisdiction_id: string | null;
  enabled: boolean;
  cadence?: string;
  daily_send_cap?: number | null;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

type LoadResult = { ok: true; channels: Channel[] } | { ok: false };

const SEVERITIES: readonly SegmentOption[] = [
  { value: "info", label: "info" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "critical", label: "critical" },
];

const CADENCES: readonly SegmentOption[] = [
  { value: "immediate", label: "immediate" },
  { value: "daily", label: "daily" },
  { value: "weekly", label: "weekly" },
];

/** SMS is amber on sight: it costs money per message and nothing else here does. */
function channelSeverity(channel: Channel): Severity {
  if (!channel.enabled) return "idle";
  if (channel.channel_type === "sms") return "warn";
  return "ok";
}

export function AdminChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [formError, setFormError] = useState("");
  const [name, setName] = useState("");
  const [channelType, setChannelType] = useState("discord");
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // The route editor. Nothing is fetched until an operator opens a channel,
  // so the listing costs one request whatever the console is doing.
  const [editing, setEditing] = useState<Channel | null>(null);
  const [routes, setRoutes] = useState<ChannelRoute[]>([]);
  const [eventType, setEventType] = useState("anomaly.flagged");
  const [minSeverity, setMinSeverity] = useState("high");
  const [cadence, setCadence] = useState("immediate");
  const [routeError, setRouteError] = useState("");
  const [routeNotice, setRouteNotice] = useState("");
  const [savingRoute, setSavingRoute] = useState(false);

  // Fetching and applying are separated so the effect below can await the
  // request and touch state only in the continuation. An effect body that calls
  // setState synchronously causes a cascading render, and — worse here — a fast
  // unmount would set state on a component that is already gone.
  const fetchChannels = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch("/api/admin/channels", { credentials: "same-origin" });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as { data: Channel[] };
      return { ok: true, channels: body.data };
    } catch {
      return { ok: false };
    }
  }, []);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setChannels(result.channels);
      setStatus({ kind: "idle" });
    } else {
      setStatus({ kind: "error", message: "Channels could not be loaded." });
    }
  }, []);

  /** Reload after a write. Showing the spinner here is a response to a click. */
  const load = useCallback(async () => {
    setStatus({ kind: "loading" });
    applyResult(await fetchChannels());
  }, [applyResult, fetchChannels]);

  useEffect(() => {
    // `status` already starts as loading, so nothing needs setting on the way in.
    let ignore = false;
    void (async () => {
      const result = await fetchChannels();
      if (ignore) return;
      applyResult(result);
    })();
    return () => {
      ignore = true;
    };
  }, [applyResult, fetchChannels]);

  async function openChannel(channel: Channel) {
    setEditing(channel);
    setRoutes([]);
    setRouteError("");
    setRouteNotice("");
    try {
      const res = await fetch(`/api/admin/channels/${channel.id}`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        setRouteError("That channel's routes could not be read.");
        return;
      }
      // `channel` here carries the masked config and never the credential.
      const body = (await res.json()) as { routes: ChannelRoute[] };
      setRoutes(body.routes);
    } catch {
      setRouteError("That channel's routes could not be read.");
    }
  }

  async function handleSaveRoute(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setSavingRoute(true);
    setRouteError("");
    setRouteNotice("");
    try {
      const res = await fetch(`/api/admin/channels/${editing.id}/routes`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: eventType,
          min_severity: minSeverity,
          cadence,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setRouteError(body?.error ?? "That route could not be saved.");
        return;
      }
      setRouteNotice(
        `Routing ${eventType} at ${minSeverity} or above to ${editing.name}, ${cadence}.`,
      );
      await openChannel(editing);
    } catch {
      setRouteError("The route could not be sent.");
    } finally {
      setSavingRoute(false);
    }
  }

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

  const smsCap =
    routes.find((route) => typeof route.daily_send_cap === "number")?.daily_send_cap ?? null;

  return (
    <>
      <WorkTitle
        title="Channels"
        stamp={
          status.kind === "loading"
            ? "loading…"
            : `${channels.length} channel${channels.length === 1 ? "" : "s"}${
                editing ? ` · ${routes.length} route${routes.length === 1 ? "" : "s"} on ${editing.name}` : ""
              }`
        }
      />

      <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
        Where this project sends what it finds. Stored credentials are encrypted
        and are never returned by the API — including to this page. To change
        one, enter the new value; there is nothing to edit in place.
      </p>

      {status.kind === "error" && (
        <p role="alert" className="border-l-2 border-accent bg-accent-50 px-4 py-3 text-sm text-ink-soft">
          {status.message}
        </p>
      )}

      {status.kind === "loading" ? (
        <p className="label-sm" role="status">
          Loading channels…
        </p>
      ) : channels.length === 0 ? (
        <p className="text-sm text-muted">No channels yet.</p>
      ) : (
        <div className="overflow-x-auto border border-rule">
          <table className="w-full min-w-[46rem] border-collapse text-left text-[13px]">
            <caption className="sr-only">
              Operator delivery channels, their type, masked configuration and state
            </caption>
            <thead>
              <tr>
                <th scope="col" className="label-sm border-b border-rule px-3 py-2">Channel</th>
                <th scope="col" className="label-sm border-b border-rule px-3 py-2">Type</th>
                <th scope="col" className="label-sm border-b border-rule px-3 py-2">Config</th>
                <th scope="col" className="label-sm border-b border-rule px-3 py-2">State</th>
                <th scope="col" className="label-sm border-b border-rule px-3 py-2">Last delivery</th>
                <th scope="col" className="label-sm border-b border-rule px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr
                  key={channel.id}
                  className={`border-b border-rule last:border-b-0 ${
                    channel.enabled ? "" : "bg-paper-sunk"
                  }`}
                >
                  <th scope="row" className="px-3 py-2.5 text-left font-normal">
                    <span className="flex items-stretch gap-2">
                      <SeverityStripe severity={channelSeverity(channel)} />
                      <span className="block">
                        <span className="block font-semibold text-ink">{channel.name}</span>
                        <span className="block font-mono text-[11.5px] text-muted">
                          owner: operator
                        </span>
                      </span>
                    </span>
                  </th>
                  <td className="px-3 py-2.5">
                    <StatusPill tone={channel.channel_type === "sms" ? "warn" : "plain"}>
                      {channel.channel_type}
                    </StatusPill>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11.5px] text-muted">
                    {channel.config_masked}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusPill tone={channel.enabled ? "ok" : "idle"}>
                      {channel.enabled ? "Enabled" : "Disabled"}
                    </StatusPill>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[12px] text-muted">Not recorded</td>
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => void openChannel(channel)}
                      className={`${ACTION_QUIET} ${ACTION_SMALL} ${FOCUS_RING}`}
                      aria-label={`Edit routing: ${channel.name}`}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="max-w-prose text-[11.5px] leading-relaxed text-muted">
        No delivery counter is kept yet, so &ldquo;last delivery&rdquo; reads
        Not recorded on every row rather than showing a time nothing measured.
      </p>

      {editing && (
        <div className="grid grid-cols-1 border border-rule lg:grid-cols-[1.35fr_1fr]">
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <span className="label-sm">Edit route — {editing.name}</span>

            {routeError && (
              <p role="alert" className="border-l-2 border-accent bg-accent-50 px-3 py-2 text-sm text-ink-soft">
                {routeError}
              </p>
            )}
            {routeNotice && (
              <p role="status" className="border-l-2 border-ink bg-paper-sunk px-3 py-2 text-sm text-ink-soft">
                {routeNotice}
              </p>
            )}

            {routes.length > 0 && (
              <ul className="divide-y divide-rule border-y border-rule text-[12.5px]">
                {routes.map((route) => (
                  <li key={route.id} className="flex flex-wrap items-baseline gap-2 py-2">
                    <span className="font-mono text-ink">{route.event_type}</span>
                    <StatusPill tone="plain">
                      {route.min_severity ?? "any severity"}
                    </StatusPill>
                    <StatusPill tone="plain">{route.cadence ?? "immediate"}</StatusPill>
                    {!route.enabled && <StatusPill tone="idle">Disabled</StatusPill>}
                  </li>
                ))}
              </ul>
            )}

            <form onSubmit={handleSaveRoute} className="flex flex-col gap-3">
              <div className="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2.5">
                <label htmlFor="route-event" className="label-sm">
                  Event
                </label>
                <input
                  id="route-event"
                  required
                  value={eventType}
                  onChange={(event) => setEventType(event.target.value)}
                  className={`${FIELD} mt-0 ${FOCUS_RING}`}
                />

                <span className="label-sm">Min severity</span>
                <SegmentedControl
                  name="min-severity"
                  label="Minimum severity for this route"
                  options={SEVERITIES}
                  value={minSeverity}
                  onChange={setMinSeverity}
                />

                <span className="label-sm">Cadence</span>
                <SegmentedControl
                  name="cadence"
                  label="Cadence for this route"
                  options={CADENCES}
                  value={cadence}
                  onChange={setCadence}
                />
              </div>

              <div className={ACTION_ROW}>
                <button
                  type="submit"
                  disabled={savingRoute}
                  className={`${ACTION_PRIMARY} ${FOCUS_RING}`}
                >
                  {savingRoute ? "Saving…" : "Save route"}
                </button>
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  title="No test-event endpoint exists yet."
                  className={ACTION}
                >
                  Send test event
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className={`${ACTION_QUIET} ${FOCUS_RING}`}
                >
                  Close
                </button>
              </div>
            </form>
          </div>

          <div className="flex flex-col gap-3 border-t border-rule bg-paper-sunk px-4 py-3.5 lg:border-l lg:border-t-0">
            <span className="label-sm">Stored configuration</span>
            <div className="flex items-center justify-between gap-2 border border-rule bg-paper px-3 py-1.5 font-mono text-[12.5px] text-muted">
              <span className="min-w-0 truncate">{editing.config_masked}</span>
              <b className="border border-current px-1.5 py-px font-sans text-[9.5px] font-bold uppercase tracking-label text-pass">
                Stored
              </b>
            </div>
            <p className="max-w-prose text-[11.5px] leading-relaxed text-muted">
              A webhook URL is a credential. It is encrypted at rest and{" "}
              <b className="font-semibold text-ink">never returned by the API</b> — this
              field shows host and last four only. Saving replaces it; there is no
              way to read the current value back, by design.
            </p>

            <span className="label-sm mt-1">SMS spend, this month</span>
            <SpendMeter label="SMS messages sent against the daily cap" value={0} max={smsCap} unit="msgs" />
            <p className="max-w-prose text-[11.5px] leading-relaxed text-muted">
              At the cap, SMS routes degrade to the daily digest rather than
              dropping. Silence is never the failure mode. No send counter is kept
              yet, so the figure above is the console&rsquo;s own count of deliveries
              it has observed — zero — and not a reading from the carrier.
            </p>
          </div>
        </div>
      )}

      <FlagBar label="SSRF guard" tone="idle">
        Generic webhook hosts are resolved before first use and rejected if they
        land on private, loopback or link-local ranges. Discord channels are
        additionally restricted to <span className="font-mono">discord.com</span> and{" "}
        <span className="font-mono">discordapp.com</span> over HTTPS.
      </FlagBar>

      <div className="flex flex-col gap-3 border border-rule px-4 py-3.5">
        <span className="label-sm">Add a channel</span>
        <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
          {formError && (
            <p role="alert" className="border-l-2 border-accent bg-accent-50 px-4 py-3 text-sm text-ink-soft">
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
              className={`${FIELD} ${FOCUS_RING}`}
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
              className={`${FIELD} ${FOCUS_RING}`}
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
              className={`${FIELD} ${FOCUS_RING}`}
            />
            <p className="mt-1 text-xs text-muted">
              Stored encrypted. It will not be shown back to you after this.
            </p>
          </div>

          <button type="submit" disabled={submitting} className={`${ACTION_PRIMARY} ${FOCUS_RING}`}>
            {submitting ? "Adding…" : "Add channel"}
          </button>
        </form>
      </div>
    </>
  );
}

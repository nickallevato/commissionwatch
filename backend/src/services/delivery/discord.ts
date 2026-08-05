import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Discord webhook transport.
 *
 * The three things that separate a demo integration from a production one live
 * here: the documented size limits (enforced by visible truncation, never a
 * silent drop), the 5-requests-per-2-seconds bucket, and honouring `retry_after`
 * on a 429 instead of hammering. Plus the SSRF allowlist, because the webhook
 * URL is operator-supplied and every POST is a request the server makes.
 */

// ── Documented Discord limits ──────────────────────────────────────────────
export const DISCORD_LIMITS = {
  content: 2000,
  embedTitle: 256,
  embedDescription: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
  fieldsPerEmbed: 25,
  embedsPerMessage: 10,
  totalEmbedChars: 6000,
} as const;

/** Requests allowed per webhook per RATE_WINDOW_MS. */
export const RATE_LIMIT_REQUESTS = 5;
export const RATE_WINDOW_MS = 2000;

/** Appended wherever text was cut, so truncation is always visible. */
export const TRUNCATION_MARKER = "…";

/** Smallest description worth keeping when squeezing into the 6000 budget. */
const MIN_DESCRIPTION_CHARS = 80;

// ── Types ──────────────────────────────────────────────────────────────────

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string };
  author?: { name: string };
  fields?: DiscordEmbedField[];
}

export interface DiscordMessage {
  content?: string;
  username?: string;
  embeds?: DiscordEmbed[];
}

export interface TruncationReport {
  truncated: boolean;
  droppedEmbeds: number;
  droppedFields: number;
  notes: string[];
}

export interface DiscordPostResult {
  status: number;
  attempts: number;
  /** One entry per 429, in ms, in the order they were honoured. */
  rateLimitWaitsMs: number[];
  truncation: TruncationReport;
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>;

export type HostLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface DiscordClientOptions {
  fetchImpl?: FetchLike;
  /** Injected for tests so rate-limit and retry waits do not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Total attempts per message, including the first. */
  maxAttempts?: number;
  /** Refuse to sit on a retry_after longer than this. */
  maxRetryAfterMs?: number;
  timeoutMs?: number;
}

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

export class DiscordPostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DiscordPostError";
  }
}

// ── URL validation (SSRF) ──────────────────────────────────────────────────

const ALLOWED_DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);
const DISCORD_WEBHOOK_PATH = /^\/api\/(v\d{1,2}\/)?webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/;

function parseAbsoluteHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError("Webhook URL is not a valid absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new WebhookUrlError(`Webhook URL must use https (got "${url.protocol.replace(":", "")}")`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebhookUrlError("Webhook URL must not embed credentials");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new WebhookUrlError(`Webhook URL must use the default https port (got ${url.port})`);
  }
  return url;
}

function normaliseHost(url: URL): string {
  // Strip the FQDN trailing dot and any brackets around an IPv6 literal.
  return url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

/**
 * Discord channels only ever talk to Discord. Exact-host allowlist — no
 * suffix matching, so `discord.com.evil.test` is rejected.
 *
 * Errors never include the URL itself: the token is the credential.
 */
export function assertDiscordWebhookUrl(raw: string): URL {
  const url = parseAbsoluteHttpsUrl(raw);
  const host = normaliseHost(url);

  if (!ALLOWED_DISCORD_HOSTS.has(host)) {
    throw new WebhookUrlError(
      `Discord webhook host "${host}" is not allowed; only ${[...ALLOWED_DISCORD_HOSTS].join(" and ")} are accepted`,
    );
  }
  if (!DISCORD_WEBHOOK_PATH.test(url.pathname)) {
    throw new WebhookUrlError("Discord webhook URL path is not a /api/webhooks/<id>/<token> path");
  }
  return url;
}

/** True when the literal address is loopback, private, link-local, or otherwise not routable. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  // Not an IP literal at all — caller should have resolved it first.
  return true;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) return true; // IETF protocol / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];

  // IPv4-mapped / IPv4-compatible forms delegate to the v4 rules.
  const mapped = lower.match(/^::(ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIpv4(mapped[2]);

  if (lower === "::" || lower === "::1") return true; // unspecified, loopback
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith("ff")) return true; // multicast
  if (lower.startsWith("64:ff9b")) return true; // NAT64
  if (lower.startsWith("2001:db8")) return true; // documentation
  return false;
}

/**
 * Generic `webhook` channels may point anywhere, so the host is resolved and
 * every returned address is checked against the blocked ranges.
 */
export async function assertPublicWebhookUrl(
  raw: string,
  options: { lookup?: HostLookup } = {},
): Promise<URL> {
  const url = parseAbsoluteHttpsUrl(raw);
  const host = normaliseHost(url);

  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") {
    throw new WebhookUrlError(`Webhook host "${host}" resolves to the loopback interface and is not allowed`);
  }

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new WebhookUrlError(`Webhook host "${host}" is in a blocked (private, loopback, or link-local) range`);
    }
    return url;
  }

  const lookup: HostLookup =
    options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host);
  } catch {
    throw new WebhookUrlError(`Webhook host "${host}" could not be resolved`);
  }

  if (records.length === 0) {
    throw new WebhookUrlError(`Webhook host "${host}" resolved to no addresses`);
  }
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new WebhookUrlError(
        `Webhook host "${host}" resolves to ${record.address}, which is in a blocked (private, loopback, or link-local) range`,
      );
    }
  }
  return url;
}

// ── Size limits / truncation ───────────────────────────────────────────────

function emptyReport(): TruncationReport {
  return { truncated: false, droppedEmbeds: 0, droppedFields: 0, notes: [] };
}

function clampText(value: string, max: number, label: string, report: TruncationReport): string {
  // Discord counts UTF-16 code units, which is what String#length gives us.
  if (value.length <= max) return value;
  report.truncated = true;
  report.notes.push(`${label} truncated from ${value.length} to ${max} characters`);
  const keep = Math.max(0, max - TRUNCATION_MARKER.length);
  return value.slice(0, keep) + TRUNCATION_MARKER;
}

function embedCost(embed: DiscordEmbed): number {
  let cost = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
  cost += embed.footer?.text.length ?? 0;
  cost += embed.author?.name.length ?? 0;
  for (const field of embed.fields ?? []) {
    cost += field.name.length + field.value.length;
  }
  return cost;
}

function clampEmbed(embed: DiscordEmbed, index: number, report: TruncationReport): DiscordEmbed {
  const clamped: DiscordEmbed = { ...embed };

  if (clamped.title !== undefined) {
    clamped.title = clampText(clamped.title, DISCORD_LIMITS.embedTitle, `embed ${index} title`, report);
  }
  if (clamped.description !== undefined) {
    clamped.description = clampText(
      clamped.description,
      DISCORD_LIMITS.embedDescription,
      `embed ${index} description`,
      report,
    );
  }
  if (clamped.footer !== undefined) {
    clamped.footer = {
      text: clampText(clamped.footer.text, DISCORD_LIMITS.footerText, `embed ${index} footer`, report),
    };
  }
  if (clamped.author !== undefined) {
    clamped.author = {
      name: clampText(clamped.author.name, DISCORD_LIMITS.authorName, `embed ${index} author`, report),
    };
  }

  if (clamped.fields !== undefined) {
    let fields = clamped.fields;
    if (fields.length > DISCORD_LIMITS.fieldsPerEmbed) {
      const dropped = fields.length - (DISCORD_LIMITS.fieldsPerEmbed - 1);
      report.truncated = true;
      report.droppedFields += dropped;
      report.notes.push(`embed ${index}: ${dropped} of ${fields.length} fields omitted`);
      fields = [
        ...fields.slice(0, DISCORD_LIMITS.fieldsPerEmbed - 1),
        { name: TRUNCATION_MARKER, value: `${dropped} more field${dropped === 1 ? "" : "s"} omitted` },
      ];
    }
    clamped.fields = fields.map((field, fieldIndex) => ({
      ...field,
      name: clampText(field.name, DISCORD_LIMITS.fieldName, `embed ${index} field ${fieldIndex} name`, report),
      value: clampText(field.value, DISCORD_LIMITS.fieldValue, `embed ${index} field ${fieldIndex} value`, report),
    }));
  }

  return clamped;
}

/**
 * Bring a message inside every Discord limit. Anything cut is marked with
 * {@link TRUNCATION_MARKER} and recorded in the returned report — the caller
 * can log it, and the reader can see it.
 */
export function sanitizeMessage(message: DiscordMessage): {
  message: DiscordMessage;
  report: TruncationReport;
} {
  const report = emptyReport();
  const inputEmbeds = message.embeds ?? [];

  let embeds = inputEmbeds.map((embed, index) => clampEmbed(embed, index, report));

  if (embeds.length > DISCORD_LIMITS.embedsPerMessage) {
    const dropped = embeds.length - DISCORD_LIMITS.embedsPerMessage;
    report.truncated = true;
    report.droppedEmbeds += dropped;
    report.notes.push(
      `${dropped} of ${embeds.length} embeds omitted (Discord allows ${DISCORD_LIMITS.embedsPerMessage} per message)`,
    );
    embeds = embeds.slice(0, DISCORD_LIMITS.embedsPerMessage);
  }

  // 6000 chars across all embeds. Shrink descriptions first, then drop whole
  // embeds from the tail rather than sending a payload Discord will reject.
  const kept: DiscordEmbed[] = [];
  let budget = DISCORD_LIMITS.totalEmbedChars;
  let budgetDropped = 0;

  for (let i = 0; i < embeds.length; i++) {
    const embed = embeds[i];
    const cost = embedCost(embed);
    if (cost <= budget) {
      kept.push(embed);
      budget -= cost;
      continue;
    }

    const withoutDescription = cost - (embed.description?.length ?? 0);
    const room = budget - withoutDescription;
    if (embed.description !== undefined && room >= MIN_DESCRIPTION_CHARS) {
      const shrunk = clampText(embed.description, room, `embed ${i} description (message budget)`, report);
      kept.push({ ...embed, description: shrunk });
      budget -= withoutDescription + shrunk.length;
      continue;
    }

    budgetDropped = embeds.length - i;
    break;
  }

  if (budgetDropped > 0) {
    report.truncated = true;
    report.droppedEmbeds += budgetDropped;
    report.notes.push(
      `${budgetDropped} embed${budgetDropped === 1 ? "" : "s"} omitted to stay under the ${DISCORD_LIMITS.totalEmbedChars}-character message limit`,
    );
  }

  let content = message.content;
  if (report.droppedEmbeds > 0) {
    const suffix = `${TRUNCATION_MARKER} ${report.droppedEmbeds} more not shown`;
    content = content ? `${content}\n${suffix}` : suffix;
  }
  if (content !== undefined) {
    content = clampText(content, DISCORD_LIMITS.content, "content", report);
  }

  const sanitized: DiscordMessage = {};
  if (content !== undefined && content !== "") sanitized.content = content;
  if (message.username !== undefined) sanitized.username = message.username;
  if (kept.length > 0) sanitized.embeds = kept;

  return { message: sanitized, report };
}

// ── Client ─────────────────────────────────────────────────────────────────

const defaultFetch: FetchLike = (url, init) => fetch(url, init);
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** Seconds → ms, tolerating both `0.75` and `"0.75"`. */
function parseRetryAfterSeconds(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds * 1000);
}

function readRetryAfterMs(body: string, headers: { get(name: string): string | null }): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && "retry_after" in parsed) {
      const fromBody = parseRetryAfterSeconds((parsed as { retry_after: unknown }).retry_after);
      if (fromBody !== null) return fromBody;
    }
  } catch {
    // Body was not JSON; fall through to the headers.
  }
  const fromHeader =
    parseRetryAfterSeconds(headers.get("retry-after")) ??
    parseRetryAfterSeconds(headers.get("x-ratelimit-reset-after"));
  return fromHeader;
}

export class DiscordClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly maxRetryAfterMs: number;
  private readonly timeoutMs: number;
  /** Send timestamps per webhook, for the 5-per-2s bucket. */
  private readonly buckets = new Map<string, number[]>();

  constructor(options: DiscordClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? 4;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Validate, sanitize, rate-limit, and POST. Retries only what is worth
   * retrying: 429 (for exactly as long as Discord asked) and 5xx/network.
   */
  async post(webhookUrl: string, message: DiscordMessage): Promise<DiscordPostResult> {
    const url = assertDiscordWebhookUrl(webhookUrl);
    const { message: payload, report } = sanitizeMessage(message);

    if (payload.embeds === undefined && (payload.content === undefined || payload.content === "")) {
      throw new DiscordPostError("Refusing to post an empty Discord message", 0, false);
    }

    const bucketKey = `${url.origin}${url.pathname}`;
    const body = JSON.stringify(payload);
    const rateLimitWaitsMs: number[] = [];
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < this.maxAttempts) {
      await this.acquireSlot(bucketKey);
      attempts++;

      let response: FetchResponseLike;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = new DiscordPostError(
          `Discord webhook request failed: ${err instanceof Error ? err.message : "unknown transport error"}`,
          0,
          true,
        );
        if (attempts >= this.maxAttempts) break;
        await this.sleep(backoffMs(attempts));
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        return { status: response.status, attempts, rateLimitWaitsMs, truncation: report };
      }

      const text = await response.text().catch(() => "");

      if (response.status === 429) {
        // Honour the value Discord gave us. Never a blind retry.
        const waitMs = readRetryAfterMs(text, response.headers) ?? RATE_WINDOW_MS;
        if (waitMs > this.maxRetryAfterMs) {
          throw new DiscordPostError(
            `Discord asked for a ${waitMs}ms retry_after, above the ${this.maxRetryAfterMs}ms ceiling`,
            429,
            true,
          );
        }
        rateLimitWaitsMs.push(waitMs);
        lastError = new DiscordPostError(`Discord rate limited the webhook (retry_after ${waitMs}ms)`, 429, true);
        if (attempts >= this.maxAttempts) break;
        // A 429 already consumed the local bucket slot; wait it out, then
        // clear the bucket so we start the next window clean.
        await this.sleep(waitMs);
        this.buckets.delete(bucketKey);
        continue;
      }

      if (response.status >= 500) {
        lastError = new DiscordPostError(`Discord returned ${response.status}`, response.status, true);
        if (attempts >= this.maxAttempts) break;
        await this.sleep(backoffMs(attempts));
        continue;
      }

      // 4xx other than 429: bad payload, deleted webhook, revoked token.
      // Retrying cannot help and would burn the rate limit.
      throw new DiscordPostError(
        `Discord rejected the webhook post with ${response.status}: ${text.slice(0, 200)}`,
        response.status,
        false,
      );
    }

    throw lastError ?? new DiscordPostError("Discord webhook post failed", 0, true);
  }

  /**
   * 5 requests per 2 seconds per webhook, enforced before the request goes out
   * so we do not rely on 429s to discover our own limit.
   */
  private async acquireSlot(key: string): Promise<void> {
    for (;;) {
      const now = this.now();
      const recent = (this.buckets.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);

      if (recent.length < RATE_LIMIT_REQUESTS) {
        recent.push(now);
        this.buckets.set(key, recent);
        return;
      }

      this.buckets.set(key, recent);
      const waitMs = Math.max(1, RATE_WINDOW_MS - (now - recent[0]));
      await this.sleep(waitMs);
    }
  }
}

/** Exponential backoff with a ceiling, used for 5xx and transport errors. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

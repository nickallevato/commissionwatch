import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Must be set before any delivery code resolves the key.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import db from "../src/config/database";
import {
  ChannelCryptoError,
  decryptConfig,
  decryptSecret,
  encryptConfig,
  encryptSecret,
  resolveChannelKey,
  secretsMatch,
} from "../src/services/delivery/crypto";
import {
  assertDiscordWebhookUrl,
  assertPublicWebhookUrl,
  backoffMs,
  DiscordClient,
  DiscordPostError,
  DISCORD_LIMITS,
  isBlockedAddress,
  sanitizeMessage,
  TRUNCATION_MARKER,
  WebhookUrlError,
  type DiscordEmbed,
  type DiscordMessage,
  type FetchLike,
  type FetchResponseLike,
  type HostLookup,
} from "../src/services/delivery/discord";
import {
  createChannel,
  createRoute,
  listChannels,
  loadChannelSecret,
  maskWebhookUrl,
  resolveRoutes,
  severityRank,
} from "../src/services/delivery/channels";
import {
  buildBatchMessage,
  defaultDedupeKey,
  DeliveryDispatcher,
  type StoredPayload,
} from "../src/services/delivery/dispatcher";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const GALLATIN_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const NAME_PREFIX = "dtest-";
const WEBHOOK_TOKEN = "Xk3n_TOKEN-value.0123456789abcdefghijklmnop";
const WEBHOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;

const ALT_KEY = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// ── Test doubles ───────────────────────────────────────────────────────────

interface StubResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

interface RecordedCall {
  url: string;
  message: DiscordMessage;
}

function makeResponse(stub: StubResponse): FetchResponseLike {
  const headers = stub.headers ?? {};
  return {
    status: stub.status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => stub.body ?? "",
  };
}

/** Returns a FetchLike that walks `responses`, repeating the last one. */
function stubFetch(responses: StubResponse[], calls: RecordedCall[]): FetchLike {
  let index = 0;
  return async (url, init) => {
    calls.push({ url, message: JSON.parse(init.body) as DiscordMessage });
    const stub = responses[Math.min(index, responses.length - 1)];
    index++;
    return makeResponse(stub);
  };
}

function lookupTo(...addresses: string[]): HostLookup {
  return async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

function embedCost(embed: DiscordEmbed): number {
  let cost = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
  cost += embed.footer?.text.length ?? 0;
  for (const field of embed.fields ?? []) cost += field.name.length + field.value.length;
  return cost;
}

async function cleanupChannels(): Promise<void> {
  // deliveries and channel_routes cascade from delivery_channels.
  await db("delivery_channels").where("name", "like", `${NAME_PREFIX}%`).del();
}

// ── Encryption ─────────────────────────────────────────────────────────────

describe("delivery/crypto — AES-256-GCM channel secrets", () => {
  it("round-trips a webhook URL", () => {
    const sealed = encryptSecret(WEBHOOK_URL);
    assert.equal(decryptSecret(sealed), WEBHOOK_URL);
  });

  it("produces ciphertext that does not contain the plaintext", () => {
    const sealed = encryptSecret(WEBHOOK_URL);
    assert.ok(!sealed.toString("utf8").includes(WEBHOOK_TOKEN), "token must not survive in the stored bytes");
    assert.ok(!sealed.toString("latin1").includes("discord.com"), "host must not survive in the stored bytes");
  });

  it("uses a fresh IV so the same plaintext encrypts differently each time", () => {
    const a = encryptSecret(WEBHOOK_URL);
    const b = encryptSecret(WEBHOOK_URL);
    assert.notEqual(a.toString("hex"), b.toString("hex"));
    assert.equal(decryptSecret(a), decryptSecret(b));
  });

  it("round-trips a JSON config", () => {
    const sealed = encryptConfig({ webhook_url: WEBHOOK_URL });
    assert.deepEqual(decryptConfig<{ webhook_url: string }>(sealed), { webhook_url: WEBHOOK_URL });
  });

  it("rejects decryption under the wrong key", () => {
    const sealed = encryptSecret(WEBHOOK_URL);
    assert.throws(() => decryptSecret(sealed, ALT_KEY), ChannelCryptoError);
  });

  it("rejects a tampered authentication tag", () => {
    const sealed = encryptSecret(WEBHOOK_URL);
    sealed[sealed.length - 1] ^= 0xff;
    assert.throws(() => decryptSecret(sealed), ChannelCryptoError);
  });

  it("rejects a truncated payload", () => {
    assert.throws(() => decryptSecret(Buffer.from([1, 2, 3])), ChannelCryptoError);
  });

  it("rejects a missing or malformed key", () => {
    assert.throws(() => resolveChannelKey(""), ChannelCryptoError);
    assert.throws(() => resolveChannelKey("too-short"), ChannelCryptoError);
    assert.equal(resolveChannelKey(ALT_KEY).length, 32);
  });

  it("compares shared secrets without leaking length-1 differences", () => {
    assert.ok(secretsMatch("abc123", "abc123"));
    assert.ok(!secretsMatch("abc123", "abc124"));
    assert.ok(!secretsMatch("abc123", "abc1234"));
  });
});

// ── SSRF ───────────────────────────────────────────────────────────────────

describe("delivery/discord — SSRF host allowlist", () => {
  it("accepts genuine discord.com and discordapp.com webhook URLs", () => {
    assert.equal(assertDiscordWebhookUrl(WEBHOOK_URL).hostname, "discord.com");
    assert.equal(
      assertDiscordWebhookUrl(`https://discordapp.com/api/webhooks/1/${WEBHOOK_TOKEN}`).hostname,
      "discordapp.com",
    );
    assert.equal(
      assertDiscordWebhookUrl(`https://discord.com/api/v10/webhooks/1/${WEBHOOK_TOKEN}`).hostname,
      "discord.com",
    );
  });

  const rejected: Array<[string, string]> = [
    ["loopback name", "https://localhost/api/webhooks/1/tok"],
    ["loopback IP", "https://127.0.0.1/api/webhooks/1/tok"],
    ["loopback IPv6", "https://[::1]/api/webhooks/1/tok"],
    ["cloud metadata", "https://169.254.169.254/api/webhooks/1/tok"],
    ["private 10/8", "https://10.0.0.5/api/webhooks/1/tok"],
    ["private 172.16/12", "https://172.16.4.4/api/webhooks/1/tok"],
    ["private 192.168/16", "https://192.168.1.10/api/webhooks/1/tok"],
    ["plain http", "http://discord.com/api/webhooks/1/tok"],
    ["suffix lookalike", "https://discord.com.evil.test/api/webhooks/1/tok"],
    ["subdomain lookalike", "https://evil.discord.com.attacker.test/api/webhooks/1/tok"],
    ["userinfo trick", "https://discord.com@evil.test/api/webhooks/1/tok"],
    ["odd port", "https://discord.com:8443/api/webhooks/1/tok"],
    ["non-webhook path", "https://discord.com/api/users/@me"],
    ["file scheme", "file:///etc/passwd"],
    ["not a URL", "not-a-url"],
  ];

  for (const [label, url] of rejected) {
    it(`rejects ${label}`, () => {
      assert.throws(() => assertDiscordWebhookUrl(url), WebhookUrlError, `${label} should be rejected`);
    });
  }

  it("never echoes the webhook token in the rejection message", () => {
    try {
      assertDiscordWebhookUrl(`https://evil.test/api/webhooks/1/${WEBHOOK_TOKEN}`);
      assert.fail("expected rejection");
    } catch (err) {
      assert.ok(err instanceof WebhookUrlError);
      assert.ok(!err.message.includes(WEBHOOK_TOKEN), "error must not leak the token");
    }
  });
});

describe("delivery/discord — generic webhook address ranges", () => {
  it("classifies blocked addresses", () => {
    for (const blocked of [
      "127.0.0.1",
      "127.5.5.5",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      assert.equal(isBlockedAddress(blocked), true, `${blocked} should be blocked`);
    }
  });

  it("allows public addresses", () => {
    for (const allowed of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
      assert.equal(isBlockedAddress(allowed), false, `${allowed} should be allowed`);
    }
  });

  it("rejects a hostname that resolves into a blocked range", async () => {
    await assert.rejects(
      assertPublicWebhookUrl("https://metadata.internal.test/hook", { lookup: lookupTo("169.254.169.254") }),
      WebhookUrlError,
    );
    await assert.rejects(
      assertPublicWebhookUrl("https://rebind.test/hook", { lookup: lookupTo("93.184.216.34", "127.0.0.1") }),
      WebhookUrlError,
      "any blocked address in the answer set must reject",
    );
  });

  it("rejects loopback names and literals without a lookup", async () => {
    await assert.rejects(assertPublicWebhookUrl("https://localhost/hook"), WebhookUrlError);
    await assert.rejects(assertPublicWebhookUrl("https://127.0.0.1/hook"), WebhookUrlError);
    await assert.rejects(assertPublicWebhookUrl("https://169.254.169.254/hook"), WebhookUrlError);
    await assert.rejects(assertPublicWebhookUrl("https://192.168.4.4/hook"), WebhookUrlError);
    await assert.rejects(assertPublicWebhookUrl("https://[::1]/hook"), WebhookUrlError);
  });

  it("accepts a hostname that resolves to a public address", async () => {
    const url = await assertPublicWebhookUrl("https://hooks.example.test/hook", {
      lookup: lookupTo("93.184.216.34"),
    });
    assert.equal(url.hostname, "hooks.example.test");
  });
});

// ── Truncation ─────────────────────────────────────────────────────────────

describe("delivery/discord — size limits are enforced with a visible marker", () => {
  it("truncates content over 2000 characters", () => {
    const { message, report } = sanitizeMessage({ content: "c".repeat(2500) });
    assert.equal(message.content?.length, DISCORD_LIMITS.content);
    assert.ok(message.content?.endsWith(TRUNCATION_MARKER), "cut content must end with the marker");
    assert.equal(report.truncated, true);
    assert.ok(report.notes.some((n) => n.startsWith("content truncated")));
  });

  it("truncates embed title and description", () => {
    const { message, report } = sanitizeMessage({
      embeds: [{ title: "t".repeat(400), description: "d".repeat(5000) }],
    });
    const embed = message.embeds?.[0];
    assert.equal(embed?.title?.length, DISCORD_LIMITS.embedTitle);
    assert.equal(embed?.description?.length, DISCORD_LIMITS.embedDescription);
    assert.ok(embed?.title?.endsWith(TRUNCATION_MARKER));
    assert.ok(embed?.description?.endsWith(TRUNCATION_MARKER));
    assert.equal(report.truncated, true);
  });

  it("truncates oversized field names and values", () => {
    const { message } = sanitizeMessage({
      embeds: [{ fields: [{ name: "n".repeat(300), value: "v".repeat(2000) }] }],
    });
    const field = message.embeds?.[0].fields?.[0];
    assert.equal(field?.name.length, DISCORD_LIMITS.fieldName);
    assert.equal(field?.value.length, DISCORD_LIMITS.fieldValue);
    assert.ok(field?.value.endsWith(TRUNCATION_MARKER));
  });

  it("caps fields at 25 per embed and says how many were omitted", () => {
    const fields = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, value: `v${i}` }));
    const { message, report } = sanitizeMessage({ embeds: [{ fields }] });
    const kept = message.embeds?.[0].fields ?? [];
    assert.equal(kept.length, DISCORD_LIMITS.fieldsPerEmbed);
    assert.equal(kept[kept.length - 1].name, TRUNCATION_MARKER);
    assert.match(kept[kept.length - 1].value, /6 more fields omitted/);
    assert.equal(report.droppedFields, 6);
  });

  it("caps embeds at 10 per message and reports the overflow in content", () => {
    const embeds = Array.from({ length: 12 }, (_, i) => ({ title: `e${i}`, description: "short" }));
    const { message, report } = sanitizeMessage({ embeds });
    assert.equal(message.embeds?.length, DISCORD_LIMITS.embedsPerMessage);
    assert.equal(report.droppedEmbeds, 2);
    assert.ok(message.content?.includes(TRUNCATION_MARKER));
    assert.match(message.content ?? "", /2 more not shown/);
  });

  it("keeps the whole message under the 6000-character embed budget", () => {
    const embeds = Array.from({ length: 10 }, (_, i) => ({
      title: `e${i}`,
      description: "d".repeat(1000),
    }));
    const { message, report } = sanitizeMessage({ embeds });
    const total = (message.embeds ?? []).reduce((sum, embed) => sum + embedCost(embed), 0);
    assert.ok(
      total <= DISCORD_LIMITS.totalEmbedChars,
      `total embed characters ${total} must be within ${DISCORD_LIMITS.totalEmbedChars}`,
    );
    assert.equal(report.truncated, true);
    assert.ok(report.droppedEmbeds > 0, "embeds that could not fit must be reported, not silently dropped");
    assert.match(message.content ?? "", /more not shown/);
  });

  it("leaves a message that already fits untouched", () => {
    const input: DiscordMessage = { content: "hello", embeds: [{ title: "ok", description: "fine" }] };
    const { message, report } = sanitizeMessage(input);
    assert.equal(report.truncated, false);
    assert.deepEqual(message, input);
  });
});

// ── Rate limits and 429 ────────────────────────────────────────────────────

describe("delivery/discord — rate limiting and 429 handling", () => {
  it("honours retry_after from the 429 body and then succeeds", async () => {
    const calls: RecordedCall[] = [];
    const sleeps: number[] = [];
    const client = new DiscordClient({
      fetchImpl: stubFetch(
        [{ status: 429, body: JSON.stringify({ message: "You are being rate limited.", retry_after: 1.5 }) }, { status: 204 }],
        calls,
      ),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    });

    const result = await client.post(WEBHOOK_URL, { content: "hi" });

    assert.equal(result.status, 204);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.rateLimitWaitsMs, [1500], "must wait exactly what Discord asked for");
    assert.deepEqual(sleeps, [1500], "no blind retry — the only sleep is the retry_after");
    assert.equal(calls.length, 2);
  });

  it("falls back to the retry-after header when the body has no retry_after", async () => {
    const calls: RecordedCall[] = [];
    const sleeps: number[] = [];
    const client = new DiscordClient({
      fetchImpl: stubFetch(
        [{ status: 429, body: "rate limited", headers: { "retry-after": "0.25" } }, { status: 204 }],
        calls,
      ),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    });

    const result = await client.post(WEBHOOK_URL, { content: "hi" });
    assert.deepEqual(result.rateLimitWaitsMs, [250]);
    assert.deepEqual(sleeps, [250]);
  });

  it("gives up after maxAttempts of sustained 429s rather than hammering", async () => {
    const calls: RecordedCall[] = [];
    const sleeps: number[] = [];
    const client = new DiscordClient({
      fetchImpl: stubFetch([{ status: 429, body: JSON.stringify({ retry_after: 0.5 }) }], calls),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
      maxAttempts: 3,
    });

    await assert.rejects(client.post(WEBHOOK_URL, { content: "hi" }), DiscordPostError);
    assert.equal(calls.length, 3, "one request per attempt, no more");
    assert.deepEqual(sleeps, [500, 500], "no sleep after the final attempt");
  });

  it("refuses a retry_after above the ceiling instead of hanging", async () => {
    const calls: RecordedCall[] = [];
    const client = new DiscordClient({
      fetchImpl: stubFetch([{ status: 429, body: JSON.stringify({ retry_after: 3600 }) }], calls),
      sleep: async () => undefined,
      now: () => 0,
      maxRetryAfterMs: 60_000,
    });
    await assert.rejects(client.post(WEBHOOK_URL, { content: "hi" }), /above the 60000ms ceiling/);
    assert.equal(calls.length, 1);
  });

  it("enforces 5 requests per 2 seconds per webhook locally", async () => {
    const calls: RecordedCall[] = [];
    const sleeps: number[] = [];
    let clock = 0;
    const client = new DiscordClient({
      fetchImpl: stubFetch([{ status: 204 }], calls),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });

    for (let i = 0; i < 6; i++) {
      await client.post(WEBHOOK_URL, { content: `m${i}` });
    }

    assert.equal(calls.length, 6);
    assert.deepEqual(sleeps, [2000], "the sixth request in the window waits for the window to roll");
  });

  it("does not retry a non-429 4xx", async () => {
    const calls: RecordedCall[] = [];
    const client = new DiscordClient({
      fetchImpl: stubFetch([{ status: 404, body: "Unknown Webhook" }], calls),
      sleep: async () => undefined,
      now: () => 0,
    });

    await assert.rejects(client.post(WEBHOOK_URL, { content: "hi" }), (err: unknown) => {
      assert.ok(err instanceof DiscordPostError);
      assert.equal(err.status, 404);
      assert.equal(err.retryable, false);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("retries 5xx with exponential backoff", async () => {
    const calls: RecordedCall[] = [];
    const sleeps: number[] = [];
    const client = new DiscordClient({
      fetchImpl: stubFetch([{ status: 500 }, { status: 502 }, { status: 204 }], calls),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    });

    const result = await client.post(WEBHOOK_URL, { content: "hi" });
    assert.equal(result.status, 204);
    assert.deepEqual(sleeps, [backoffMs(1), backoffMs(2)]);
  });

  it("validates the URL before making any request", async () => {
    const calls: RecordedCall[] = [];
    const client = new DiscordClient({ fetchImpl: stubFetch([{ status: 204 }], calls), sleep: async () => undefined });
    await assert.rejects(client.post("https://169.254.169.254/api/webhooks/1/tok", { content: "x" }), WebhookUrlError);
    assert.equal(calls.length, 0, "an SSRF target must never be contacted");
  });

  it("posts a sanitized body, not the raw oversized one", async () => {
    const calls: RecordedCall[] = [];
    const client = new DiscordClient({
      fetchImpl: stubFetch([{ status: 204 }], calls),
      sleep: async () => undefined,
      now: () => 0,
    });

    await client.post(WEBHOOK_URL, { embeds: [{ title: "t".repeat(500), description: "d" }] });
    assert.equal(calls[0].message.embeds?.[0].title?.length, DISCORD_LIMITS.embedTitle);
  });
});

// ── Channels and masking ───────────────────────────────────────────────────

describe("delivery/channels — storage, masking, and route resolution", () => {
  before(cleanupChannels);
  after(cleanupChannels);

  it("masks a webhook URL down to host plus last four characters", () => {
    const masked = maskWebhookUrl(WEBHOOK_URL);
    assert.equal(masked, `https://discord.com/…${WEBHOOK_TOKEN.slice(-4)}`);
    assert.ok(!masked.includes(WEBHOOK_TOKEN));
  });

  it("stores the URL encrypted and never in the raw column", async () => {
    const channel = await createChannel(db, {
      channel_type: "discord",
      name: `${NAME_PREFIX}roundtrip`,
      config: { webhook_url: WEBHOOK_URL },
    });

    const raw = await db("delivery_channels")
      .where({ id: channel.id })
      .first<{ config_encrypted: Buffer } | undefined>("config_encrypted");
    assert.ok(raw, "channel row should exist");
    assert.ok(Buffer.isBuffer(raw.config_encrypted));
    assert.ok(
      !raw.config_encrypted.toString("latin1").includes(WEBHOOK_TOKEN),
      "raw column must be unreadable",
    );

    const secret = await loadChannelSecret(db, channel.id);
    assert.equal(secret?.webhook_url, WEBHOOK_URL, "the service can recover it");
  });

  it("returns only a masked config from list endpoints", async () => {
    await createChannel(db, {
      channel_type: "discord",
      name: `${NAME_PREFIX}masked`,
      config: { webhook_url: WEBHOOK_URL },
    });

    const channels = await listChannels(db);
    const serialized = JSON.stringify(channels);
    assert.ok(!serialized.includes(WEBHOOK_TOKEN), "no listing may contain the full webhook URL");
    const mine = channels.find((c) => c.name === `${NAME_PREFIX}masked`);
    assert.ok(mine);
    assert.match(mine.config_masked, /^https:\/\/discord\.com\/…/);
  });

  it("refuses to create a discord channel pointed at an SSRF target", async () => {
    await assert.rejects(
      createChannel(db, {
        channel_type: "discord",
        name: `${NAME_PREFIX}ssrf`,
        config: { webhook_url: "https://169.254.169.254/api/webhooks/1/tok" },
      }),
      WebhookUrlError,
    );
    const row = await db("delivery_channels").where({ name: `${NAME_PREFIX}ssrf` }).first();
    assert.equal(row, undefined, "a rejected channel must not be persisted");
  });

  it("ranks severities so min_severity filtering is meaningful", () => {
    assert.ok(severityRank("critical") > severityRank("high"));
    assert.ok(severityRank("high") > severityRank("medium"));
    assert.ok(severityRank("medium") > severityRank("low"));
    assert.equal(severityRank(null), severityRank("info"));
    assert.equal(severityRank("nonsense"), severityRank("info"));
  });

  it("resolves routes by event type, severity floor, and jurisdiction", async () => {
    const channel = await createChannel(db, {
      channel_type: "discord",
      name: `${NAME_PREFIX}routing`,
      config: { webhook_url: WEBHOOK_URL },
    });
    await createRoute(db, {
      channel_id: channel.id,
      event_type: "anomaly.flagged",
      min_severity: "high",
      jurisdiction_id: BOZEMAN_ID,
    });

    const matched = await resolveRoutes(db, {
      event_type: "anomaly.flagged",
      severity: "critical",
      jurisdiction_id: BOZEMAN_ID,
    });
    assert.equal(matched.filter((r) => r.channel_id === channel.id).length, 1);

    const belowFloor = await resolveRoutes(db, {
      event_type: "anomaly.flagged",
      severity: "low",
      jurisdiction_id: BOZEMAN_ID,
    });
    assert.equal(belowFloor.filter((r) => r.channel_id === channel.id).length, 0);

    const otherJurisdiction = await resolveRoutes(db, {
      event_type: "anomaly.flagged",
      severity: "critical",
      jurisdiction_id: GALLATIN_ID,
    });
    assert.equal(otherJurisdiction.filter((r) => r.channel_id === channel.id).length, 0);

    const otherType = await resolveRoutes(db, {
      event_type: "ci.build_failed",
      severity: "critical",
      jurisdiction_id: BOZEMAN_ID,
    });
    assert.equal(otherType.filter((r) => r.channel_id === channel.id).length, 0);
  });

  it("skips routes on a disabled channel", async () => {
    const channel = await createChannel(db, {
      channel_type: "discord",
      name: `${NAME_PREFIX}disabled`,
      config: { webhook_url: WEBHOOK_URL },
      enabled: false,
    });
    await createRoute(db, { channel_id: channel.id, event_type: "finding.published" });

    const matched = await resolveRoutes(db, { event_type: "finding.published" });
    assert.equal(matched.filter((r) => r.channel_id === channel.id).length, 0);
  });
});

// ── Dispatcher ─────────────────────────────────────────────────────────────

describe("delivery/dispatcher — durability, dedupe, batching, retry", () => {
  let channelId: string;
  let calls: RecordedCall[];
  let clock: Date;

  const anomaly = (n: number) => ({
    event_type: "anomaly.flagged",
    severity: "high",
    jurisdiction_id: BOZEMAN_ID,
    dedupe_key: `anomaly.flagged:test-${n}`,
    payload: {
      title: `Unusual vote pattern #${n}`,
      description: `Item ${n} passed with an unrecorded abstention.`,
      link: `https://commissionwatch.test/anomalies/${n}`,
      flag_type: "unrecorded_abstention",
    },
  });

  function makeDispatcher(responses: StubResponse[], maxAttempts = 1): DeliveryDispatcher {
    return new DeliveryDispatcher(db, {
      autoFlush: false,
      now: () => clock,
      maxAttempts: 3,
      discord: new DiscordClient({
        fetchImpl: stubFetch(responses, calls),
        sleep: async () => undefined,
        now: () => 0,
        maxAttempts,
      }),
    });
  }

  before(async () => {
    await cleanupChannels();
    const channel = await createChannel(db, {
      channel_type: "discord",
      name: `${NAME_PREFIX}dispatch`,
      config: { webhook_url: WEBHOOK_URL },
    });
    channelId = channel.id;
    await createRoute(db, { channel_id: channelId, event_type: "anomaly.flagged" });
    await createRoute(db, { channel_id: channelId, event_type: "ci.build_failed" });
  });

  beforeEach(async () => {
    calls = [];
    clock = new Date("2026-08-04T12:00:00.000Z");
    await db("deliveries").where({ channel_id: channelId }).del();
  });

  after(cleanupChannels);

  it("writes a durable delivery row and posts it", async () => {
    const dispatcher = makeDispatcher([{ status: 204 }]);
    const result = await dispatcher.dispatch(anomaly(1));

    assert.equal(result.queued.length, 1);
    assert.equal(result.duplicates, 0);

    const pending = await db("deliveries").where({ id: result.queued[0] }).first();
    assert.equal(pending.status, "pending", "the row exists before the request is made");

    const flushed = await dispatcher.flushAll();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].status, "sent");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, WEBHOOK_URL);
    assert.equal(calls[0].message.embeds?.length, 1);
    assert.match(calls[0].message.embeds?.[0].title ?? "", /Unusual vote pattern #1/);

    const sent = await db("deliveries").where({ id: result.queued[0] }).first();
    assert.equal(sent.status, "sent");
    assert.ok(sent.sent_at !== null);
  });

  it("dedupes: the same event delivered twice inserts one row and posts once", async () => {
    const dispatcher = makeDispatcher([{ status: 204 }]);

    const first = await dispatcher.dispatch(anomaly(7));
    const second = await dispatcher.dispatch(anomaly(7));

    assert.equal(first.queued.length, 1);
    assert.equal(second.queued.length, 0);
    assert.equal(second.duplicates, 1, "the unique (channel_id, dedupe_key) index absorbed the repeat");

    const rows = await db("deliveries")
      .where({ channel_id: channelId, dedupe_key: "anomaly.flagged:test-7" });
    assert.equal(rows.length, 1);

    await dispatcher.flushAll();
    assert.equal(calls.length, 1, "one post, not two");
  });

  it("derives a stable dedupe key from the payload when none is supplied", () => {
    const a = defaultDedupeKey({ event_type: "x.y", payload: { a: 1, b: "two" } });
    const b = defaultDedupeKey({ event_type: "x.y", payload: { b: "two", a: 1 } });
    const c = defaultDedupeKey({ event_type: "x.y", payload: { a: 2, b: "two" } });
    assert.equal(a, b, "key order must not change the identity of an event");
    assert.notEqual(a, c);
  });

  it("batches 40 events into one message of 10 embeds plus an overflow count", async () => {
    const dispatcher = makeDispatcher([{ status: 204 }]);

    for (let i = 0; i < 40; i++) {
      await dispatcher.dispatch(anomaly(100 + i));
    }

    const flushed = await dispatcher.flushAll();

    assert.equal(calls.length, 1, "a 40-anomaly sweep must produce one notification, not forty");
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].embeds, 10);
    assert.equal(flushed[0].overflow, 30);

    const body = calls[0].message;
    assert.equal(body.embeds?.length, DISCORD_LIMITS.embedsPerMessage);
    assert.match(body.content ?? "", /40 events in this batch/);
    assert.match(body.content ?? "", /\+30 more not shown/);

    const rows = await db("deliveries").where({ channel_id: channelId, event_type: "anomaly.flagged" });
    assert.equal(rows.length, 40);
    assert.ok(rows.every((r: { status: string }) => r.status === "sent"));
  });

  it("keeps a 40-event batch inside Discord's total character budget", async () => {
    const dispatcher = makeDispatcher([{ status: 204 }]);
    for (let i = 0; i < 40; i++) {
      await dispatcher.dispatch({
        ...anomaly(200 + i),
        payload: { title: "T".repeat(400), description: "D".repeat(3000) },
      });
    }
    await dispatcher.flushAll();

    const embeds = calls[0].message.embeds ?? [];
    const total = embeds.reduce((sum, embed) => sum + embedCost(embed), 0);
    assert.ok(total <= DISCORD_LIMITS.totalEmbedChars, `sent ${total} embed characters`);
    assert.ok((calls[0].message.content?.length ?? 0) <= DISCORD_LIMITS.content);
  });

  it("keeps separate event types in separate messages", async () => {
    const dispatcher = makeDispatcher([{ status: 204 }]);
    await dispatcher.dispatch(anomaly(300));
    await dispatcher.dispatch({
      event_type: "ci.build_failed",
      severity: "critical",
      dedupe_key: "ci.build_failed:run-1",
      payload: { title: "backend tests failed", link: "https://ci.test/run/1" },
    });

    await dispatcher.flushAll();
    assert.equal(calls.length, 2);
  });

  it("marks a failed post pending with backoff, then sends it on retry", async () => {
    const failing = makeDispatcher([{ status: 500 }]);
    const dispatched = await failing.dispatch(anomaly(400));
    const flushed = await failing.flushAll();

    assert.equal(flushed[0].status, "retrying");

    const row = await db("deliveries").where({ id: dispatched.queued[0] }).first();
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 1);
    assert.ok(row.last_error !== null, "the failure is a row you can read, not a lost log line");
    assert.ok(row.next_attempt_at !== null, "backoff is scheduled");
    assert.ok(new Date(row.next_attempt_at).getTime() > clock.getTime());

    // Time passes, Discord recovers.
    clock = new Date(clock.getTime() + 60_000);
    calls = [];
    const recovered = makeDispatcher([{ status: 204 }]);
    const retried = await recovered.retryPending();

    assert.equal(retried.length, 1);
    assert.equal(retried[0].status, "sent");
    assert.equal(calls.length, 1);

    const sent = await db("deliveries").where({ id: dispatched.queued[0] }).first();
    assert.equal(sent.status, "sent");
  });

  it("fails a delivery outright when Discord rejects it non-retryably", async () => {
    const dispatcher = makeDispatcher([{ status: 404, body: "Unknown Webhook" }]);
    const dispatched = await dispatcher.dispatch(anomaly(500));
    const flushed = await dispatcher.flushAll();

    assert.equal(flushed[0].status, "failed");
    const row = await db("deliveries").where({ id: dispatched.queued[0] }).first();
    assert.equal(row.status, "failed");
    assert.equal(row.next_attempt_at, null, "a dead webhook is not retried forever");
  });

  it("does not retry past maxAttempts", async () => {
    const first = makeDispatcher([{ status: 500 }]);
    const dispatched = await first.dispatch(anomaly(600));
    const id = dispatched.queued[0];
    await first.flushAll(); // attempt 1

    for (let round = 2; round <= 3; round++) {
      // Pretend the backoff has elapsed, then run the retry sweep.
      await db("deliveries").where({ id }).update({ next_attempt_at: clock });
      await makeDispatcher([{ status: 500 }]).retryPending();
    }

    // A fourth sweep must not touch it.
    calls = [];
    await makeDispatcher([{ status: 500 }]).retryPending();

    const row = await db("deliveries").where({ id }).first();
    assert.equal(row.attempts, 3, "the dispatcher's maxAttempts is the ceiling");
    assert.equal(row.status, "failed");
    assert.equal(row.next_attempt_at, null);
    assert.equal(calls.length, 0, "a failed delivery is not picked up again");
  });

  it("does not post when no route matches", async () => {
    const dispatcher = makeDispatcher([{ status: 204 }]);
    const result = await dispatcher.dispatch({
      event_type: "release.shipped",
      dedupe_key: "release.shipped:v9",
      payload: { version: "v9" },
    });
    assert.equal(result.channels, 0);
    assert.equal(result.queued.length, 0);
    await dispatcher.flushAll();
    assert.equal(calls.length, 0);
  });
});

describe("delivery/dispatcher — embed construction", () => {
  it("builds one embed per event with severity colour, link, and fields", () => {
    const stored: StoredPayload = {
      severity: "critical",
      jurisdiction_id: BOZEMAN_ID,
      occurred_at: "2026-08-04T12:00:00.000Z",
      data: {
        title: "Emergency session called",
        description: "Notice given 4 hours before the meeting.",
        link: "https://commissionwatch.test/meetings/1",
        flag_type: "emergency_session",
        notice_hours: 4,
      },
    };

    const { message, overflow } = buildBatchMessage("anomaly.flagged", [{ payload: stored }]);
    assert.equal(overflow, 0);
    const embed = message.embeds?.[0];
    assert.equal(embed?.title, "Emergency session called");
    assert.equal(embed?.description, "Notice given 4 hours before the meeting.");
    assert.equal(embed?.url, "https://commissionwatch.test/meetings/1");
    assert.equal(embed?.color, 0xdc2626);
    assert.ok(embed?.fields?.some((f) => f.name === "Flag Type" && f.value === "emergency_session"));
    assert.ok(embed?.fields?.some((f) => f.name === "Notice Hours" && f.value === "4"));
    assert.equal(embed?.footer?.text, "severity: critical");
    assert.equal(message.content, undefined, "a single event needs no batch header");
  });

  it("ignores a non-http link rather than putting it in the embed", () => {
    const stored: StoredPayload = {
      severity: "low",
      jurisdiction_id: null,
      occurred_at: "2026-08-04T12:00:00.000Z",
      data: { title: "t", link: "javascript:alert(1)" },
    };
    const { message } = buildBatchMessage("finding.published", [{ payload: stored }]);
    assert.equal(message.embeds?.[0].url, undefined);
  });
});

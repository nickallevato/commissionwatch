import { createHmac, timingSafeEqual } from 'node:crypto';
import { ChannelConfigError } from './channels';

/**
 * SMS transport.
 *
 * W7 put SMS out of scope — "the channel abstraction makes them small later;
 * building them now is speculation." The operator asked for it by name on
 * 2026-08-09, which is what stopped it being speculation. The B-e spec records
 * that reversal explicitly, and it covers SMS only: Slack and Teams remain out.
 *
 * No Twilio SDK. Production images are linux/arm64 cross-builds and this
 * project does not add dependencies it can avoid; the REST API is one
 * form-encoded POST with basic auth, and request-signature validation is an
 * HMAC-SHA1 that `node:crypto` already provides.
 *
 * SMS differs from every other channel in two ways that are design problems,
 * not client problems, and both are enforced elsewhere:
 *
 * - **It costs money per message.** The per-day cap lives on the route and is
 *   enforced in the dispatcher, which defers rather than dropping.
 * - **Consent is regulated.** A destination must be verified before its first
 *   send, and STOP must unsubscribe. The dispatcher refuses unverified
 *   subscriber channels; the keywords below are handled inbound.
 */

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

/** E.164: a leading +, a non-zero country digit, 7–15 digits in total. */
const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

export function assertE164(value: string): void {
  if (!isE164(value)) {
    throw new ChannelConfigError(
      'A phone number must be in E.164 form, e.g. +14065550123',
    );
  }
}

export type SmsFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface TwilioClientOptions {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  fetchImpl?: SmsFetchLike;
  baseUrl?: string;
}

export class SmsSendError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'SmsSendError';
    this.status = status;
    this.retryable = retryable;
  }
}

export interface SmsSendResult {
  to: string;
  status: number;
}

export class TwilioClient {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  private readonly fetchImpl: SmsFetchLike;
  private readonly baseUrl: string;

  constructor(options: TwilioClientOptions = {}) {
    this.accountSid = options.accountSid ?? process.env.TWILIO_ACCOUNT_SID ?? '';
    this.authToken = options.authToken ?? process.env.TWILIO_AUTH_TOKEN ?? '';
    this.fromNumber = options.fromNumber ?? process.env.TWILIO_FROM_NUMBER ?? '';
    this.baseUrl = options.baseUrl ?? TWILIO_API_BASE;
    this.fetchImpl =
      options.fetchImpl ??
      ((url, init) =>
        fetch(url, init).then((res) => ({
          ok: res.ok,
          status: res.status,
          text: () => res.text(),
        })));
  }

  /** True when the client has everything it needs to send. */
  get configured(): boolean {
    return this.accountSid !== '' && this.authToken !== '' && this.fromNumber !== '';
  }

  async send(to: string, body: string): Promise<SmsSendResult> {
    if (!this.configured) {
      // Not retryable: no amount of waiting supplies a credential.
      throw new SmsSendError(
        'SMS is not configured; TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are all required',
        0,
        false,
      );
    }
    assertE164(to);

    const url = `${this.baseUrl}/Accounts/${this.accountSid}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: this.fromNumber, Body: body });
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const detail = await response.text();
      // 429 and 5xx are worth another attempt; a 4xx is a bad request that
      // will be exactly as bad next time, and retrying it costs money.
      const retryable = response.status === 429 || response.status >= 500;
      throw new SmsSendError(
        `Twilio rejected the message with ${response.status}: ${detail.slice(0, 200)}`,
        response.status,
        retryable,
      );
    }

    return { to, status: response.status };
  }
}

/**
 * Twilio signs each inbound request: HMAC-SHA1, over the full request URL with
 * every POST parameter appended in key-sorted order, keyed by the auth token.
 *
 * Without this check the inbound endpoint is an unauthenticated "unsubscribe
 * anyone" API — the request body is the only thing naming the number.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!authToken || !signature) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type InboundIntent = 'stop' | 'start' | 'help' | 'unknown';

const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_KEYWORDS = new Set(['start', 'yes', 'unstop']);
const HELP_KEYWORDS = new Set(['help', 'info']);

/**
 * The carrier-mandated keyword set, case-insensitive and whitespace-trimmed.
 * These are not optional politeness — STOP must unsubscribe.
 */
export function classifyInboundMessage(body: string): InboundIntent {
  const word = body.trim().toLowerCase();
  if (STOP_KEYWORDS.has(word)) return 'stop';
  if (START_KEYWORDS.has(word)) return 'start';
  if (HELP_KEYWORDS.has(word)) return 'help';
  return 'unknown';
}

export const SMS_HELP_TEXT =
  'CommissionWatch alerts. Reply STOP to unsubscribe, START to resubscribe. Message rates may apply.';

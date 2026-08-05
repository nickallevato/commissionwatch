import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM envelope for channel credentials (Discord webhook URLs and the
 * like). The key comes from CHANNEL_SECRET_KEY in the environment.
 *
 * Nothing in this module ever logs, throws, or otherwise surfaces plaintext:
 * error messages describe the failure mode only.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 1;

/** Stored layout: [version:1][iv:12][tag:16][ciphertext:n] */
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export class ChannelCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelCryptoError";
  }
}

/**
 * Resolve the 32-byte channel key. Accepts 64 hex chars (the documented
 * `openssl rand -hex 32` form) or 44-char standard base64.
 */
export function resolveChannelKey(explicitKey?: string): Buffer {
  const raw = (explicitKey ?? process.env.CHANNEL_SECRET_KEY ?? "").trim();
  if (raw.length === 0) {
    throw new ChannelCryptoError(
      "CHANNEL_SECRET_KEY is not set; channel credentials cannot be encrypted or read",
    );
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }

  if (key.length !== KEY_BYTES) {
    throw new ChannelCryptoError(
      `CHANNEL_SECRET_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}); generate one with: openssl rand -hex 32`,
    );
  }
  return key;
}

/** Encrypt a UTF-8 string into the stored bytea payload. */
export function encryptSecret(plaintext: string, explicitKey?: string): Buffer {
  const key = resolveChannelKey(explicitKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
}

/** Decrypt a stored bytea payload back to the original UTF-8 string. */
export function decryptSecret(payload: Buffer, explicitKey?: string): string {
  if (!Buffer.isBuffer(payload) || payload.length < HEADER_BYTES) {
    throw new ChannelCryptoError("Encrypted channel config is malformed or truncated");
  }

  const version = payload[0];
  if (version !== VERSION) {
    throw new ChannelCryptoError(`Unsupported channel config envelope version ${version}`);
  }

  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = payload.subarray(HEADER_BYTES);

  const key = resolveChannelKey(explicitKey);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Deliberately opaque: a GCM tag failure means wrong key or tampering,
    // and echoing anything derived from the ciphertext helps an attacker.
    throw new ChannelCryptoError(
      "Channel config failed authentication; wrong CHANNEL_SECRET_KEY or the row was tampered with",
    );
  }
}

/** Encrypt a JSON-serialisable channel config object. */
export function encryptConfig(config: unknown, explicitKey?: string): Buffer {
  return encryptSecret(JSON.stringify(config), explicitKey);
}

/** Decrypt and parse a channel config object. */
export function decryptConfig<T>(payload: Buffer, explicitKey?: string): T {
  const json = decryptSecret(payload, explicitKey);
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new ChannelCryptoError("Decrypted channel config is not valid JSON");
  }
}

/**
 * Constant-time comparison for shared secrets (e.g. the CI event token), so
 * callers do not have to reach for node:crypto themselves.
 */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

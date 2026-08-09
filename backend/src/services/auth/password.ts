import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Promisified by hand rather than with util.promisify: promisify resolves to
 * scrypt's *first* overload, which has no options argument, so the `maxmem`
 * this module depends on would not typecheck.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

/**
 * Fixed by spec §A1. scrypt from node core rather than argon2: production
 * images are linux/arm64 cross-builds and the argon2 package is a node-gyp
 * native addon, which is a category of build failure this project has already
 * paid for elsewhere. scrypt is memory-hard, ships in Node, and needs no
 * build step — the same reasoning that made services/delivery/crypto.ts pure
 * node:crypto.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 65536, r: 8, p: 1, keylen: 64 };

/** Cheap parameters for tests. Never use these to store a real credential. */
export const TEST_SCRYPT_PARAMS: ScryptParams = { N: 4096, r: 8, p: 1, keylen: 64 };

const SALT_BYTES = 16;
const SCHEME = 'scrypt';

/**
 * node:crypto defaults maxmem to 32 MiB. The default parameters need
 * 128·N·r = 64 MiB, so the call throws "Invalid scrypt params" without an
 * explicit override. Doubling leaves headroom for scrypt's working buffers.
 */
function maxmemFor(params: ScryptParams): number {
  return 2 * 128 * params.N * params.r;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return scryptAsync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
}

/**
 * Hash a password into `scrypt$N$r$p$<salt-b64>$<hash-b64>`.
 *
 * The parameters travel with the hash so the cost can be raised later without
 * invalidating a single existing row.
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await derive(password, salt, params);
  return [
    SCHEME,
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify against a stored hash, using the parameters recorded in it rather
 * than the current default — so raising the cost never locks anyone out.
 *
 * A malformed stored value returns false instead of throwing. The sign-in path
 * calls this against a decoy hash for unknown accounts, and an exception there
 * would be an observable difference between "no such operator" and "wrong
 * password".
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  if (N < 2 || r < 1 || p < 1) return false;

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await derive(password, salt, { N, r, p, keylen: expected.length });
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

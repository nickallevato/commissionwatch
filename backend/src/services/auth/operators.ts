import { createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import {
  hashPassword,
  verifyPassword,
  DEFAULT_SCRYPT_PARAMS,
  type ScryptParams,
} from './password';

export interface OperatorRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  last_login_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** What a route may return about an operator. Never the hash. */
export interface OperatorIdentity {
  id: string;
  email: string;
  name: string;
  role: string;
  last_login_at: string | null;
}

export interface SignInSuccess {
  ok: true;
  operator: OperatorIdentity;
  token: string;
  expiresAt: Date;
}

export type SignInFailure =
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'locked'; lockedUntil: Date };

export type SignInResult = SignInSuccess | SignInFailure;

export interface OperatorAuthOptions {
  scryptParams?: ScryptParams;
  now?: () => number;
  idleMs?: number;
  absoluteMs?: number;
  maxFailedAttempts?: number;
  lockoutMs?: number;
  log?: (message: string) => void;
  /**
   * Called once per password verification performed by signIn. Exists so the
   * spec's timing requirement can be asserted by counting work done rather
   * than by a wall-clock measurement, which would be flaky in CI and would not
   * actually prove the work happened.
   */
  onVerify?: () => void;
}

export const IDLE_SESSION_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * A hash of a value nobody knows. Verifying against it when the address is
 * unknown costs the same scrypt as a real account, so operator addresses
 * cannot be enumerated by timing the response.
 */
const DECOY_PASSWORD = randomBytes(32).toString('hex');

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toIdentity(row: OperatorRow): OperatorIdentity {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
  };
}

export class OperatorAuthService {
  private readonly scryptParams: ScryptParams;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly maxFailedAttempts: number;
  private readonly lockoutMs: number;
  private readonly log: (message: string) => void;
  private readonly onVerify: () => void;
  private decoyHash: Promise<string> | null = null;

  constructor(
    private readonly db: Knex,
    options: OperatorAuthOptions = {},
  ) {
    this.scryptParams = options.scryptParams ?? DEFAULT_SCRYPT_PARAMS;
    this.now = options.now ?? (() => Date.now());
    this.idleMs = options.idleMs ?? IDLE_SESSION_MS;
    this.absoluteMs = options.absoluteMs ?? ABSOLUTE_SESSION_MS;
    this.maxFailedAttempts = options.maxFailedAttempts ?? MAX_FAILED_ATTEMPTS;
    this.lockoutMs = options.lockoutMs ?? LOCKOUT_MS;
    this.log = options.log ?? ((message) => console.log(message));
    this.onVerify = options.onVerify ?? (() => {});
  }

  /**
   * Create an operator. There is no public route to this: the first account is
   * seeded from the environment, and subsequent ones are created by an
   * existing operator. A watchdog site with an open sign-up form is a
   * liability, not a feature.
   */
  async createOperator(input: {
    email: string;
    password: string;
    name: string;
  }): Promise<OperatorIdentity> {
    const password_hash = await hashPassword(input.password, this.scryptParams);
    const [row] = await this.db<OperatorRow>('operators')
      .insert({
        email: input.email.trim(),
        password_hash,
        name: input.name.trim(),
      })
      .returning('*');
    return toIdentity(row);
  }

  /**
   * Seed the first operator from the environment. A no-op when the table is
   * non-empty or the environment carries no seed, so it is safe on every boot.
   *
   * The spec says this comes from SSM Parameter Store. It does — the host
   * fetches /commissionwatch/env with its instance role and hands it to the
   * container, which is how every other secret reaches this process. The
   * backend holds no AWS SDK and should not acquire one for this.
   */
  async seedFirstOperator(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<OperatorIdentity | null> {
    const email = env.OPERATOR_SEED_EMAIL?.trim();
    const password = env.OPERATOR_SEED_PASSWORD;
    const name = env.OPERATOR_SEED_NAME?.trim();

    if (!email || !password || !name) return null;

    const existing = await this.db('operators').first('id');
    if (existing) return null;

    const operator = await this.createOperator({ email, password, name });
    // The address is not a secret; the password is, and is never logged.
    this.log(`Seeded the first operator account for ${operator.email}`);
    return operator;
  }

  async signIn(input: {
    email: string;
    password: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<SignInResult> {
    const email = input.email.trim();
    const operator = await this.db<OperatorRow>('operators').where({ email }).first();
    const nowMs = this.now();
    const source = input.ip ?? 'unknown ip';

    const lockedUntil = operator?.locked_until ? new Date(operator.locked_until) : null;
    const isLocked = lockedUntil !== null && lockedUntil.getTime() > nowMs;

    // Exactly one verification, whatever the outcome. An unknown address, a
    // locked account and a wrong password must cost the same, or the response
    // time tells an attacker which of the three they hit.
    const storedHash = operator?.password_hash ?? (await this.getDecoyHash());
    this.onVerify();
    const passwordOk = await verifyPassword(input.password, storedHash);

    if (!operator) {
      this.log(`Rejected sign-in for an unknown operator address from ${source}`);
      return { ok: false, reason: 'invalid_credentials' };
    }

    if (isLocked) {
      this.log(`Rejected sign-in for locked operator ${operator.id} from ${source}`);
      return { ok: false, reason: 'locked', lockedUntil };
    }

    if (!passwordOk) {
      const failed = operator.failed_attempts + 1;
      const lock = failed >= this.maxFailedAttempts;
      await this.db('operators')
        .where({ id: operator.id })
        .update({
          failed_attempts: failed,
          locked_until: lock ? new Date(nowMs + this.lockoutMs) : operator.locked_until,
          updated_at: new Date(nowMs),
        });
      this.log(
        `Failed sign-in ${failed} for operator ${operator.id} from ${source}` +
          (lock ? ' — account locked' : ''),
      );
      return { ok: false, reason: 'invalid_credentials' };
    }

    await this.db('operators')
      .where({ id: operator.id })
      .update({
        failed_attempts: 0,
        locked_until: null,
        last_login_at: new Date(nowMs),
        updated_at: new Date(nowMs),
      });

    const token = randomBytes(32).toString('hex');
    const idleExpiresAt = new Date(nowMs + this.idleMs);
    const absoluteExpiresAt = new Date(nowMs + this.absoluteMs);

    await this.db('operator_sessions').insert({
      operator_id: operator.id,
      token_hash: hashSessionToken(token),
      created_at: new Date(nowMs),
      last_seen_at: new Date(nowMs),
      idle_expires_at: idleExpiresAt,
      absolute_expires_at: absoluteExpiresAt,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
    });

    this.log(`Operator ${operator.id} signed in from ${source}`);

    const fresh = await this.db<OperatorRow>('operators').where({ id: operator.id }).first();
    return {
      ok: true,
      operator: toIdentity(fresh ?? operator),
      token,
      expiresAt: idleExpiresAt,
    };
  }

  /**
   * Validate a cookie value and slide the idle window forward. Returns null
   * for anything that is not a live session — unknown, revoked, idle-expired,
   * or past its absolute ceiling.
   */
  async validateSession(token: string): Promise<OperatorIdentity | null> {
    if (!token) return null;

    const nowMs = this.now();
    const now = new Date(nowMs);

    const session = await this.db('operator_sessions')
      .where({ token_hash: hashSessionToken(token) })
      .whereNull('revoked_at')
      .andWhere('idle_expires_at', '>', now)
      .andWhere('absolute_expires_at', '>', now)
      .first<{ id: string; operator_id: string; absolute_expires_at: Date } | undefined>(
        'id',
        'operator_id',
        'absolute_expires_at',
      );

    if (!session) return null;

    const absolute = new Date(session.absolute_expires_at).getTime();
    // The slide never outruns the ceiling — the CHECK constraint enforces the
    // same thing, so a bug here is a failed write rather than an immortal
    // session.
    const nextIdle = new Date(Math.min(nowMs + this.idleMs, absolute));

    await this.db('operator_sessions')
      .where({ id: session.id })
      .update({ last_seen_at: now, idle_expires_at: nextIdle });

    const operator = await this.db<OperatorRow>('operators')
      .where({ id: session.operator_id })
      .first();

    return operator ? toIdentity(operator) : null;
  }

  /** Server-side revocation. Replaying the cookie afterwards fails. */
  async revokeSession(token: string): Promise<boolean> {
    if (!token) return false;
    const updated = await this.db('operator_sessions')
      .where({ token_hash: hashSessionToken(token) })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date(this.now()) });
    return updated > 0;
  }

  /** Bounds table growth. Nothing depends on it for correctness. */
  async sweepExpiredSessions(): Promise<number> {
    return this.db('operator_sessions')
      .where('absolute_expires_at', '<=', new Date(this.now()))
      .del();
  }

  private getDecoyHash(): Promise<string> {
    this.decoyHash ??= hashPassword(DECOY_PASSWORD, this.scryptParams);
    return this.decoyHash;
  }
}

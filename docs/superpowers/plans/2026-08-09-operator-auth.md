> **SUPERSEDED — closed 2026-08-09, marked 2026-08-16.**
>
> Verified present on 2026-08-16: `backend/src/services/auth/password.ts`,
> `backend/test/operator-password.test.ts`, `backend/migrations/022_create_operators.ts`,
> `backend/migrations/023_create_operator_sessions.ts`.
>
> The unchecked boxes below are **not outstanding work**. They are the step-by-step transcript
> of work that shipped; nobody went back to tick them. They are left unticked rather than ticked
> retroactively, because ticking a box nobody watched pass would be a claim, and this project does
> not make those. Read `CHANGELOG.md` and `docs/STATUS.md` for what is actually true now.

# Operator Authentication Implementation Plan (A1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the deployed lineage the authentication it has never had, in the shape spec §A1 decided: one operator class, server-side sessions in an httpOnly cookie, `scrypt` from `node:crypto`, no public registration, and a CORS policy that is tight on the admin surface and open on the public read-only API.

**Source:** `docs/superpowers/specs/2026-08-09-archive-salvage-design.md` § "A1 · Operator authentication".

**Architecture.** Four layers, each independently testable:

```
migrations 022, 023      operators + operator_sessions, citext, operator_role enum
src/services/auth/       password.ts (scrypt)  ·  operators.ts (OperatorAuthService)
src/middleware/          requireOperator — reads the cookie, validates, attaches req.operator
src/routes/admin/        session.ts (POST/DELETE/GET) mounted under a guarded /api/admin router
frontend                 AuthContext (session probe) · ProtectedRoute · LoginPage · AdminHomePage
```

The archive's `auth.ts`, `middleware/auth.ts` and `015_create_users.ts` are the *reference*, not the port. Everything JWT, bcrypt, `user_role` and `/register` is discarded per spec.

**Tech Stack:** TypeScript, Node 22, Express 5, Knex 3, PostgreSQL 16, `node:test` + `node:assert/strict`, supertest. Frontend: React 18, Vite, Tailwind, vitest, Testing Library, msw.

## Global Constraints

- Never silence a type error: no `any`, no `@ts-ignore`, no `@ts-expect-error`, no cast to quiet the compiler.
- Never delete or skip a test to go green.
- The database schema is the source of truth for types.
- **No native/node-gyp dependencies.** Production images are `linux/arm64` cross-builds; a compiled addon breaks them. This is why the password hash is `node:crypto`'s `scrypt` and not the `argon2` package, and why cookie *reading* is a six-line parser rather than `cookie-parser`. No new runtime dependency is added by this plan.
- Tests must never hit the network.
- `backend/package.json`'s `test` script enumerates every test file by path. **A new test file not registered there never runs.**
- Migration numbering continues from `021_create_http_cache.ts`.
- Seed data never names a real person. The operator seed is env-driven and creates nobody by default.

## Two corrections to the spec, made deliberately

Recorded here rather than diverging silently.

1. **The sessions table is named `operator_sessions`, not `sessions`.** The spec says "a `sessions` table". B-e introduces subscriber-scoped tokens (`verify_token`, `unsubscribe_token`) that are also session-like and are governed by a *different* permission model — `owner_kind` exists precisely to keep operator and subscriber identities apart. A bare `sessions` invites conflating them at exactly the point where conflating them is a security defect. The name is the only change; every column and rule is as specified.

2. **The first-operator seed reads the environment, not SSM directly.** The spec says the seed comes "from SSM Parameter Store at `/commissionwatch/operator-seed`". The backend has no AWS SDK and must not acquire one: on this deployment the host fetches `/commissionwatch/env` from Parameter Store with its instance role and hands the result to the container as an env file (`docs/STATUS.md` § Operational facts). So the parameter is delivered as `OPERATOR_SEED_EMAIL` / `OPERATOR_SEED_PASSWORD` / `OPERATOR_SEED_NAME`, which is the same secret by the same route as every other secret this app holds. The "consumed once, only when `operators` is empty" behaviour is unchanged.

## Pre-flight

```bash
docker compose up -d db
cd backend  && npm run typecheck && npm test
cd frontend && npm run typecheck && npm test -- --run
```

Baseline after A4 and A2: backend 114 tests / 43 suites, frontend 130 tests / 17 files. Do not start on a red tree.

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/022_create_operators.ts` | `citext` extension, `operator_role` enum, `operators` table. |
| `backend/migrations/023_create_operator_sessions.ts` | `operator_sessions` — server-side, revocable, sliding-expiry sessions. |
| `backend/src/services/auth/password.ts` | `hashPassword` / `verifyPassword`. Pure `node:crypto` scrypt. Parameters travel in the stored string. |
| `backend/src/services/auth/operators.ts` | `OperatorAuthService` — create, authenticate, lockout, session lifecycle, first-operator seed. |
| `backend/src/middleware/requireOperator.ts` | Cookie parse, session validation, `req.operator`. 401 otherwise. |
| `backend/src/routes/admin/session.ts` | `POST` / `DELETE` / `GET /api/admin/session`. |
| `backend/src/routes/admin/index.ts` | The admin router: session routes, then the guard, then a guarded 404. |
| `backend/src/app.ts` | Mount the admin router. Replace `cors()` with a per-path delegate. |
| `backend/src/index.ts` | Run the first-operator seed at boot. |
| `backend/test/operator-password.test.ts` | Hash format, verification, parameter portability. |
| `backend/test/operator-auth.test.ts` | Routes, lockout, revocation, seed idempotence, CORS. |
| `backend/.env.example` | `SESSION_COOKIE_SECURE`, `ADMIN_ORIGINS`, `OPERATOR_SEED_*`. |
| `backend/package.json` | Register both new test files. |
| `frontend/src/contexts/AuthContext.tsx` | Session probe, sign in, sign out. No token storage of any kind. |
| `frontend/src/components/ProtectedRoute.tsx` | Redirects to `/admin/login` when unauthenticated. |
| `frontend/src/pages/LoginPage.tsx` | Editorial-design sign-in. Inert Google/GitHub buttons tagged "Soon". |
| `frontend/src/pages/AdminHomePage.tsx` | The admin console shell B-e and B-d fill in. |
| `frontend/src/App.tsx` | `/admin/login` and `/admin` routes, wrapped in `AuthProvider`. |
| `frontend/src/mocks/handlers.ts` | `/api/admin/session` handlers so app-level renders do not hit an unhandled request. |
| `frontend/src/pages/LoginPage.test.tsx`, `frontend/src/components/ProtectedRoute.test.tsx` | Frontend behaviour. |

---

### Task 1: Password hashing

**Files:** create `backend/src/services/auth/password.ts`, `backend/test/operator-password.test.ts`; modify `backend/package.json`.

**Background.** Node's `crypto.scrypt` defaults `maxmem` to 32 MiB. The specified parameters need `128 · N · r` = `128 · 65536 · 8` = **64 MiB**, so the call throws `Invalid scrypt params` unless `maxmem` is passed explicitly. This is the single trap in this task.

**Stored format:** `scrypt$N$r$p$<salt-b64>$<hash-b64>`. The parameters travel with the hash, so the cost can be raised later without invalidating existing rows, and so tests can seed a cheap hash (`N = 2^12`) while production uses `N = 2^16`.

- [ ] **Step 1: Write the failing test** — `backend/test/operator-password.test.ts`

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  DEFAULT_SCRYPT_PARAMS,
  TEST_SCRYPT_PARAMS,
} from "../src/services/auth/password";

describe("operator password hashing", () => {
  it("defaults to the parameters the spec fixed", () => {
    assert.deepEqual(DEFAULT_SCRYPT_PARAMS, { N: 65536, r: 8, p: 1, keylen: 64 });
  });

  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery staple", TEST_SCRYPT_PARAMS);
    assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple", TEST_SCRYPT_PARAMS);
    assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
  });

  it("carries its parameters in the stored string", async () => {
    const stored = await hashPassword("hunter2hunter2", TEST_SCRYPT_PARAMS);
    const [scheme, n, r, p, salt, hash] = stored.split("$");

    assert.equal(scheme, "scrypt");
    assert.equal(Number(n), TEST_SCRYPT_PARAMS.N);
    assert.equal(Number(r), TEST_SCRYPT_PARAMS.r);
    assert.equal(Number(p), TEST_SCRYPT_PARAMS.p);
    assert.ok(Buffer.from(salt, "base64").length >= 16);
    assert.equal(Buffer.from(hash, "base64").length, TEST_SCRYPT_PARAMS.keylen);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same password", TEST_SCRYPT_PARAMS);
    const b = await hashPassword("same password", TEST_SCRYPT_PARAMS);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same password", a), true);
    assert.equal(await verifyPassword("same password", b), true);
  });

  it("verifies a hash stored at different parameters than the current default", async () => {
    // The upgrade path: raising the cost must not lock out existing operators.
    const legacy = await hashPassword("legacy password", { N: 4096, r: 8, p: 1, keylen: 64 });
    assert.equal(await verifyPassword("legacy password", legacy), true);
  });

  it("returns false rather than throwing on a malformed stored value", async () => {
    assert.equal(await verifyPassword("anything", "not-a-hash"), false);
    assert.equal(await verifyPassword("anything", "bcrypt$1$2$3$4"), false);
    assert.equal(await verifyPassword("anything", ""), false);
  });

  it("can hash at the production parameters without blowing maxmem", async () => {
    // N=2^16, r=8 needs 64 MiB; node defaults maxmem to 32 MiB and throws
    // without an explicit override. This test is the regression guard for that.
    const stored = await hashPassword("production cost", DEFAULT_SCRYPT_PARAMS);
    assert.equal(await verifyPassword("production cost", stored), true);
  });
});
```

- [ ] **Step 2: Register the file** — append ` test/operator-password.test.ts` to the `test` script in `backend/package.json`.
- [ ] **Step 3: Run; confirm it fails** with `Cannot find module '../src/services/auth/password'`.
- [ ] **Step 4: Implement** `backend/src/services/auth/password.ts`:

```typescript
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

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
 * paid for. scrypt is memory-hard, ships in Node, and needs no build step.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 65536, r: 8, p: 1, keylen: 64 };

/** Cheap parameters for tests. Never use these to store a real credential. */
export const TEST_SCRYPT_PARAMS: ScryptParams = { N: 4096, r: 8, p: 1, keylen: 64 };

const SALT_BYTES = 16;
const SCHEME = 'scrypt';

/**
 * node:crypto defaults maxmem to 32 MiB. These parameters need 128·N·r =
 * 64 MiB, so the call throws "Invalid scrypt params" without an explicit
 * override. Doubling leaves headroom for scrypt's own working buffers.
 */
function maxmemFor(params: ScryptParams): number {
  return 2 * 128 * params.N * params.r;
}

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const derived = await scrypt(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
  return derived as Buffer;
}

/** `scrypt$N$r$p$<salt-b64>$<hash-b64>` — parameters travel with the hash. */
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
```

- [ ] **Step 5: Run.** All eight tests pass; `npm run typecheck` silent.

---

### Task 2: Schema — `operators` and `operator_sessions`

**Files:** create `backend/migrations/022_create_operators.ts`, `backend/migrations/023_create_operator_sessions.ts`.

**Background.** `citext` makes `email` case-insensitively unique in the database rather than by a `toLowerCase()` the archive applied inconsistently — the archive lowercased on register and login but its `UNIQUE` was on a case-sensitive `varchar`, so `Op@x.com` and `op@x.com` were two rows. The extension ships with the postgres image already in use.

**The session token is not stored.** The cookie carries 32 random bytes hex; the row stores its SHA-256. A read of `operator_sessions` therefore yields nothing a caller can present. This is not in the spec and is not a divergence from it — the spec fixes the cookie's properties, not the column's.

- [ ] **Step 1:** `backend/migrations/022_create_operators.ts`

```typescript
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // citext: email uniqueness is case-insensitive in the database rather than
  // in whichever route last remembered to call toLowerCase().
  await knex.raw('CREATE EXTENSION IF NOT EXISTS citext');

  // One value on purpose. The column exists so a second role is an
  // ALTER TYPE ... ADD VALUE, not a migration that rewrites every row.
  await knex.raw(`CREATE TYPE operator_role AS ENUM ('operator')`);

  await knex.schema.createTable('operators', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.specificType('email', 'citext').notNullable().unique();
    table.text('password_hash').notNullable();
    table.text('name').notNullable();
    table.specificType('role', 'operator_role').notNullable().defaultTo('operator');
    table.timestamp('last_login_at', { useTz: true }).nullable();
    table.integer('failed_attempts').notNullable().defaultTo(0);
    table.timestamp('locked_until', { useTz: true }).nullable();
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('operators');
  await knex.raw('DROP TYPE IF EXISTS operator_role');
  // citext is deliberately left installed: dropping an extension another
  // migration may later depend on is a worse outcome than leaving it.
}
```

- [ ] **Step 2:** `backend/migrations/023_create_operator_sessions.ts`

```typescript
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('operator_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('operator_id')
      .notNullable()
      .references('id')
      .inTable('operators')
      .onDelete('CASCADE');

    // The SHA-256 of the cookie value, never the value itself. A read of this
    // table yields nothing anyone can present as a session.
    table.text('token_hash').notNullable().unique();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Sliding: pushed forward on each validated request.
    table.timestamp('idle_expires_at', { useTz: true }).notNullable();
    // Hard ceiling: never extended, so a session cannot live forever by use.
    table.timestamp('absolute_expires_at', { useTz: true }).notNullable();
    table.timestamp('revoked_at', { useTz: true }).nullable();

    table.text('ip').nullable();
    table.text('user_agent').nullable();

    table.index('operator_id', 'idx_operator_sessions_operator');
    table.index('absolute_expires_at', 'idx_operator_sessions_absolute_expiry');
  });

  await knex.raw(`
    ALTER TABLE operator_sessions
    ADD CONSTRAINT operator_sessions_idle_within_absolute_check
    CHECK (idle_expires_at <= absolute_expires_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('operator_sessions');
}
```

- [ ] **Step 3:** `NODE_ENV=test npx knex migrate:latest --knexfile knexfile.ts` applies both cleanly.

---

### Task 3: `OperatorAuthService`

**Files:** create `backend/src/services/auth/operators.ts`. Tested through Task 4's route tests plus direct unit assertions in `backend/test/operator-auth.test.ts`.

**The behaviours that matter, and why:**

- **Lockout bounds scrypt's memory cost.** 64 MiB per hash on a 4 GB shared host means unbounded concurrent sign-in attempts are a cheap denial of service. Five failures locks for 15 minutes.
- **A locked account still performs one verification.** Otherwise the lockout is detectable by response timing, which tells an attacker their guess space is worth continuing on this address. The same reason drives a **decoy hash** for unknown emails: an unknown address costs exactly one scrypt, like a known one.
- **Sliding expiry never exceeds the absolute ceiling**, so a session in constant use still dies at 7 days.

```typescript
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
}

export const IDLE_SESSION_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * A hash of a value nobody knows. Verifying against it when the email is
 * unknown costs the same scrypt as a real account, so an attacker cannot
 * enumerate operator addresses by timing the response.
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
  }

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
   * Seed the first operator. A no-op when the table is non-empty or the
   * environment carries no seed, so it is safe to run on every boot.
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

    const lockedUntil = operator?.locked_until ? new Date(operator.locked_until) : null;
    const isLocked = lockedUntil !== null && lockedUntil.getTime() > nowMs;

    // Always exactly one verification, whatever the outcome: unknown account,
    // locked account and wrong password must cost the same.
    const storedHash = operator?.password_hash ?? (await this.getDecoyHash());
    const passwordOk = await verifyPassword(input.password, storedHash);

    if (!operator) {
      this.log(`Rejected sign-in for unknown operator address from ${input.ip ?? 'unknown ip'}`);
      return { ok: false, reason: 'invalid_credentials' };
    }

    if (isLocked) {
      this.log(`Rejected sign-in for locked operator ${operator.id} from ${input.ip ?? 'unknown ip'}`);
      return { ok: false, reason: 'locked', lockedUntil: lockedUntil as Date };
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
        `Failed sign-in ${failed} for operator ${operator.id} from ${input.ip ?? 'unknown ip'}` +
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

    this.log(`Operator ${operator.id} signed in from ${input.ip ?? 'unknown ip'}`);

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
   * for anything that is not a live session — unknown, revoked, idle-expired
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
      .first<{ id: string; operator_id: string; absolute_expires_at: Date }>();

    if (!session) return null;

    const absolute = new Date(session.absolute_expires_at).getTime();
    // The slide never outruns the ceiling; the CHECK constraint enforces it too.
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

/** Exported for the middleware's constant-time cookie comparison needs. */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
```

---

### Task 4: Middleware, routes, CORS

**Files:** create `backend/src/middleware/requireOperator.ts`, `backend/src/routes/admin/session.ts`, `backend/src/routes/admin/index.ts`; modify `backend/src/app.ts`, `backend/src/index.ts`, `backend/.env.example`, `backend/package.json`; create `backend/test/operator-auth.test.ts`.

**Cookie reading without a dependency.** Express sets cookies natively (`res.cookie`) but does not parse them; `req.cookies` needs `cookie-parser`. A session id is hex, so a six-line parser is sufficient and adds no dependency to an arm64 cross-build.

**CORS.** `app.use(cors())` allows any origin. Replacing it wholesale would break the public API, whose openness is the point. The `cors` package accepts a **delegate** — `(req, callback) => callback(null, options)` — so one middleware can serve both policies by path. Mounting two `cors()` calls does not work: the second overwrites the first's headers.

**Test isolation.** These tests share the database with every other suite and must leave it as they found it. Every operator row created is deleted in `after`, and `operator_sessions` cascades.

- [ ] **Step 1: Write the failing test** — `backend/test/operator-auth.test.ts`

```typescript
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  OperatorAuthService,
  TEST_SESSION_COOKIE_NAME,
} from "../src/services/auth/operators-testing";

const EMAIL = "operator-auth-test@example.invalid";
const PASSWORD = "a-sufficiently-long-passphrase";

// Cheap scrypt: these tests perform dozens of verifications and the production
// parameters cost 64 MiB each.
const service = new OperatorAuthService(db, { scryptParams: { N: 4096, r: 8, p: 1, keylen: 64 } });

async function cleanup() {
  await db("operators").where("email", "like", "%@example.invalid").del();
}

function sessionCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  assert.ok(raw, "expected a Set-Cookie header");
  const cookies = Array.isArray(raw) ? raw : [raw];
  const session = cookies.find((c) => c.startsWith("cw_session="));
  assert.ok(session, `expected a cw_session cookie, got: ${cookies.join(" | ")}`);
  return session.split(";")[0];
}

describe("operator authentication", () => {
  before(cleanup);
  after(async () => {
    await cleanup();
    await db.destroy();
  });

  beforeEach(cleanup);

  describe("the admin surface is closed by default", () => {
    it("returns 401, not 200, for an admin route with no cookie", async () => {
      await request(app).get("/api/admin/session").expect(401);
    });

    it("returns 401, not 404, for an unknown admin path with no cookie", async () => {
      // A 404 would confirm which admin routes exist to an unauthenticated caller.
      await request(app).get("/api/admin/no-such-thing").expect(401);
    });

    it("returns 401 for a forged cookie", async () => {
      await request(app)
        .get("/api/admin/session")
        .set("Cookie", `cw_session=${"0".repeat(64)}`)
        .expect(401);
    });
  });

  describe("sign in", () => {
    beforeEach(async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
    });

    it("sets an httpOnly, SameSite=Lax session cookie", async () => {
      const res = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      const raw = res.headers["set-cookie"];
      const cookies = Array.isArray(raw) ? raw : [raw];
      const cookie = cookies.find((c) => c.startsWith("cw_session="));
      assert.ok(cookie);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.match(cookie, /Path=\//i);
      assert.equal(res.body.operator.email, EMAIL);
      assert.equal("password_hash" in res.body.operator, false);
    });

    it("does not put the session token in the response body", async () => {
      const res = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      assert.equal(JSON.stringify(res.body).includes("token"), false);
    });

    it("matches email case-insensitively", async () => {
      await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL.toUpperCase(), password: PASSWORD })
        .expect(200);
    });

    it("rejects a wrong password with 401 and no cookie", async () => {
      const res = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: "wrong-password-entirely" })
        .expect(401);
      assert.equal(res.headers["set-cookie"], undefined);
    });

    it("gives the same 401 body for an unknown address as for a wrong password", async () => {
      const unknown = await request(app)
        .post("/api/admin/session")
        .send({ email: "nobody@example.invalid", password: PASSWORD })
        .expect(401);
      const wrong = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: "wrong-password-entirely" })
        .expect(401);
      assert.deepEqual(unknown.body, wrong.body);
    });

    it("rejects a malformed body with 400", async () => {
      await request(app).post("/api/admin/session").send({ email: EMAIL }).expect(400);
      await request(app).post("/api/admin/session").send({}).expect(400);
    });
  });

  describe("who am I", () => {
    it("returns the signed-in operator, and never the password hash", async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      const signIn = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      const res = await request(app)
        .get("/api/admin/session")
        .set("Cookie", sessionCookie(signIn))
        .expect(200);

      assert.equal(res.body.operator.email, EMAIL);
      assert.equal(res.body.operator.name, "Test Operator");
      assert.equal(res.body.operator.role, "operator");
      assert.equal(JSON.stringify(res.body).includes("password"), false);
    });
  });

  describe("sign out", () => {
    it("invalidates the session server-side, so replaying the cookie fails", async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      const signIn = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      const cookie = sessionCookie(signIn);

      await request(app).get("/api/admin/session").set("Cookie", cookie).expect(200);
      await request(app).delete("/api/admin/session").set("Cookie", cookie).expect(204);
      await request(app).get("/api/admin/session").set("Cookie", cookie).expect(401);
    });
  });

  describe("lockout", () => {
    it("locks after five failures and still refuses the correct password", async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app)
          .post("/api/admin/session")
          .send({ email: EMAIL, password: `wrong-${attempt}` })
          .expect(401);
      }

      const row = await db("operators").where({ email: EMAIL }).first();
      assert.equal(row.failed_attempts, 5);
      assert.ok(row.locked_until, "the fifth failure must record a lockout");

      await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(401);
    });

    it("still performs one password verification while locked, so the lockout is not visible in timing", async () => {
      // Counting verifications is the deterministic form of the spec's timing
      // requirement. A wall-clock assertion would be flaky in CI and would not
      // actually prove the work was done.
      let verifications = 0;
      const counting = new OperatorAuthService(db, {
        scryptParams: { N: 4096, r: 8, p: 1, keylen: 64 },
        maxFailedAttempts: 2,
        onVerify: () => {
          verifications += 1;
        },
        log: () => {},
      });

      await counting.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      await counting.signIn({ email: EMAIL, password: "wrong-a" });
      await counting.signIn({ email: EMAIL, password: "wrong-b" });

      verifications = 0;
      const locked = await counting.signIn({ email: EMAIL, password: PASSWORD });
      assert.equal(locked.ok, false);
      assert.equal(verifications, 1, "a locked account must still cost one verification");

      verifications = 0;
      await counting.signIn({ email: "nobody@example.invalid", password: PASSWORD });
      assert.equal(verifications, 1, "an unknown address must still cost one verification");
    });

    it("clears the failure counter on a successful sign-in", async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      await request(app).post("/api/admin/session").send({ email: EMAIL, password: "nope" }).expect(401);
      await request(app).post("/api/admin/session").send({ email: EMAIL, password: PASSWORD }).expect(200);

      const row = await db("operators").where({ email: EMAIL }).first();
      assert.equal(row.failed_attempts, 0);
      assert.equal(row.locked_until, null);
    });
  });

  describe("session expiry", () => {
    it("does not accept a session past its idle window", async () => {
      let clock = Date.parse("2026-08-09T12:00:00Z");
      const timed = new OperatorAuthService(db, {
        scryptParams: { N: 4096, r: 8, p: 1, keylen: 64 },
        idleMs: 1_000,
        absoluteMs: 10_000,
        log: () => {},
        now: () => clock,
      });
      await timed.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      const result = await timed.signIn({ email: EMAIL, password: PASSWORD });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.notEqual(await timed.validateSession(result.token), null);
      clock += 1_001;
      assert.equal(await timed.validateSession(result.token), null);
    });

    it("does not extend a session past its absolute ceiling", async () => {
      let clock = Date.parse("2026-08-09T12:00:00Z");
      const timed = new OperatorAuthService(db, {
        scryptParams: { N: 4096, r: 8, p: 1, keylen: 64 },
        idleMs: 5_000,
        absoluteMs: 8_000,
        log: () => {},
        now: () => clock,
      });
      await timed.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      const result = await timed.signIn({ email: EMAIL, password: PASSWORD });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      // Kept alive by use, but the ceiling is never pushed out.
      clock += 4_000;
      assert.notEqual(await timed.validateSession(result.token), null);
      clock += 4_001;
      assert.equal(await timed.validateSession(result.token), null);
    });
  });

  describe("first-operator seed", () => {
    it("runs once and is a no-op on a non-empty table", async () => {
      const env = {
        OPERATOR_SEED_EMAIL: EMAIL,
        OPERATOR_SEED_PASSWORD: PASSWORD,
        OPERATOR_SEED_NAME: "Seeded Operator",
      } as NodeJS.ProcessEnv;

      const quiet = new OperatorAuthService(db, {
        scryptParams: { N: 4096, r: 8, p: 1, keylen: 64 },
        log: () => {},
      });

      const first = await quiet.seedFirstOperator(env);
      assert.ok(first);
      const second = await quiet.seedFirstOperator(env);
      assert.equal(second, null, "a second boot must not create another operator");

      const [{ count }] = await db("operators").where({ email: EMAIL }).count<{ count: string }[]>();
      assert.equal(Number(count), 1);
    });

    it("creates nobody when the environment carries no seed", async () => {
      const quiet = new OperatorAuthService(db, { log: () => {} });
      assert.equal(await quiet.seedFirstOperator({} as NodeJS.ProcessEnv), null);
    });
  });

  describe("CORS", () => {
    it("keeps the public API open to any origin", async () => {
      const res = await request(app)
        .get("/api/health")
        .set("Origin", "https://someone-elses-site.example")
        .expect(200);
      assert.equal(res.headers["access-control-allow-origin"], "*");
    });

    it("does not allow an unlisted origin to reach the admin surface with credentials", async () => {
      const res = await request(app)
        .get("/api/admin/session")
        .set("Origin", "https://someone-elses-site.example");
      assert.equal(res.headers["access-control-allow-origin"], undefined);
    });

    it("allows the configured admin origin with credentials", async () => {
      const res = await request(app)
        .get("/api/admin/session")
        .set("Origin", "http://localhost:3000");
      assert.equal(res.headers["access-control-allow-origin"], "http://localhost:3000");
      assert.equal(res.headers["access-control-allow-credentials"], "true");
    });
  });
});
```

> **Note for the implementer:** the test imports `OperatorAuthService` from `../src/services/auth/operators-testing`. That is a mistake in this draft — import it from `../src/services/auth/operators`, and drop the unused `TEST_SESSION_COOKIE_NAME` import; the cookie name is asserted as a literal. Also add an `onVerify?: () => void` hook to `OperatorAuthOptions`, called once per `verifyPassword` invocation inside `signIn`. It exists solely to make the timing requirement testable without a wall-clock assertion.

- [ ] **Step 2: Register the file** — append ` test/operator-auth.test.ts` to the `test` script.
- [ ] **Step 3: Run; confirm it fails.**
- [ ] **Step 4: `backend/src/middleware/requireOperator.ts`**

```typescript
import type { Request, Response, NextFunction } from 'express';
import db from '../config/database';
import { OperatorAuthService, type OperatorIdentity } from '../services/auth/operators';

export const SESSION_COOKIE_NAME = 'cw_session';

declare module 'express-serve-static-core' {
  interface Request {
    operator?: OperatorIdentity;
  }
}

/**
 * Express sets cookies natively but does not parse them — `req.cookies` needs
 * cookie-parser. A session id is hex, so this is sufficient, and it keeps a
 * dependency out of an arm64 cross-build for no loss.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

const service = new OperatorAuthService(db);

export function operatorAuthService(): OperatorAuthService {
  return service;
}

/** 401 for anything that is not a live operator session. Never 403, never 404. */
export async function requireOperator(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const operator = token ? await service.validateSession(token) : null;

    if (!operator) {
      res.status(401).json({ error: 'Authentication required', statusCode: 401 });
      return;
    }

    req.operator = operator;
    next();
  } catch (err) {
    next(err);
  }
}
```

- [ ] **Step 5: `backend/src/routes/admin/session.ts`**

```typescript
import { Router, type Request } from 'express';
import {
  SESSION_COOKIE_NAME,
  operatorAuthService,
  readCookie,
  requireOperator,
} from '../../middleware/requireOperator';
import { IDLE_SESSION_MS } from '../../services/auth/operators';

const router = Router();

/**
 * Secure is on everywhere except local development. The production site is
 * HTTPS-only behind Caddy; a Secure cookie over plain http during `npm run dev`
 * is simply never stored, which reads as a broken login.
 */
function cookieSecure(): boolean {
  if (process.env.SESSION_COOKIE_SECURE === 'true') return true;
  if (process.env.SESSION_COOKIE_SECURE === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

interface SignInBody {
  email?: unknown;
  password?: unknown;
}

/** Sign in. The only /api/admin route that answers without a session. */
router.post('/', async (req: Request<unknown, unknown, SignInBody>, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || email.trim() === '' || typeof password !== 'string' || password === '') {
      res.status(400).json({ error: 'Email and password are required', statusCode: 400 });
      return;
    }

    const result = await operatorAuthService().signIn({
      email,
      password,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });

    if (!result.ok) {
      // One body for every failure. Distinguishing "unknown address" from
      // "wrong password" from "locked" hands an attacker free information.
      res.status(401).json({ error: 'Invalid credentials', statusCode: 401 });
      return;
    }

    res.cookie(SESSION_COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: IDLE_SESSION_MS,
    });

    // The token is in the cookie and nowhere else. A copy in the body would be
    // readable by any script on the page, which is the whole reason this is
    // not a JWT in local storage.
    res.status(200).json({ operator: result.operator });
  } catch (err) {
    next(err);
  }
});

/** Who am I. Requires a live session. */
router.get('/', requireOperator, (req, res) => {
  res.status(200).json({ operator: req.operator });
});

/** Sign out. Revokes server-side, so replaying the cookie fails. */
router.delete('/', requireOperator, async (req, res, next) => {
  try {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    if (token) await operatorAuthService().revokeSession(token);

    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      path: '/',
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 6: `backend/src/routes/admin/index.ts`**

```typescript
import { Router } from 'express';
import sessionRouter from './session';
import { requireOperator } from '../../middleware/requireOperator';

const router = Router();

// The session routes carry their own guard: POST is the sign-in and cannot
// require what it issues; GET and DELETE call requireOperator themselves.
router.use('/session', sessionRouter);

// Everything mounted after this line requires a live operator session.
// B-e's channel management and B-d's uploads land here.
router.use(requireOperator);

// A guarded catch-all. Without it an unknown admin path 404s before the guard
// runs, which confirms to an unauthenticated caller which routes exist.
router.use((_req, res) => {
  res.status(404).json({ error: 'Not found', statusCode: 404 });
});

export default router;
```

- [ ] **Step 7: `backend/src/app.ts`** — mount the router and replace the CORS call.

```typescript
import cors, { type CorsOptions, type CorsOptionsDelegate } from "cors";
import type { Request } from "express";
import adminRouter from "./routes/admin";

/**
 * Origins permitted to make credentialed requests to /api/admin. Comma
 * separated in ADMIN_ORIGINS; the Vite dev server is included so local
 * development works without configuration.
 */
const ADMIN_ORIGINS = (
  process.env.ADMIN_ORIGINS ?? "https://commissionwatch.bmux.sh,http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

/**
 * Two policies, one middleware. The public read-only API stays open to any
 * origin — open data is the point. The admin surface takes an explicit
 * allowlist and `credentials: true`, because it carries a session cookie and
 * `origin: *` with credentials is both forbidden by the spec and unsafe.
 *
 * A delegate rather than two `app.use(cors())` calls: the second would
 * overwrite the first's headers, silently reopening the admin surface.
 */
const corsDelegate: CorsOptionsDelegate<Request> = (req, callback) => {
  const options: CorsOptions = req.path.startsWith("/api/admin")
    ? { origin: ADMIN_ORIGINS, credentials: true }
    : { origin: "*" };
  callback(null, options);
};

app.use(helmet());
app.use(cors(corsDelegate));
app.use(express.json());

// ... existing public routers ...
app.use("/api/admin", adminRouter);
```

- [ ] **Step 8: `backend/src/index.ts`** — seed at boot, before `listen`:

```typescript
import { operatorAuthService } from "./middleware/requireOperator";

// Consumed once: a no-op when the table already has an operator, so it is
// safe on every boot. Failure is logged, not fatal — a running site that
// cannot be signed into beats a site that will not start.
operatorAuthService()
  .seedFirstOperator()
  .catch((err) => console.error("Operator seed failed", err));
```

- [ ] **Step 9: `backend/.env.example`** — append:

```
# Operator authentication. The admin surface is closed without these.
# Comma-separated origins allowed to make credentialed admin requests.
ADMIN_ORIGINS=https://commissionwatch.bmux.sh,http://localhost:3000
# Leave unset in production: Secure defaults on when NODE_ENV=production.
SESSION_COOKIE_SECURE=
# The first operator, seeded once at boot and only when `operators` is empty.
# Delivered by the host from SSM Parameter Store, like every other secret here.
# Remove after the first boot; leaving it set does nothing but keep a password
# in the environment.
OPERATOR_SEED_EMAIL=
OPERATOR_SEED_PASSWORD=
OPERATOR_SEED_NAME=
```

- [ ] **Step 10: Run** `npm run typecheck && npm test`. Every operator-auth test passes; nothing else regresses.

---

### Task 5: Frontend — AuthContext, ProtectedRoute, LoginPage, admin shell

**Files:** create `frontend/src/contexts/AuthContext.tsx`, `frontend/src/components/ProtectedRoute.tsx`, `frontend/src/pages/LoginPage.tsx`, `frontend/src/pages/AdminHomePage.tsx`, `frontend/src/pages/LoginPage.test.tsx`, `frontend/src/components/ProtectedRoute.test.tsx`; modify `frontend/src/App.tsx`, `frontend/src/mocks/handlers.ts`.

**The storage swap.** The archive read a JWT out of local storage. An httpOnly cookie is unreadable from JS by design, so "am I signed in?" becomes a request: `GET /api/admin/session`, 200 or 401. That is one round trip on mount, and it is the correct trade — the token cannot be exfiltrated by a script that lands on the page.

**Design.** The archive's LoginPage is dark (`bg-gray-900`). The deployed design system is light editorial: `paper`, `ink`, `rule`, `muted`, one `accent` red, `font-display` serif headlines, `tracking-label` uppercase micro-labels. Rebuild in those tokens; do not port the markup.

**SSO placeholder.** Google and GitHub buttons render `disabled` with a "Soon" tag, per the operator's 2026-08-09 decision. Inert markup only — no OIDC dependency.

**No registration route anywhere**, per spec. Do not add a link to one.

- [ ] **Step 1: `frontend/src/mocks/handlers.ts`** — add, so app-level renders do not fire an unhandled request:

```typescript
  http.get("/api/admin/session", () =>
    HttpResponse.json({ error: "Authentication required", statusCode: 401 }, { status: 401 }),
  ),
```

- [ ] **Step 2: `frontend/src/contexts/AuthContext.tsx`**

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface Operator {
  id: string;
  email: string;
  name: string;
  role: string;
  last_login_at: string | null;
}

interface AuthContextValue {
  operator: Operator | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

/**
 * The session lives in an httpOnly cookie, which JavaScript cannot read by
 * design. So "am I signed in?" is a request, not a local-storage lookup — one
 * round trip on mount, in exchange for a token no injected script can steal.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const res = await fetch("/api/admin/session", { credentials: "same-origin" });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { operator: Operator };
          setOperator(body.operator);
        } else {
          setOperator(null);
        }
      } catch {
        if (!cancelled) setOperator(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await fetch("/api/admin/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      // The API answers every failure identically on purpose; the UI says the
      // same thing rather than inventing a distinction the server refuses to make.
      throw new Error("Those credentials were not accepted.");
    }
    const body = (await res.json()) as { operator: Operator };
    setOperator(body.operator);
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/admin/session", { method: "DELETE", credentials: "same-origin" });
    setOperator(null);
  }, []);

  const value = useMemo(
    () => ({ operator, loading, signIn, signOut }),
    [operator, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
```

- [ ] **Step 3: `frontend/src/components/ProtectedRoute.tsx`**

```tsx
import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../contexts/AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { operator, loading } = useAuth();
  const location = useLocation();

  // Render nothing decisive until the session probe resolves — redirecting
  // first would bounce a signed-in operator to the login form on every reload.
  if (loading) {
    return (
      <p className="label-sm" role="status">
        Checking session…
      </p>
    );
  }

  if (!operator) {
    return <Navigate to="/admin/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
```

- [ ] **Step 4: `frontend/src/pages/LoginPage.tsx`** — editorial design, inert SSO buttons, no register link. Full markup written at implementation time against the tokens in `tailwind.config.ts` and the patterns in `Layout.tsx`.
- [ ] **Step 5: `frontend/src/pages/AdminHomePage.tsx`** — the console shell: operator name, a sign-out button, and a short note naming what lands here next (channels from B-e, records requests from B-d).
- [ ] **Step 6: `frontend/src/App.tsx`** — wrap the route table in `AuthProvider`; add `/admin/login` → `LoginPage` and `/admin` → `ProtectedRoute`+`AdminHomePage`. **Do not add either to the masthead nav** — `chrome-links.test.tsx` walks the nav asserting every link resolves, and an admin door does not belong in a public masthead.
- [ ] **Step 7: Tests** — `LoginPage.test.tsx`: renders the form; the SSO buttons are present, disabled and tagged "Soon"; a failed sign-in shows an error and no crash; a successful one calls the API. `ProtectedRoute.test.tsx`: redirects to `/admin/login` when the probe 401s; renders children when it 200s.
- [ ] **Step 8: Verify** `npm run typecheck && npm test -- --run`.

---

### Task 6: Documentation and commit

- [ ] Update `docs/STATUS.md`: gap 10 ("No admin authentication") is closed; record what shipped and the `OPERATOR_SEED_*` boot behaviour operators need to know.
- [ ] Update `CLAUDE.md` if the hard-rules list needs the scrypt/no-native-deps line made explicit.
- [ ] Commit with a body explaining *why*, ending in the `Co-Authored-By` trailer.

## Self-Review

**Spec coverage.** Every bullet in spec §A1 maps to a task: table and columns → Task 2; `operator_role` single value → Task 2; scrypt with explicit `maxmem` and the `scrypt$N$r$p$salt$hash` format → Task 1; httpOnly/Secure/SameSite=Lax cookie on a server-side session with 12h idle / 7d absolute → Tasks 2–4; no registration route, env-delivered seed consumed once → Task 3 and 4; lockout at 5 for 15 minutes with logged attempts → Task 3; CORS tightening → Task 4; `ProtectedRoute` and `AuthContext` with the storage swapped for a session probe → Task 5; SSO placeholder → Task 5; `RegisterPage` discarded → never created.

**Acceptance criteria, each to a test.**

| Spec acceptance | Test |
|---|---|
| Any `/api/admin/*` without a cookie returns 401, never 200 | "the admin surface is closed by default" (3 cases, including an unknown path) |
| Six wrong passwords lock the account; the sixth is timing-indistinguishable | "locks after five failures…" plus "still performs one password verification while locked" |
| The seed runs exactly once | "runs once and is a no-op on a non-empty table" |
| Signing out invalidates server-side; replay returns 401 | "invalidates the session server-side, so replaying the cookie fails" |

**Things the implementer will get wrong if they skim:**

1. `maxmem` must be passed to `scrypt` or the production parameters throw.
2. The `test` script in `backend/package.json` enumerates files; two are added here.
3. Two `app.use(cors())` calls do not compose — the second overwrites. Use the delegate.
4. Task 4's draft test imports from a non-existent `operators-testing` module and an unused constant. Fix both, and add the `onVerify` hook the timing test depends on.
5. `res.cookie` exists natively; `req.cookies` does not. Parse the header.

## Acceptance for the whole plan

```bash
docker compose up -d db
cd backend  && npm run typecheck && npm test
cd frontend && npm run typecheck && npm test -- --run
```

Both green, no skipped tests, no new runtime dependency in either `package.json`.

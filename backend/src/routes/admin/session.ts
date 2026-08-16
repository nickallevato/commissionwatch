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
 * Whether the session cookie carries `Secure`.
 *
 * `SESSION_COOKIE_SECURE=false` exists so the console can be used over plain
 * HTTP in local development. In production it is not a preference — a session
 * cookie without `Secure` is sent over plain HTTP, and an operator session
 * token is the credential that approves what this site publishes about named
 * people.
 *
 * So the downgrade is **refused** in production rather than honoured or
 * quietly ignored. The reasoning is the same as `assertFreeModel`'s in the
 * OpenRouter client: the cost of the misconfiguration is worse than the cost of
 * the outage it causes. A console that will not issue a session is a visible
 * problem somebody fixes in minutes; a session token travelling in the clear is
 * invisible until it is used.
 *
 * Ignoring the variable and carrying on would be the tempting middle path, and
 * it is the worst of the three: the deployment would be secure while its
 * configuration said otherwise, and the next person to read that configuration
 * would believe it.
 *
 * As of 2026-08-16 this refusal cannot fire on the live deployment — the
 * variable is set nowhere in `deploy/` or `.gitea/`, so production falls
 * through to the `NODE_ENV` default and is already secure. It is a guard
 * against a future edit, not a fix for a present defect.
 */
export function cookieSecure(): boolean {
  const configured = process.env.SESSION_COOKIE_SECURE;
  const production = process.env.NODE_ENV === 'production';

  if (configured === 'false' && production) {
    throw new Error(
      'SESSION_COOKIE_SECURE=false with NODE_ENV=production: refusing to issue an ' +
        'operator session cookie without the Secure flag. That cookie is the credential ' +
        'that approves what this site publishes about named people, and without Secure it ' +
        'travels over plain HTTP. Unset SESSION_COOKIE_SECURE in production; it exists only ' +
        'so the console can be used over HTTP in local development.',
    );
  }

  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return production;
}

interface SignInBody {
  email?: unknown;
  password?: unknown;
}

/** Sign in. The only /api/admin route that answers without a session. */
router.post('/', async (req: Request<unknown, unknown, SignInBody>, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (
      typeof email !== 'string' ||
      email.trim() === '' ||
      typeof password !== 'string' ||
      password === ''
    ) {
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
    // readable by any script on the page, which is the whole reason this is not
    // a JWT in local storage.
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

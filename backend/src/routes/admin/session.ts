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
 * HTTPS-only behind Caddy; a Secure cookie sent over plain http during
 * `npm run dev` is simply never stored, which presents as a broken login.
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

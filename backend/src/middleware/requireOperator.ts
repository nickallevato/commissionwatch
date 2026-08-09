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
 * Express sets cookies natively (`res.cookie`) but does not parse them —
 * `req.cookies` needs cookie-parser. A session id is hex, so this is
 * sufficient, and it keeps a dependency out of an arm64 cross-build for no
 * loss of correctness.
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

/** The process-wide auth service. Routes and the boot seed share one. */
export function operatorAuthService(): OperatorAuthService {
  return service;
}

/**
 * 401 for anything that is not a live operator session — never 403, never 404.
 * A 404 on a guarded path would confirm to an unauthenticated caller which
 * admin routes exist.
 */
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

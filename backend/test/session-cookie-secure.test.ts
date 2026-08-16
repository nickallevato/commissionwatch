import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cookieSecure } from "../src/routes/admin/session";

/**
 * The one configuration that must not be honoured.
 *
 * `SESSION_COOKIE_SECURE=false` is legitimate in local development, where the
 * console is served over plain HTTP and a `Secure` cookie would simply never be
 * sent. In production the same setting means the operator session token — the
 * credential that approves what this site publishes about named people — is
 * transmitted in the clear.
 *
 * The security review on 2026-08-16 found this override had no guard. It also
 * found the variable is set nowhere in `deploy/` or `.gitea/`, so production
 * falls through to the `NODE_ENV` default and is secure today. This suite pins
 * the guard against the future edit that would change that, and pins the
 * development behaviour so the guard cannot be "fixed" by removing the escape
 * hatch developers rely on.
 */

const KEYS = ["SESSION_COOKIE_SECURE", "NODE_ENV"] as const;

let saved: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  saved = {};
  for (const key of KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("cookieSecure", () => {
  it("refuses to downgrade in production", () => {
    setEnv({ NODE_ENV: "production", SESSION_COOKIE_SECURE: "false" });
    assert.throws(
      () => cookieSecure(),
      /refusing to issue an operator session cookie without the Secure flag/,
      "a production deployment configured to drop Secure must fail loudly. Honouring it " +
        "puts the operator's session token on the wire in plain text; ignoring it silently " +
        "leaves the configuration lying about the deployment.",
    );
  });

  it("still allows the downgrade outside production, which is what it is for", () => {
    setEnv({ NODE_ENV: "development", SESSION_COOKIE_SECURE: "false" });
    assert.equal(
      cookieSecure(),
      false,
      "local development over plain HTTP is the reason this variable exists. A guard " +
        "that also broke development would be removed, and then it would guard nothing.",
    );
  });

  it("defaults to secure in production when the variable is unset", () => {
    setEnv({ NODE_ENV: "production", SESSION_COOKIE_SECURE: undefined });
    assert.equal(cookieSecure(), true);
  });

  it("defaults to insecure outside production when the variable is unset", () => {
    setEnv({ NODE_ENV: "development", SESSION_COOKIE_SECURE: undefined });
    assert.equal(cookieSecure(), false);
  });

  it("honours an explicit true in either environment", () => {
    setEnv({ NODE_ENV: "development", SESSION_COOKIE_SECURE: "true" });
    assert.equal(cookieSecure(), true);
    setEnv({ NODE_ENV: "production", SESSION_COOKIE_SECURE: "true" });
    assert.equal(cookieSecure(), true);
  });

  it("treats an unrecognised value as unset rather than as false", () => {
    setEnv({ NODE_ENV: "production", SESSION_COOKIE_SECURE: "yes" });
    assert.equal(
      cookieSecure(),
      true,
      "a typo must not be read as a request to drop Secure. Anything that is not " +
        "exactly 'true' or 'false' falls through to the NODE_ENV default, which in " +
        "production is secure.",
    );
  });
});

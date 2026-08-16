import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";

/**
 * Roadmap 6.4: nginx owns the security headers, not this backend.
 *
 * `docs/superpowers/specs/2026-08-16-security-review.md` findings 1-2:
 * `GET /api/health` in production carried two `X-Frame-Options`, two
 * `Referrer-Policy`, two `Content-Security-Policy` and no
 * `strict-transport-security` on the HTML document at all — Helmet's set on
 * top of frontend/nginx.conf's set, disagreeing on every value, and nginx is
 * the only layer that sits in front of BOTH the document and `/api/*`.
 *
 * This process can only see its own half of that duplication — the in-process
 * supertest client never goes near nginx — so what it proves is the half that
 * regresses silently: that Helmet has stopped emitting the five headers nginx
 * now owns exclusively, while still emitting the ones nginx does not set.
 * frontend/nginx-security-headers.test.ts covers the other half, reading
 * nginx.conf itself off disk.
 */

after(async () => {
  await db.destroy();
});

describe("Helmet no longer duplicates the headers nginx owns", () => {
  it("does not emit Content-Security-Policy, Referrer-Policy, X-Frame-Options, X-Content-Type-Options or HSTS", async () => {
    const response = await request(app).get("/api/health");

    for (const header of [
      "content-security-policy",
      "referrer-policy",
      "x-frame-options",
      "x-content-type-options",
      "strict-transport-security",
    ]) {
      assert.equal(
        response.headers[header],
        undefined,
        `expected Helmet to no longer set ${header} — nginx owns it now — but the ` +
          `backend response still carried "${response.headers[header]}"`,
      );
    }
  });

  it("still emits the headers only Helmet sets, which nginx does not touch", async () => {
    const response = await request(app).get("/api/health");

    assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(response.headers["origin-agent-cluster"], "?1");
    assert.equal(response.headers["x-dns-prefetch-control"], "off");
    assert.equal(response.headers["x-download-options"], "noopen");
    assert.equal(response.headers["x-permitted-cross-domain-policies"], "none");
    assert.equal(response.headers["x-xss-protection"], "0");
    assert.equal(
      response.headers["x-powered-by"],
      undefined,
      "Helmet's X-Powered-By removal is unrelated to the nginx handoff and must stay",
    );
  });
});

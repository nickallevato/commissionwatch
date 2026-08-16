import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";

/**
 * A miss on the API answers in JSON, not in HTML.
 *
 * Found during the 2026-08-16 design review by probing production:
 * `GET /api/officials` returned `Content-Type: text/html` carrying Express's
 * default error page — `<title>Error</title>` and
 * `<pre>Cannot GET /api/officials</pre>`. So did `/api/officials/` and
 * `/api/nonexistent`.
 *
 * This project publishes an open-data export, RSS and Atom feeds, an MCP
 * endpoint and a `/bot` page explaining to crawlers how to consume it. Handing
 * a JSON client an HTML document on a mistyped path produces a parse error, and
 * a parse error names the wrong problem: the client learns its parser failed,
 * not that the path was wrong.
 *
 * The inconsistency was internal, which is what makes it worth a test rather
 * than a note. Routers that handle their own miss already answered correctly —
 * `/api/data/nope.csv` returns JSON listing the valid datasets — so two callers
 * mistyping two paths got two different content types from the same API.
 *
 * The `/api/officials` case is the useful regression to keep: it is not a
 * nonsense path but a **plausible** one. `/officials/:id` exists, so a client
 * reasonably tries the collection, and the collection is not implemented.
 */

after(async () => {
  await db.destroy();
});

const MISSES = [
  { path: "/api/officials", why: "a plausible collection path whose :id route exists" },
  { path: "/api/officials/", why: "the same path with a trailing slash" },
  { path: "/api/nonexistent", why: "an outright unknown endpoint" },
  { path: "/api/meetings/deeply/nested/nonsense", why: "a miss below a real router" },
];

describe("an unmatched /api path", () => {
  for (const { path, why } of MISSES) {
    it(`answers 404 in JSON for ${path} — ${why}`, async () => {
      const response = await request(app).get(path);

      assert.equal(response.status, 404);
      assert.match(
        response.headers["content-type"] ?? "",
        /application\/json/,
        `${path} answered with content-type "${response.headers["content-type"] ?? "(none)"}". ` +
          "An HTML body here gives a JSON client a parse error instead of a 404, and the " +
          "parse error names the wrong problem.",
      );
      assert.equal(typeof response.body.error, "string");
      assert.equal(response.body.statusCode, 404);
    });
  }

  it("does not echo the framework's default error page", async () => {
    const response = await request(app).get("/api/nonexistent");
    const body = JSON.stringify(response.body);
    assert.equal(
      /Cannot GET|<pre>|<html/i.test(body),
      false,
      "the response still carries Express's default page markup, which names the " +
        "framework and reflects the requested path back as HTML.",
    );
  });

  it("names the method, so a wrong verb on a real path is legible", async () => {
    const response = await request(app).delete("/api/nonexistent");
    assert.equal(response.status, 404);
    assert.match(
      String(response.body.error),
      /DELETE/,
      "a client that used the wrong verb should be able to see the verb it used in the " +
        "answer, rather than concluding the path itself does not exist.",
    );
  });

  it("leaves a real endpoint alone", async () => {
    const response = await request(app).get("/api/health");
    assert.equal(
      response.status,
      200,
      "the catch-all is mounted after every router; if a real route now 404s, it is " +
        "shadowing them and the mount order is wrong.",
    );
  });
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { requestContext } from "../src/middleware/requestContext";
import { errorHandler } from "../src/middleware/errorHandler";
import { errorCountsSnapshot, resetErrorCountsForTest } from "../src/services/logging/error-metrics";

/**
 * `middleware/requestContext.ts` and `services/logging/error-metrics.ts`.
 * Roadmap 6.8.
 *
 * Built as its own tiny app rather than importing `../src/app`, the same
 * choice `error-handler.test.ts` makes and for the same reason: the subject is
 * the middleware, not the routes, and reaching it through the full app would
 * mean provoking genuine failures from real routes.
 */

function buildApp(): express.Express {
  const app = express();
  app.use(requestContext);
  app.get("/boom", (_req, _res, next) => next(new Error("kaboom")));
  app.get("/direct-500", (_req, res) => {
    res.status(500).json({ error: "Internal server error", statusCode: 500 });
  });
  app.get("/ok", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  resetErrorCountsForTest();
});

describe("requestContext", () => {
  it("puts a request id on the response and it is a UUID", async () => {
    const res = await request(buildApp()).get("/ok").expect(200);
    const requestId = res.headers["x-request-id"];
    assert.ok(requestId, "no X-Request-Id header on the response");
    assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("logs a 'request' line whose requestId matches the response header, for an errored request", async () => {
    // Captured manually rather than through `silence()`: the assertions need
    // both streams at once, and `silence` only holds one open at a time.
    const original = { log: console.log, error: console.error };
    const infoLines: string[] = [];
    const errorLines: string[] = [];
    console.log = ((line: string) => infoLines.push(line)) as typeof console.log;
    console.error = ((line: string) => errorLines.push(line)) as typeof console.error;

    let res: request.Response;
    try {
      res = await request(buildApp()).get("/boom").expect(500);
    } finally {
      console.log = original.log;
      console.error = original.error;
    }

    const requestId = res.headers["x-request-id"];
    assert.ok(requestId, "no X-Request-Id header on the errored response");

    // The error-handler line: level error, the same requestId.
    const errorLine = errorLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.level === "error");
    assert.ok(errorLine, "errorHandler did not log a structured error line");
    assert.equal(errorLine!.requestId, requestId);
    assert.equal(errorLine!.message, "kaboom");

    // The request summary line: level info (or error's own routing — see
    // requestContext, which always logs via logger.info regardless of status),
    // same requestId, correct status and route.
    const requestLine = infoLines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.message === "request");
    assert.ok(requestLine, "requestContext did not log a 'request' summary line");
    assert.equal(requestLine!.requestId, requestId);
    assert.equal(requestLine!.statusCode, 500);
    assert.equal(requestLine!.route, "/boom");
  });

  it("does not increment the error count for a 200", async () => {
    const original = console.log;
    console.log = (() => undefined) as typeof console.log;
    try {
      await request(buildApp()).get("/ok").expect(200);
    } finally {
      console.log = original;
    }
    const snapshot = errorCountsSnapshot();
    assert.equal(snapshot.byRoute["/ok"], undefined);
  });

  it("increments the error count on a 5xx thrown and handled by errorHandler", async () => {
    const original = console.error;
    console.error = (() => undefined) as typeof console.error;
    try {
      await request(buildApp()).get("/boom").expect(500);
    } finally {
      console.error = original;
    }
    const snapshot = errorCountsSnapshot();
    assert.equal(snapshot.byRoute["/boom"], 1);
    assert.equal(snapshot.total, 1);
  });

  it("increments the error count on a 5xx set directly by a route, not only on a thrown error", async () => {
    await request(buildApp()).get("/direct-500").expect(500);
    const snapshot = errorCountsSnapshot();
    assert.equal(snapshot.byRoute["/direct-500"], 1);
  });

  it("accumulates repeated 5xx responses on the same route", async () => {
    const original = console.error;
    console.error = (() => undefined) as typeof console.error;
    try {
      await request(buildApp()).get("/boom").expect(500);
      await request(buildApp()).get("/boom").expect(500);
      await request(buildApp()).get("/boom").expect(500);
    } finally {
      console.error = original;
    }
    const snapshot = errorCountsSnapshot();
    assert.equal(snapshot.byRoute["/boom"], 3);
  });
});

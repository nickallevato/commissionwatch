import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";
import { errorHandler } from "../src/middleware/errorHandler";

/**
 * What an unhandled exception is allowed to tell a stranger.
 *
 * This module had **no test references anywhere** until now, which is a poor
 * place for a gap on a site whose entire value is not publishing things it
 * should not. A stack trace, a connection string or a Granicus URL carrying a
 * meeting title in its query string are all one `throw` away from a response
 * body, and nothing asserted otherwise.
 *
 * The tests build their own tiny Express app rather than importing `../src/app`:
 * the subject is the middleware, and reaching it through the real app would
 * mean provoking a genuine 500 from a route, which tests the route.
 */

function appThatThrows(err: unknown): express.Express {
  const app = express();
  app.get("/boom", (_req, _res, next) => next(err));
  app.use(errorHandler);
  return app;
}

/**
 * Silences the deliberate console.error on the 500 path.
 *
 * `await`, not `.finally()`. Supertest's Test is a thenable rather than a real
 * promise, and chaining `.finally` on it never settles — the first version of
 * this helper hung every 500 test in the file, and only the 500 tests, which is
 * what made it look like the middleware rather than the harness.
 */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const restore = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = restore;
  }
}

after(() => {
  mock.restoreAll();
});

describe("the error handler", () => {
  it("never returns the message of a 500 to the caller", async () => {
    const err = new Error("connect ECONNREFUSED 10.0.0.4:5432 password=hunter2");

    const res = await quiet(() => request(appThatThrows(err)).get("/boom").expect(500));

    assert.equal(res.body.error, "Internal server error");
    assert.equal(res.body.statusCode, 500);
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes("hunter2"), "a credential reached the response body");
    assert.ok(!body.includes("10.0.0.4"), "an internal address reached the response body");
  });

  it("never returns a stack trace", async () => {
    const err = new Error("kaboom");

    const res = await quiet(() => request(appThatThrows(err)).get("/boom").expect(500));

    const body = JSON.stringify(res.body);
    assert.ok(!body.includes("at "), "a stack frame reached the response body");
    assert.ok(!("stack" in res.body), "the error object was serialised whole");
  });

  it("passes a deliberate 4xx message through, because those are ours", async () => {
    const err = Object.assign(new Error("Invalid meeting_id format"), { statusCode: 400 });

    const res = await request(appThatThrows(err)).get("/boom").expect(400);

    assert.equal(res.body.error, "Invalid meeting_id format");
    assert.equal(res.body.statusCode, 400);
  });

  it("still logs the 500 server-side — silence would be the worse failure", async () => {
    const restore = console.error;
    let logged = 0;
    console.error = () => {
      logged += 1;
    };
    try {
      await request(appThatThrows(new Error("kaboom"))).get("/boom").expect(500);
    } finally {
      console.error = restore;
    }

    assert.equal(logged, 1, "a 500 was answered without being logged anywhere");
  });

  it("does not log a 4xx, which is the caller's mistake and not an incident", async () => {
    const restore = console.error;
    let logged = 0;
    console.error = () => {
      logged += 1;
    };
    try {
      const err = Object.assign(new Error("bad request"), { statusCode: 400 });
      await request(appThatThrows(err)).get("/boom").expect(400);
    } finally {
      console.error = restore;
    }

    assert.equal(logged, 0);
  });

  it("treats a non-Error throw as a 500 rather than crashing on it", async () => {
    const res = await quiet(() =>
      request(appThatThrows("a bare string" as unknown)).get("/boom").expect(500),
    );

    assert.equal(res.body.error, "Internal server error");
  });

  it("ignores a statusCode outside the range HTTP has", async () => {
    // `res.status(1200)` throws a RangeError inside the handler, which would
    // surface as a socket hang-up rather than a response. A nonsense status on
    // the error is still an error, so it is answered as one.
    const err = Object.assign(new Error("odd"), { statusCode: 1200 });

    const res = await quiet(() => request(appThatThrows(err)).get("/boom").expect(500));

    assert.equal(res.body.statusCode, 500);
  });

  /**
   * The one real defect this file was written to catch.
   *
   * A route that has already begun writing — a bulk export, the sitemap — and
   * then throws leaves `res.headersSent` true. `res.status()` throws in that
   * state, so the old code turned a handled error into an unhandled one
   * *inside the error handler*, and the caller got a truncated body with a 200
   * already on it. Express's own final handler delegates here, and so must
   * this one.
   *
   * Driven directly rather than over HTTP. The honest version of this scenario
   * leaves a response that is never ended, so a supertest request waits for a
   * body that is not coming and the whole file hangs — which it did, on the
   * first run. The assertion is about what the middleware *does*, and calling
   * it is the way to see that without a socket in the way.
   */
  it("delegates instead of throwing when the response has already started", () => {
    const calls: unknown[] = [];
    const res = {
      headersSent: true,
      status() {
        throw new Error("Cannot set headers after they are sent to the client");
      },
      json() {
        throw new Error("json() must not be reached either");
      },
    } as unknown as Response;

    const err = new Error("threw after the first byte");

    assert.doesNotThrow(() => {
      errorHandler(err, {} as Request, res, ((e: unknown) => {
        calls.push(e);
      }) as NextFunction);
    });

    assert.deepEqual(calls, [err], "the error was swallowed rather than delegated");
  });

  it("writes the response itself when headers have not gone out", () => {
    let status = 0;
    let body: unknown = null;
    const res = {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Response;

    const err = Object.assign(new Error("Invalid meeting_id format"), { statusCode: 400 });
    errorHandler(err, {} as Request, res, (() => {
      throw new Error("must not delegate when it can answer");
    }) as NextFunction);

    assert.equal(status, 400);
    assert.deepEqual(body, { error: "Invalid meeting_id format", statusCode: 400 });
  });
});

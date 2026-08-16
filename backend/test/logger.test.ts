import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../src/services/logging/logger";

/**
 * `services/logging/logger.ts` — one structured logger, JSON lines to
 * stdout/stderr. Roadmap 6.8.
 *
 * These tests are about the contract every reader of the container's stdout
 * depends on: every line is `JSON.parse`-able, carries `level`, `message` and
 * `timestamp`, and structured fields survive the round trip. A logger that
 * silently produced an unparseable line on some input would be worse than
 * `console.log`, which at least never claimed to be structured.
 */

function captureConsole<T>(method: "log" | "warn" | "error", run: () => T): { result: T; lines: string[] } {
  const original = console[method];
  const lines: string[] = [];
  console[method] = ((line: string) => {
    lines.push(line);
  }) as typeof console.log;
  try {
    return { result: run(), lines };
  } finally {
    console[method] = original;
  }
}

after(() => {
  // Nothing to tear down beyond what captureConsole already restores per call,
  // but a stray reassignment in a failed assertion should not leak into later
  // files in the same run.
});

describe("the structured logger", () => {
  it("emits parseable JSON on info, with level, message and timestamp", () => {
    const { lines } = captureConsole("log", () => logger.info("hello"));
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.level, "info");
    assert.equal(parsed.message, "hello");
    assert.equal(typeof parsed.timestamp, "string");
    assert.ok(!Number.isNaN(Date.parse(parsed.timestamp as string)), "timestamp is not a valid date string");
  });

  it("routes warn and error to console.warn and console.error respectively", () => {
    const warnCapture = captureConsole("warn", () => logger.warn("careful"));
    const parsedWarn = JSON.parse(warnCapture.lines[0]) as Record<string, unknown>;
    assert.equal(parsedWarn.level, "warn");

    const errorCapture = captureConsole("error", () => logger.error("broken"));
    const parsedError = JSON.parse(errorCapture.lines[0]) as Record<string, unknown>;
    assert.equal(parsedError.level, "error");
  });

  it("merges arbitrary structured fields onto the line", () => {
    const { lines } = captureConsole("log", () =>
      logger.info("request", { requestId: "abc-123", route: "/api/matters/:id", statusCode: 200 }),
    );
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.requestId, "abc-123");
    assert.equal(parsed.route, "/api/matters/:id");
    assert.equal(parsed.statusCode, 200);
  });

  it("serialises an Error field as name/message/stack instead of the empty object JSON.stringify would produce", () => {
    const { lines } = captureConsole("error", () =>
      logger.error("stage failed", { error: new Error("connect ECONNREFUSED") }),
    );
    const parsed = JSON.parse(lines[0]) as { error: { name: string; message: string; stack: string } };
    assert.equal(parsed.error.name, "Error");
    assert.equal(parsed.error.message, "connect ECONNREFUSED");
    assert.equal(typeof parsed.error.stack, "string");
  });

  it("serialises a bigint field rather than throwing", () => {
    assert.doesNotThrow(() => {
      captureConsole("log", () => logger.info("counted", { total: 9007199254740993n }));
    });
  });

  it("is assignable to the narrower { info(message): void; warn(message): void } shape openrouter.ts injects", () => {
    // Compile-time assertion as much as a runtime one: if this stops
    // type-checking, the logger has stopped being a drop-in replacement for
    // every existing `logger?: { info(message: string): void; warn(...): void }`
    // injection point.
    const narrow: { info(message: string): void; warn(message: string): void } = logger;
    assert.doesNotThrow(() => captureConsole("log", () => narrow.info("still works")));
  });
});

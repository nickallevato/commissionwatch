import assert from "node:assert/strict";

/**
 * A very small `expect` over `node:assert/strict`.
 *
 * The adapter contract suite and the Gallatin suite arrived from
 * `agents/meeting-monitor`, where they ran under vitest and had never been
 * executed by CI — the Gitea workflow builds `backend` and `frontend` only.
 * Moving the adapter into the backend without moving its 68 tests would have
 * repeated the exact defect that once left four suites and 135 tests unrun in
 * this repo.
 *
 * So the tests moved verbatim and this shim implements the bounded set of
 * matchers they actually use, rather than adding vitest as a second test runner
 * to a package that already has one. Every matcher below appears in those
 * files; nothing here is speculative surface.
 */

export interface Matchers<T> {
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toMatch(expected: RegExp | string): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeInstanceOf(expected: Function): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toThrow(expected?: RegExp | string): void;
}

export interface Expectation<T> extends Matchers<T> {
  readonly not: Matchers<T>;
  readonly rejects: {
    toThrow(expected?: RegExp | string): Promise<void>;
    toBeInstanceOf(expected: Function): Promise<void>;
  };
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof RegExp) return value.toString();
  if (typeof value === "function") return value.name || "(anonymous function)";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function check(negated: boolean, passed: boolean, message: string): void {
  if (negated ? !passed : passed) return;
  assert.fail(negated ? `expected NOT: ${message}` : `expected: ${message}`);
}

function lengthOf(actual: unknown): number {
  if (typeof actual === "string") return actual.length;
  if (Array.isArray(actual)) return actual.length;
  if (
    typeof actual === "object" &&
    actual !== null &&
    "length" in actual &&
    typeof (actual as { length: unknown }).length === "number"
  ) {
    return (actual as { length: number }).length;
  }
  assert.fail(`${describeValue(actual)} has no numeric length`);
}

function deepEquals(actual: unknown, expected: unknown): boolean {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

function throwsMatching(thrown: unknown, expected: RegExp | string | undefined): boolean {
  if (expected === undefined) return true;
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return expected instanceof RegExp ? expected.test(message) : message.includes(expected);
}

function matchers<T>(actual: T, negated: boolean): Matchers<T> {
  return {
    toBe(expected) {
      check(negated, Object.is(actual, expected), `${describeValue(actual)} to be ${describeValue(expected)}`);
    },
    toEqual(expected) {
      check(
        negated,
        deepEquals(actual, expected),
        `${describeValue(actual)} to deep-equal ${describeValue(expected)}`,
      );
    },
    toMatch(expected) {
      const text = String(actual);
      const passed = expected instanceof RegExp ? expected.test(text) : text.includes(expected);
      check(negated, passed, `${describeValue(text)} to match ${describeValue(expected)}`);
    },
    toContain(expected) {
      let passed: boolean;
      if (typeof actual === "string") {
        passed = actual.includes(String(expected));
      } else if (Array.isArray(actual)) {
        passed = actual.some((item) => Object.is(item, expected) || deepEquals(item, expected));
      } else if (actual instanceof Set) {
        // The contract suite builds Sets of declared origins and body keys and
        // asks whether a value is among them.
        passed = actual.has(expected) || [...actual].some((item) => deepEquals(item, expected));
      } else {
        assert.fail(`${describeValue(actual)} is neither a string, an array nor a Set`);
      }
      check(negated, passed, `${describeValue(actual)} to contain ${describeValue(expected)}`);
    },
    toHaveLength(expected) {
      check(negated, lengthOf(actual) === expected, `length ${lengthOf(actual)} to be ${expected}`);
    },
    toBeNull() {
      check(negated, actual === null, `${describeValue(actual)} to be null`);
    },
    toBeUndefined() {
      check(negated, actual === undefined, `${describeValue(actual)} to be undefined`);
    },
    toBeDefined() {
      check(negated, actual !== undefined, `${describeValue(actual)} to be defined`);
    },
    toBeInstanceOf(expected) {
      check(
        negated,
        actual instanceof (expected as new (...args: never[]) => unknown),
        `${describeValue(actual)} to be an instance of ${describeValue(expected)}`,
      );
    },
    toBeGreaterThan(expected) {
      check(negated, Number(actual) > expected, `${describeValue(actual)} to be > ${expected}`);
    },
    toBeGreaterThanOrEqual(expected) {
      check(negated, Number(actual) >= expected, `${describeValue(actual)} to be >= ${expected}`);
    },
    toBeLessThan(expected) {
      check(negated, Number(actual) < expected, `${describeValue(actual)} to be < ${expected}`);
    },
    toBeLessThanOrEqual(expected) {
      check(negated, Number(actual) <= expected, `${describeValue(actual)} to be <= ${expected}`);
    },
    toThrow(expected) {
      if (typeof actual !== "function") {
        assert.fail(`toThrow expects a function, got ${describeValue(actual)}`);
      }
      let thrown: unknown;
      let threw = false;
      try {
        (actual as () => unknown)();
      } catch (error) {
        threw = true;
        thrown = error;
      }
      check(
        negated,
        threw && throwsMatching(thrown, expected),
        expected === undefined ? "the call to throw" : `the call to throw matching ${describeValue(expected)}`,
      );
    },
  };
}

export function expect<T>(actual: T): Expectation<T> {
  const positive = matchers(actual, false);
  const rejection = async (): Promise<unknown> => {
    const awaited = await Promise.resolve(actual).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (awaited.ok) {
      assert.fail(`expected: the promise to reject, but it resolved with ${describeValue(awaited.value)}`);
    }
    return awaited.error;
  };

  return {
    ...positive,
    not: matchers(actual, true),
    rejects: {
      async toThrow(expected) {
        const error = await rejection();
        if (!throwsMatching(error, expected)) {
          assert.fail(
            `expected: the rejection to match ${describeValue(expected)}, got ${describeValue(
              error instanceof Error ? error.message : error,
            )}`,
          );
        }
      },
      async toBeInstanceOf(expected) {
        const error = await rejection();
        if (!(error instanceof (expected as new (...args: never[]) => unknown))) {
          assert.fail(
            `expected: the rejection to be an instance of ${describeValue(expected)}, got ${describeValue(
              error instanceof Error ? `${error.name}: ${error.message}` : error,
            )}`,
          );
        }
      },
    },
  };
}

/**
 * One structured logger. JSON lines to stdout/stderr, nothing else.
 *
 * ## Why this exists
 *
 * Nothing in this codebase could answer "how many 500s did we serve
 * yesterday, on which route" — 38 files logged with raw `console.*`, each
 * line a free-form string with no consistent field to grep or aggregate.
 * Docker and journald already collect and rotate container stdout, so the
 * fix is not a log *shipper* — it is making the lines the container already
 * produces machine-readable. Roadmap 6.8.
 *
 * ## Why no dependency
 *
 * This project deliberately avoids them: `external-monitor.ts` is
 * import-free by design, `workflow-monitor-env.test.ts` reads YAML as text
 * rather than add a parser, and 6.2 just added a supply-chain audit gate. A
 * logger that JSON-encodes one object and writes one line is not a problem
 * pino or winston solve better than fifteen lines here do, and every
 * dependency added is a package `npm audit` has to keep clearing.
 *
 * ## Shape
 *
 * `debug`/`info`/`warn`/`error` each take a message and an optional bag of
 * structured fields. This is a strict superset of the `{ info(message):
 * void; warn(message): void }` and `{ info; warn; error }` shapes already
 * injected throughout `services/ingestion/` and `services/extraction/
 * openrouter.ts` — an extra optional parameter does not break an existing
 * call site, so this logger can be handed to any of those constructors
 * unchanged. See `docs/STATUS.md` (structured logging entry) for the
 * migration convention: convert a call site when you next touch it for
 * another reason, passing whatever fields are already in scope (a source id,
 * a run id, a request id) instead of interpolating them into the message
 * string. Do not do a mechanical sweep of the remaining `console.*` calls in
 * one change — see the roadmap 6.8 note for why.
 *
 * ## Fields, not string interpolation
 *
 * `logger.warn(\`sweep ${runId} of ${sourceId} failed\`)` is legible to a
 * person and useless to a query — "every failed sweep of gallatin-civicplus
 * in the last day" cannot be answered without parsing the sentence back
 * apart. `logger.warn("sweep failed", { runId, sourceId })` keeps the same
 * sentence for a person reading the raw line and gives a machine a field to
 * filter on. New call sites should prefer fields; a message combining both is
 * not wrong, just less useful than it could be.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Arbitrary structured context attached to one log line. Never a function or a class instance — this is serialised straight to JSON. */
export type LogFields = Record<string, unknown>;

export interface StructuredLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Reduce a field bag to something `JSON.stringify` renders faithfully.
 *
 * Two shapes recur at call sites and both defeat plain `JSON.stringify`
 * silently rather than loudly: an `Error` serialises to `{}` (its message and
 * stack are non-enumerable), and a `bigint` throws instead of serialising at
 * all. Everything else passes through unchanged — this is a safety net for
 * the two known traps, not a general sanitiser.
 */
function normalise(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message, stack: value.stack };
    } else if (typeof value === "bigint") {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
  const line = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(fields ? normalise(fields) : {}),
  };
  const rendered = JSON.stringify(line);
  // `console.*` on purpose, and looked up at call time rather than cached: it
  // is the layer Node actually writes stdout/stderr through, and every
  // existing test that silences the 500-path log does so by reassigning
  // `console.error` — routing through anything else would stop being
  // silenceable by that convention.
  if (level === "error") console.error(rendered);
  else if (level === "warn") console.warn(rendered);
  else console.log(rendered);
}

/**
 * The process-wide logger. Stateless beyond the level routing above, so
 * there is nothing to construct — every caller shares this one instance,
 * the same way `db` in `config/database.ts` is a shared, module-level export
 * rather than something each service builds for itself.
 */
export const logger: StructuredLogger = {
  debug: (message, fields) => write("debug", message, fields),
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};

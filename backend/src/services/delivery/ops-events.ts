import type { EventPayload } from "./dispatcher";

/**
 * Operational events — things the machinery says about itself, as opposed to
 * things it says about a public record.
 *
 * They go through the same `DeliveryDispatcher` as everything else on purpose.
 * A backup that reports its own failure down a second, private path is a backup
 * whose failure notification nobody has ever tested; routing it through the
 * dispatcher means it uses the channels an operator already configured and
 * already trusts.
 *
 * The list is closed. `deploy/backup.sh` passes an event name in on the command
 * line, and a typo must be a refusal rather than a delivery row nobody routes.
 */
export const OPS_EVENTS = [
  "ops.backup_succeeded",
  "ops.backup_failed",
  "ops.restore_drill_succeeded",
  "ops.restore_drill_failed",
] as const;

export type OpsEvent = (typeof OPS_EVENTS)[number];

export function asOpsEvent(value: unknown): OpsEvent | null {
  const found = OPS_EVENTS.filter((event) => event === value);
  return found[0] ?? null;
}

export interface OpsEventArgs {
  event: OpsEvent;
  detail: string;
  source: string;
  severity: string;
}

/**
 * Reads `--flag value` pairs.
 *
 * A failure is `critical` by default and a success is `low`, because the window
 * a missed backup opens only widens: the operator needs to hear about the one
 * immediately and the other in a digest, if at all.
 */
export function parseOpsEventArgs(argv: readonly string[]): OpsEventArgs {
  const raw = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`expected a --flag, got '${flag}'`);
    }
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    raw.set(flag.slice(2), value);
  }

  const eventName = raw.get("event");
  if (eventName === undefined) throw new Error("--event is required");
  const event = asOpsEvent(eventName);
  if (event === null) {
    throw new Error(`--event must be one of ${OPS_EVENTS.join(", ")}, got '${eventName}'`);
  }

  return {
    event,
    detail: raw.get("detail") ?? "",
    source: raw.get("source") ?? "ops",
    severity: raw.get("severity") ?? (event.endsWith("_failed") ? "critical" : "low"),
  };
}

export function opsEventPayload(args: OpsEventArgs, host: string): EventPayload {
  return { detail: args.detail, source: args.source, host };
}

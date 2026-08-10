import { severityLabels, severityRank } from "@/components/severity";
import type { AnomalySeverity } from "@/types";

/**
 * Square fill plus numeral colour. Written as whole literal class names so the
 * Tailwind content scanner keeps them. Numeral contrast against each fill:
 * paper on sev4/sev5 ≈ 6.0:1, ink on sev3 ≈ 5.8:1, ink on sev2 ≈ 4.9:1.
 */
const severitySquare: Record<AnomalySeverity, string> = {
  critical: "bg-sev5 text-paper",
  high: "bg-sev4 text-paper",
  medium: "bg-sev3 text-ink",
  low: "bg-sev2 text-ink",
};

interface SeverityMarkProps {
  severity: AnomalySeverity;
  /** `md` for a ledger entry, `sm` for inline chrome such as a list row. */
  size?: "sm" | "md";
}

/**
 * The severity square: a solid block of the severity colour with its rank
 * printed inside it.
 */
export function SeverityMark({ severity, size = "md" }: SeverityMarkProps) {
  const rank = severityRank[severity];
  const dims =
    size === "md" ? "h-7 w-7 text-[0.8125rem]" : "h-4 w-4 text-[0.625rem]";

  return (
    <span
      className={`figure inline-flex shrink-0 items-center justify-center font-semibold leading-none ${dims} ${severitySquare[severity]}`}
      title={`Severity ${rank} of 5 — ${severityLabels[severity]}`}
    >
      <span aria-hidden="true">{rank}</span>
      <span className="sr-only">
        Severity {rank} of 5, {severityLabels[severity].toLowerCase()}
      </span>
    </span>
  );
}

interface Props {
  count: number;
  maxSeverity: AnomalySeverity;
}

/**
 * Inline tally of the flags raised against one record: the highest severity as
 * a square, then how many entries sit behind it.
 */
export function AnomalyBadge({ count, maxSeverity }: Props) {
  if (count === 0) return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <SeverityMark severity={maxSeverity} size="sm" />
      <span className="figure text-xs leading-none text-ink">{count}</span>
      <span className="label-sm">{count === 1 ? "flag" : "flags"}</span>
    </span>
  );
}

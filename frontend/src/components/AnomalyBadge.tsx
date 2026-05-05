import type { AnomalySeverity } from "@/types";

const severityStyles: Record<AnomalySeverity, string> = {
  critical: "bg-red-500/10 text-red-400 border-red-500/20",
  high: "bg-red-500/10 text-red-400 border-red-500/20",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  low: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

interface Props {
  count: number;
  maxSeverity: AnomalySeverity;
}

export function AnomalyBadge({ count, maxSeverity }: Props) {
  if (count === 0) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${severityStyles[maxSeverity]}`}
    >
      <AlertTriangleIcon />
      {count}
    </span>
  );
}

function AlertTriangleIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
    </svg>
  );
}

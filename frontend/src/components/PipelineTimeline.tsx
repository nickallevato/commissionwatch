import type { PipelineSegment } from "../types/hub";

interface PipelineTimelineProps {
  segments: PipelineSegment[];
  closeDate?: string;
}

export function PipelineTimeline({ segments, closeDate }: PipelineTimelineProps) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <svg className="w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="text-sm font-medium text-gray-200">Pipeline</span>
        {closeDate && (
          <span className="ml-auto text-xs text-gray-500">{closeDate}</span>
        )}
      </div>
      <div className="px-4 py-4">
        <div className="flex gap-1">
          {segments.map((seg) => (
            <div key={seg.label} className="flex-1 flex flex-col items-center gap-2">
              <div className="relative w-full h-2 rounded-full overflow-hidden">
                {seg.state === "done" && (
                  <div className="absolute inset-0 bg-green-700/70 rounded-full" />
                )}
                {seg.state === "current" && (
                  <div className="absolute inset-0 bg-amber-500/70 rounded-full">
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-amber-300 animate-pulse-dot" />
                  </div>
                )}
                {seg.state === "upcoming" && (
                  <div className="absolute inset-0 bg-white/10 rounded-full" />
                )}
              </div>
              <span
                className={`text-[10px] font-medium ${
                  seg.state === "done"
                    ? "text-green-400/80"
                    : seg.state === "current"
                      ? "text-amber-400"
                      : "text-gray-500"
                }`}
              >
                {seg.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

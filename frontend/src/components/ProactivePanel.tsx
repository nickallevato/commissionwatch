import { useNavigate } from "react-router-dom";
import type { Signal, SignalPriority } from "../types/hub";

const PRIORITY_STYLES: Record<SignalPriority, { bg: string; hoverBg: string; icon: string }> = {
  critical: {
    bg: "bg-red-900/20",
    hoverBg: "hover:bg-red-900/30",
    icon: "text-red-400",
  },
  warn: {
    bg: "bg-amber-900/20",
    hoverBg: "hover:bg-amber-900/30",
    icon: "text-amber-400",
  },
  info: {
    bg: "bg-slate-700/20",
    hoverBg: "hover:bg-slate-700/30",
    icon: "text-slate-400",
  },
};

function PriorityIcon({ priority }: { priority: SignalPriority }) {
  const color = PRIORITY_STYLES[priority].icon;
  if (priority === "critical") {
    return (
      <svg className={`w-4 h-4 ${color}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  if (priority === "warn") {
    return (
      <svg className={`w-4 h-4 ${color}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );
  }
  return (
    <svg className={`w-4 h-4 ${color}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

interface ProactivePanelProps {
  signals: Signal[];
}

export function ProactivePanel({ signals }: ProactivePanelProps) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <svg className="w-3.5 h-3.5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
        <span className="text-sm font-medium text-gray-200">
          Proactive — needs attention
        </span>
        <button className="ml-auto text-xs text-gray-500 hover:text-gray-300 transition-colors">
          View all
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {signals.map((signal) => {
          const styles = PRIORITY_STYLES[signal.priority];
          return (
            <button
              key={signal.id}
              onClick={() => navigate(signal.ctaTarget)}
              className={`w-full text-left px-4 py-3 flex gap-3 border-b border-white/5 transition-colors ${styles.bg} ${styles.hoverBg}`}
            >
              <div className="mt-0.5 flex-shrink-0">
                <PriorityIcon priority={signal.priority} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-100 leading-tight">
                  {signal.title}
                </div>
                <div className="text-xs text-gray-400 mt-1 line-clamp-2">
                  {signal.description}
                </div>
                <div className="flex items-center gap-1.5 mt-2 text-xs text-gray-500">
                  <span className="px-1.5 py-0.5 rounded bg-white/5 text-gray-400 font-medium">
                    {signal.agent}
                  </span>
                  <span>·</span>
                  <span>{signal.time}</span>
                  <span className="ml-auto text-amber-400/80 font-medium">
                    {signal.ctaLabel} →
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

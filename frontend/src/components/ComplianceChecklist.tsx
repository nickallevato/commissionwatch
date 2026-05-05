import type { ComplianceItem } from "../types/hub";

interface ComplianceChecklistProps {
  items: ComplianceItem[];
}

export function ComplianceChecklist({ items }: ComplianceChecklistProps) {
  const doneCount = items.filter((item) => item.done).length;
  const pct = items.length > 0 ? (doneCount / items.length) * 100 : 0;

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <svg className="w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <span className="text-sm font-medium text-gray-200">
          Compliance · {doneCount}/{items.length}
        </span>
      </div>
      <div className="px-4 py-3 space-y-3">
        <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-green-600/80 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="space-y-1">
          {items.map((item) => (
            <div
              key={item.id}
              className={`flex items-start gap-2.5 py-1.5 ${
                item.done ? "opacity-60" : ""
              }`}
            >
              <div
                className={`mt-0.5 w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border ${
                  item.done
                    ? "bg-green-700/50 border-green-600/50"
                    : "border-white/20 bg-white/5"
                }`}
              >
                {item.done && (
                  <svg
                    className="w-2.5 h-2.5 text-green-300"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className={`text-xs ${
                    item.done
                      ? "text-gray-400 line-through"
                      : "text-gray-200"
                  }`}
                >
                  {item.label}
                </div>
                {!item.done && item.dueDate && (
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    Due {item.dueDate}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

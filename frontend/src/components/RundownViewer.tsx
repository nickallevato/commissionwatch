import type { RundownSheet } from "@/types";

const priorityStyles = {
  high: "border-l-red-400",
  medium: "border-l-amber-400",
  low: "border-l-green-400",
};

export function RundownViewer({ rundown }: { rundown: RundownSheet }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-800/50 p-6">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-accent-400">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
          </svg>
        </span>
        <h3 className="text-lg font-semibold text-gray-100">
          Meeting Rundown
        </h3>
        {rundown.generated_at && (
          <span className="text-xs text-gray-500 ml-auto">
            Generated{" "}
            {new Date(rundown.generated_at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
          </span>
        )}
      </div>

      {rundown.summary && (
        <p className="text-gray-300 text-sm leading-relaxed mb-5">
          {rundown.summary}
        </p>
      )}

      {rundown.key_items && rundown.key_items.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Key Items
          </h4>
          {rundown.key_items.map((item, idx) => (
            <div
              key={idx}
              className={`border-l-2 ${
                item.priority ? priorityStyles[item.priority] : "border-l-gray-600"
              } pl-4 py-2`}
            >
              <div className="flex items-center gap-2">
                <h5 className="text-gray-200 font-medium text-sm">
                  {item.title}
                </h5>
                {item.priority && (
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    item.priority === "high"
                      ? "bg-red-500/10 text-red-400"
                      : item.priority === "medium"
                        ? "bg-amber-500/10 text-amber-400"
                        : "bg-green-500/10 text-green-400"
                  }`}>
                    {item.priority}
                  </span>
                )}
              </div>
              <p className="text-gray-400 text-sm mt-1">{item.description}</p>
              {item.category && (
                <span className="inline-block mt-1.5 text-xs text-gray-500">
                  {item.category}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

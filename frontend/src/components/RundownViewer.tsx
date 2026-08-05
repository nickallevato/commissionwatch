import type { RundownKeyItem, RundownSheet } from "@/types";

type Priority = NonNullable<RundownKeyItem["priority"]>;

/** Priority reads on the severity ramp: high is the accent, low is grey. */
const priorityRule: Record<Priority, string> = {
  high: "border-sev4",
  medium: "border-sev3",
  low: "border-sev2",
};

const priorityText: Record<Priority, string> = {
  high: "text-sev4",
  medium: "text-sev3",
  low: "text-sev2",
};

function formatGenerated(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function RundownViewer({ rundown }: { rundown: RundownSheet }) {
  const generated = rundown.generated_at
    ? formatGenerated(rundown.generated_at)
    : null;
  const keyItems = rundown.key_items ?? [];

  if (!rundown.summary && keyItems.length === 0) return null;

  return (
    <section aria-labelledby="rundown-heading">
      <div className="rule-hi" />
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pt-3">
        <div>
          <span className="kicker">Rundown</span>
          <h2
            id="rundown-heading"
            className="font-display text-2xl leading-headline tracking-headline text-ink"
          >
            Key items in this meeting
          </h2>
        </div>
        {generated && (
          <span className="cite">Compiled from the record · {generated}</span>
        )}
      </div>

      {rundown.summary && (
        <p className="mt-3 max-w-prose font-display text-lg leading-relaxed text-ink-soft">
          {rundown.summary}
        </p>
      )}

      {keyItems.length > 0 && (
        <ul className="mt-5 space-y-4">
          {keyItems.map((item, idx) => (
            <li
              key={`${item.title}-${idx}`}
              className={`border-l-2 pl-4 ${
                item.priority ? priorityRule[item.priority] : "border-rule"
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h4 className="font-sans text-base font-semibold tracking-normal text-ink">
                  {item.title}
                </h4>
                {item.priority && (
                  <span className={`label-sm ${priorityText[item.priority]}`}>
                    {item.priority} priority
                  </span>
                )}
              </div>
              <p className="mt-1 max-w-prose text-sm text-ink-soft">
                {item.description}
              </p>
              {item.category && (
                <span className="label-sm mt-1">{item.category}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

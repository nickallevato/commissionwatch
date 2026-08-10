import { useId, useRef, type ReactNode } from "react";

/**
 * The Pressroom console's presentation layer.
 *
 * The approved mockup (artifact 89b93541, "CommissionWatch — The Pressroom")
 * is the specification for this file, not a reference for it. Everything below
 * is a div, a span or an inline height — the sparklines are `<i>` elements, the
 * stripes are 3px divs, the pills are bordered spans. There is no charting
 * library and no new dependency, because a fourteen-bar strip does not need
 * one and a watchdog site should not ship 80 kB of JavaScript to draw fourteen
 * rectangles.
 *
 * Every colour resolves to a token that already exists in `tailwind.config.ts`.
 * The mockup's `--ok` is `pass`, its `--warn` is `sev3`, its `--fail` and
 * `--accent` are `accent`, its `--fail-wash` is `accent-50`. Its `--rule-firm`
 * and its green and amber washes have no token, so firm borders draw in `rule`
 * and tinted rows take `paper-sunk` — they keep their meaning from the stripe
 * and the pill, which carry text.
 *
 * Accessibility is not decoration here. A status pill always carries its label
 * as text, never colour alone. A sparkline carries a sentence for a screen
 * reader, because a strip of coloured bars is not information. Every control
 * keeps the one focus treatment.
 */

/** The single focus treatment, used by every control in the console. */
export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** The mockup's `.btn` — uppercase, letterspaced, square, hairline. */
export const ACTION =
  "inline-flex items-center border border-ink bg-paper px-3 py-1.5 text-[11px] font-semibold uppercase tracking-label text-ink hover:bg-paper-sunk disabled:opacity-40 disabled:border-dashed disabled:hover:bg-paper";

/** `.btn.primary` — the one action on a screen that changes the world. */
export const ACTION_PRIMARY =
  "inline-flex items-center border border-accent bg-accent px-3 py-1.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-accent-600 disabled:opacity-40 disabled:border-dashed";

/** `.btn.quiet` — present, reachable, not competing. */
export const ACTION_QUIET =
  "inline-flex items-center border border-rule px-3 py-1.5 text-[11px] font-semibold uppercase tracking-label text-muted hover:border-ink hover:text-ink disabled:opacity-40 disabled:border-dashed";

/** `.btn.sm`, appended to any of the three above. */
export const ACTION_SMALL = "px-2 py-1 text-[10px]";

/** `.btnrow` — actions sit on one line and wrap rather than truncate. */
export const ACTION_ROW = "flex flex-wrap items-center gap-2";

/** The mockup's form field face: hairline, paper, mono. */
export const FIELD =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 font-mono text-sm text-ink-soft hover:border-ink";

/**
 * A card on the sunk ground. Hairline rule, no shadow — the elevation is
 * carried by the paper being lighter than the ground, which is how a printed
 * page does it.
 */
export function PressroomCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-rule bg-paper px-5 py-5 sm:px-6 sm:py-6 ${className}`}>
      {children}
    </section>
  );
}

/**
 * The `.work > .title` row: the screen's name, a mono stamp of whatever is
 * true right now, and the double rule that separates chrome from work.
 */
export function WorkTitle({
  title,
  stamp,
  children,
}: {
  title: string;
  stamp?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b-[3px] border-double border-rule pb-2.5">
      <h1 className="font-display text-2xl font-semibold leading-headline tracking-headline text-ink">
        {title}
      </h1>
      {stamp !== undefined && (
        <span className="font-mono text-[11px] text-muted tabular">{stamp}</span>
      )}
      {children}
    </div>
  );
}

/** How a figure reads. `bad` is the failure colour; `plain` is ink. */
export type Tone = "plain" | "good" | "warn" | "bad";

const TONE_TEXT: Record<Tone, string> = {
  plain: "text-ink",
  good: "text-pass",
  warn: "text-sev3",
  bad: "text-accent",
};

/**
 * The four-up stat grid. Two columns on a phone, four from `sm` up, one shared
 * hairline box rather than four floating cards — the mockup draws it as a
 * single ruled block and the ruling is what makes the four figures read as one
 * row of facts.
 */
export function Tiles({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 border-t border-l border-rule sm:grid-cols-4">{children}</div>
  );
}

export function Tile({
  label,
  value,
  sub,
  tone = "plain",
  small = false,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  /** For a word rather than a number — the mockup drops it to sans at 16px. */
  small?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-r border-rule px-3.5 py-3">
      <span className="label-sm">{label}</span>
      <span
        data-testid={testId}
        data-tone={tone}
        className={
          small
            ? `text-base font-semibold leading-tight ${TONE_TEXT[tone]}`
            : `figure text-2xl font-semibold leading-tight ${TONE_TEXT[tone]}`
        }
      >
        {value}
      </span>
      {sub !== undefined && <span className="text-[11.5px] text-muted">{sub}</span>}
    </div>
  );
}

/** One sweep in a sparkline. `none` means no sweep at all, not a short one. */
export type SparkKind = "ok" | "warn" | "bad" | "none";

export interface SparkBar {
  kind: SparkKind;
  /** 3–20px, matching the mockup's inline heights. */
  height: number;
}

const SPARK_BG: Record<SparkKind, string> = {
  ok: "bg-pass",
  warn: "bg-sev3",
  bad: "bg-accent",
  none: "bg-rule",
};

/**
 * Fourteen bars say "this has been steady" faster than fourteen log lines.
 *
 * A grey bar means **no sweep at all**, which is a different fact from a short
 * one, and the two are never drawn the same. The strip is decorative to the
 * accessibility tree; `label` is the sentence that carries the same
 * information in words, and it is required rather than optional.
 */
export function Sparkline({ bars, label }: { bars: readonly SparkBar[]; label: string }) {
  return (
    <span className="inline-flex items-end gap-[2px]" data-testid="sparkline">
      <span className="sr-only">{label}</span>
      {bars.map((bar, index) => (
        <i
          // Position is the identity here: bar 3 is the third-most-recent
          // sweep whatever its value, so an index key is the correct key.
          key={index}
          aria-hidden="true"
          data-kind={bar.kind}
          className={`block w-[5px] ${SPARK_BG[bar.kind]}`}
          style={{ height: `${bar.height}px` }}
        />
      ))}
    </span>
  );
}

/** How a row reads at a glance, before any word on it is read. */
export type Severity = "ok" | "warn" | "bad" | "idle";

const STRIPE_BG: Record<Severity, string> = {
  ok: "bg-pass",
  warn: "bg-sev3",
  bad: "bg-accent",
  idle: "bg-muted",
};

/**
 * The 3px severity stripe at the head of a row. Decorative by construction —
 * the pill beside it says the same thing in words, so this adds speed rather
 * than meaning.
 */
export function SeverityStripe({ severity }: { severity: Severity }) {
  return (
    <span
      aria-hidden="true"
      data-testid="severity-stripe"
      data-severity={severity}
      className={`block w-[3px] flex-none self-stretch min-h-[1.75rem] ${STRIPE_BG[severity]}`}
    />
  );
}

const PILL_CLASS: Record<Severity | "plain", string> = {
  ok: "text-pass bg-paper",
  warn: "text-sev3 bg-paper-sunk",
  bad: "text-accent bg-accent-50",
  idle: "text-muted bg-paper",
  plain: "text-muted bg-paper",
};

/**
 * A status pill **always carries its label as text**. The colour is the second
 * signal, never the only one — a pill that means "failing" only by being red
 * means nothing to a quarter of the people who might read it.
 */
export function StatusPill({
  tone,
  children,
  testId,
}: {
  tone: Severity | "plain";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap border border-current px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-label ${PILL_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export interface SegmentOption {
  value: string;
  label: string;
}

/**
 * The mockup's `.seg` — a row of touching cells with the chosen one inked.
 *
 * Built as a real `role="radiogroup"` of radio buttons with roving tabindex
 * and arrow-key movement, because it is a single choice from a short fixed
 * list and that is exactly what a radio group is for. A row of styled `<div>`s
 * would look identical and be unusable without a mouse.
 */
export function SegmentedControl({
  label,
  options,
  value,
  onChange,
  name,
}: {
  label: string;
  options: readonly SegmentOption[];
  value: string;
  onChange: (value: string) => void;
  name: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const labelId = useId();

  function move(delta: number) {
    const index = options.findIndex((option) => option.value === value);
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} data-testid={`segmented-${name}`} className="inline-flex border border-rule">
        {options.map((option, index) => {
          const on = option.value === value;
          return (
            <button
              key={option.value}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  move(1);
                } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  move(-1);
                }
              }}
              className={`border-r border-rule px-2.5 py-1 text-[11px] font-semibold last:border-r-0 ${FOCUS_RING} ${
                on ? "bg-ink text-paper" : "text-muted hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The spend meter. A real `role="meter"`, so the figure is available to
 * anything that does not read the bar.
 *
 * `max` of `null` means no cap is recorded, and the component says so rather
 * than drawing an empty track against an invented ceiling.
 */
export function SpendMeter({
  label,
  value,
  max,
  unit,
}: {
  label: string;
  value: number;
  max: number | null;
  unit: string;
}) {
  if (max === null) {
    return (
      <p className="text-[12px] text-muted">
        {label} — no cap recorded, so nothing here is measured against anything.
      </p>
    );
  }

  const pct = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="flex items-center gap-2.5 text-xs">
      <span className="figure text-ink">
        {value} / {max}
      </span>
      <span
        role="meter"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        data-testid="spend-meter"
        className="relative block h-1.5 flex-1 bg-rule"
      >
        <i className="absolute inset-y-0 left-0 block bg-sev3" style={{ width: `${pct}%` }} />
      </span>
      <span className="figure text-muted">{unit}</span>
    </div>
  );
}

/**
 * The `.flagbar` — a bordered strip carrying one standing fact about the
 * screen. Not an alert: it is true whether or not anything just happened, so
 * it carries no live region.
 */
export function FlagBar({
  label,
  tone = "warn",
  children,
  testId,
}: {
  label: string;
  tone?: Severity;
  children: ReactNode;
  testId?: string;
}) {
  const border =
    tone === "bad"
      ? "border-accent bg-accent-50"
      : tone === "ok"
        ? "border-pass bg-paper"
        : tone === "idle"
          ? "border-rule bg-paper-sunk"
          : "border-sev3 bg-paper-sunk";
  const labelColour =
    tone === "bad" ? "text-accent" : tone === "ok" ? "text-pass" : tone === "idle" ? "text-muted" : "text-sev3";

  return (
    <div
      data-testid={testId}
      className={`flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border px-3 py-2 text-[12.5px] leading-relaxed text-ink-soft ${border}`}
    >
      <span className={`label-sm ${labelColour}`}>{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export interface KeyValue {
  key: string;
  value: ReactNode;
  tone?: Tone;
}

/** The `.kv` provenance grid: muted keys, mono tabular values. */
export function KeyValues({ items, testId }: { items: readonly KeyValue[]; testId?: string }) {
  return (
    <dl
      data-testid={testId}
      className="grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1.5 text-[12.5px]"
    >
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt className="text-muted">{item.key}</dt>
          <dd className={`m-0 break-words font-mono tabular ${TONE_TEXT[item.tone ?? "plain"]}`}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The monospace log tail. Scrolls inside itself so a 200-character stack trace
 * never makes the page scroll sideways.
 */
export function LogTail({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <pre
      data-testid={testId}
      className="overflow-x-auto whitespace-pre-wrap break-words border border-rule bg-paper-sunk px-3 py-2.5 font-mono text-[11.5px] leading-[1.7] text-ink-soft"
    >
      {children}
    </pre>
  );
}

/**
 * The upload dropzone. A `<label>` wrapping a real file input, so it is a
 * click target, a drop target and a keyboard target without any of that being
 * reimplemented — the input is visually hidden, not `display:none`, so it
 * still takes focus.
 */
export function Dropzone({
  id,
  title,
  hint,
  onFiles,
  disabled = false,
}: {
  id: string;
  title: string;
  hint: ReactNode;
  onFiles: (files: FileList) => void;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (!disabled && event.dataTransfer.files.length > 0) onFiles(event.dataTransfer.files);
      }}
      className={`flex cursor-pointer flex-col items-center gap-1.5 border border-dashed border-rule bg-paper-sunk px-5 py-5 text-center text-[13px] text-muted hover:border-ink focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${
        disabled ? "cursor-not-allowed opacity-50" : ""
      }`}
    >
      <span className="font-display text-sm font-semibold text-ink-soft">{title}</span>
      <span className="max-w-prose leading-relaxed">{hint}</span>
      <input
        id={id}
        type="file"
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          if (event.target.files && event.target.files.length > 0) onFiles(event.target.files);
        }}
      />
    </label>
  );
}

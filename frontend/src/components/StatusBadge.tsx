import type { MeetingStatus } from "@/types";

/**
 * Editorial status pill: a hairline outline and letterspaced small caps, on
 * paper. Colour comes from the severity palette — a cancelled meeting is the
 * only status that earns the accent.
 */
const styles: Record<MeetingStatus, string> = {
  scheduled: "border-ink text-ink",
  completed: "border-rule text-muted",
  cancelled: "border-accent text-accent",
};

export function StatusBadge({ status }: { status: MeetingStatus }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border bg-paper px-2 py-px font-sans text-[10px] font-semibold uppercase leading-[1.6] tracking-label ${styles[status]}`}
    >
      {status}
    </span>
  );
}

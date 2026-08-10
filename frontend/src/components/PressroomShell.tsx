import type { ReactNode } from "react";

/**
 * The pressroom ground.
 *
 * The public site is ink on `paper` with `paper-sunk` used only as an
 * occasional band. The operator console inverts that: `paper-sunk` is the
 * ground and every card sits on `paper`. The inversion is the point — an
 * operator glancing at a screen can tell from the figure/ground alone which
 * side of the publication wall they are looking at, before reading a word.
 *
 * `Layout` renders its `<main>` as
 * `mx-auto w-full max-w-6xl px-6 sm:px-10 lg:px-14 py-10 sm:py-14`, so a child
 * that wants to paint the whole copy well has to escape that padding. The
 * negative margins below mirror it exactly, term for term, and then restore the
 * same padding inside — the content lands on the identical measure it would
 * have had, but the colour reaches the well's edges instead of stopping short
 * and leaving a paper-coloured picture frame. They are written out in full
 * rather than derived so that a change to Layout's padding fails visibly here
 * rather than silently drifting.
 *
 * No new palette, no new custom property: `paper-sunk`, `paper` and `rule` are
 * already in `tailwind.config.ts`.
 */

const BLEED =
  "-mx-6 -my-10 px-6 py-10 sm:-mx-10 sm:-my-14 sm:px-10 sm:py-14 lg:-mx-14 lg:px-14";

export function PressroomShell({ children }: { children: ReactNode }) {
  return <div className={`${BLEED} bg-paper-sunk`}>{children}</div>;
}

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

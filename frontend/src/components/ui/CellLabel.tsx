import type { ReactNode } from "react";

/**
 * The column name, repeated inside the cell, visible only in the stacked card
 * layout a wide table reflows to below `sm`.
 *
 * A real element rather than a `::before` on `attr(data-label)`: generated
 * content is not reliably announced, and on a phone this label is the only
 * thing telling a reader which figure they are looking at. It is `sm:hidden`
 * because from `sm` up the `<thead>` is doing the same job, and a screen
 * reader that read both the column header and the in-cell label would say
 * every value twice.
 */
export function CellLabel({ children }: { children: ReactNode }) {
  return (
    <span className="label-sm mb-1 block text-muted sm:hidden">{children}</span>
  );
}

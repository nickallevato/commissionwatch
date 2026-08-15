import type { FindingSourceRef } from "./finding-source";

/**
 * The chip under a finding that names the record it was drawn from.
 *
 * `<Citation>`'s counterpart for a row that has no quotation to show — see
 * `finding-source.ts` for why a finding cannot use `<Citation>` itself. What is
 * shared with it is the discipline rather than the markup: the address is a
 * link exactly when we hold one, and plain text when we do not. A chip that
 * looked identical either way would let "we have no minutes for this meeting"
 * read as a citation the reader simply had not clicked.
 */
export function FindingSource({ source }: { source: FindingSourceRef }) {
  const text = `Source: ${source.label}`;
  if (!source.url) return <span className="cite">{text}</span>;
  return (
    <a className="cite" href={source.url} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
}

import { Link } from "react-router";

/**
 * `/elections` — a skeleton, and it says so.
 *
 * This page exists so the module has a route, a place in the masthead, and a
 * shape to build into. It is deliberately not a mock: there is no seeded
 * candidate, no placeholder filing, no chart of money with invented numbers.
 *
 * The reason is the project's oldest rule rather than tidiness. Every published
 * assertion has to trace to a stored artifact, and election claims are the ones
 * where a fabricated figure would do the most damage — a candidate's finance
 * total is a number people repeat. A page that renders plausible placeholder
 * data is indistinguishable, to a reader and to a screenshot, from a page
 * reporting the record. So this one states what is not built yet and links to
 * what is.
 *
 * What it will read from, once built, is already known from the probe work:
 * Montana campaign finance is **CERS**, a structured system, not PDF scraping.
 * That is recorded here so the next person does not rediscover it.
 */

interface PlannedSection {
  title: string;
  /** What it will show. Present tense is avoided — none of this exists yet. */
  description: string;
  /** Where the data will come from, named so the design starts from the source. */
  source: string;
}

const PLANNED: PlannedSection[] = [
  {
    title: "Who is running",
    description:
      "Candidates for each seat on the bodies this project already covers, with " +
      "the filing that put them on the ballot.",
    source: "Montana Secretary of State candidate filings",
  },
  {
    title: "Who funds them",
    description:
      "Contributions and expenditures as filed, per candidate and per committee, " +
      "with the report each figure came from.",
    source: "Montana COPP — CERS, a structured system rather than scraped PDFs",
  },
  {
    title: "What they did in office",
    description:
      "For an incumbent, the votes already in this archive — linked, not " +
      "summarised, so the record speaks for itself.",
    source: "This site's own meeting records",
  },
];

export function ElectionsPage() {
  return (
    <div>
      <p className="label-sm">Module</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">Elections</h1>

      <p className="mt-6 max-w-prose text-base leading-relaxed text-muted">
        Nothing is published here yet. This module is scaffolded but carries no
        records, and it will stay empty until it can cite them — a candidate
        finance figure is a number people repeat, and a plausible placeholder is
        indistinguishable from a real one once it leaves this page.
      </p>

      <section className="mt-12" aria-labelledby="planned">
        <h2
          id="planned"
          className="font-display text-xl font-semibold text-ink"
        >
          What this module will hold
        </h2>

        <ul className="mt-6 flex flex-col gap-8">
          {PLANNED.map((section) => (
            <li key={section.title} className="border-t border-rule pt-4">
              <h3 className="font-display text-lg font-semibold text-ink">
                {section.title}
              </h3>
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
                {section.description}
              </p>
              <p className="mt-2 label-sm">Source — {section.source}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12 border-t border-rule pt-4" aria-labelledby="meanwhile">
        <h2
          id="meanwhile"
          className="font-display text-xl font-semibold text-ink"
        >
          In the meantime
        </h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
          The voting record of people currently in office is already here.
        </p>
        <p className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
          <Link className="cite" to="/officials">
            Officials
          </Link>
          <Link className="cite" to="/votes">
            Votes
          </Link>
          <Link className="cite" to="/status">
            What is and is not being collected
          </Link>
        </p>
      </section>
    </div>
  );
}

export default ElectionsPage;

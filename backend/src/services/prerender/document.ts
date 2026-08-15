import { escapeHtml, jsonLdScript, type JsonObject } from "./escape";

/**
 * The page model, and the reason it is a tree of typed blocks rather than a
 * string.
 *
 * A prerendered page exists to be read by something that will not run
 * JavaScript, so every byte of it is assembled here, on the server, out of
 * database columns whose contents came from third-party PDFs and county HTML.
 * If a page builder could hand this renderer a fragment of HTML, then exactly
 * one careless builder — today's or next year's — would put a scraped agenda
 * title into it and open the hole `frontend/nginx.conf`'s CSP is the last line
 * against.
 *
 * So there is no fragment. A builder produces `Block`s carrying plain text, the
 * renderer escapes every one of them, and the type system is what makes that a
 * mechanism rather than a convention. The same argument as `services/search.ts`
 * marking matches with control characters instead of `<b>`.
 *
 * `PageDocument.path` is the site path this document is served at, and it is
 * used three times over — as the file location, as the absolute canonical, and
 * as the Open Graph URL. One field, so those three can never disagree.
 */

export type Block =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  /** A verbatim span of a stored artifact, with the address it was read from. */
  | { kind: "quote"; text: string; citeLabel?: string; citePath?: string }
  /** Term/value pairs — the record's own fields, never prose about them. */
  | { kind: "facts"; items: ReadonlyArray<{ term: string; value: string }> }
  | { kind: "links"; items: ReadonlyArray<{ label: string; path: string }> }
  /** A section a reader can be linked straight to, e.g. `#claim-{id}`. */
  | { kind: "section"; id: string; blocks: readonly Block[] };

export interface PageDocument {
  /** Site-absolute, no origin, no trailing slash except for `/`. */
  path: string;
  /** Specific and distinguishing. See `titles.ts` for why that is a rule. */
  title: string;
  /** Assembled from the record. Never generated prose. */
  description: string;
  /**
   * `noindex` for a tombstone or a retraction page — a withdrawal is a thing a
   * reader arriving from a cache must be able to land on, and a thing no index
   * should carry forward.
   */
  robots: "index" | "noindex";
  /** `article` for a record, `website` for an index page. */
  ogType: "article" | "website";
  jsonLd: readonly JsonObject[];
  heading: string;
  blocks: readonly Block[];
}

/** Joins a site path onto an origin. Both halves normalised, once. */
export function absoluteUrl(baseUrl: string, path: string): string {
  const origin = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${suffix === "/" ? "/" : suffix.replace(/\/+$/, "")}`;
}

function renderBlock(block: Block, baseUrl: string): string {
  switch (block.kind) {
    case "heading":
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    case "paragraph":
      return `<p>${escapeHtml(block.text)}</p>`;
    case "quote": {
      const cite =
        block.citePath === undefined
          ? ""
          : `\n<footer><a href="${escapeHtml(absoluteUrl(baseUrl, block.citePath))}">` +
            `${escapeHtml(block.citeLabel ?? block.citePath)}</a></footer>`;
      return `<blockquote><p>${escapeHtml(block.text)}</p>${cite}</blockquote>`;
    }
    case "facts": {
      const rows = block.items
        .map(
          (item) =>
            `<dt>${escapeHtml(item.term)}</dt><dd>${escapeHtml(item.value)}</dd>`,
        )
        .join("\n");
      return `<dl>\n${rows}\n</dl>`;
    }
    case "links": {
      const rows = block.items
        .map(
          (item) =>
            `<li><a href="${escapeHtml(absoluteUrl(baseUrl, item.path))}">` +
            `${escapeHtml(item.label)}</a></li>`,
        )
        .join("\n");
      return `<ul>\n${rows}\n</ul>`;
    }
    case "section": {
      const inner = block.blocks.map((child) => renderBlock(child, baseUrl)).join("\n");
      // The id is escaped like everything else. It is a database uuid today,
      // and the day it is derived from a title instead this line is already
      // correct rather than newly wrong.
      return `<section id="${escapeHtml(block.id)}">\n${inner}\n</section>`;
    }
  }
}

/**
 * The whole document, as a string.
 *
 * Deliberately self-contained: no stylesheet, no script, no reference to the
 * SPA's hashed bundle. The bundle's filename is a build artifact of the
 * *frontend* image and is not knowable from here, so a `<script src>` written
 * by this function would be a guess, and a wrong guess is a 404 emitted on
 * every prerendered page. Wiring hydration is a frontend change; see the header
 * of `consumer.ts` for what deployment has to decide first.
 */
export function renderDocument(document: PageDocument, baseUrl: string): string {
  const canonical = absoluteUrl(baseUrl, document.path);
  const head: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(document.title)}</title>`,
    `<meta name="description" content="${escapeHtml(document.description)}">`,
    `<meta name="robots" content="${document.robots}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="${document.ogType}">`,
    `<meta property="og:title" content="${escapeHtml(document.title)}">`,
    `<meta property="og:description" content="${escapeHtml(document.description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    '<meta property="og:site_name" content="CommissionWatch">',
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${escapeHtml(document.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(document.description)}">`,
    ...document.jsonLd.map((block) => jsonLdScript(block)),
  ];

  const body = document.blocks.map((block) => renderBlock(block, baseUrl)).join("\n");

  return (
    "<!doctype html>\n" +
    '<html lang="en">\n<head>\n' +
    `${head.join("\n")}\n` +
    "</head>\n<body>\n" +
    `<main>\n<h1>${escapeHtml(document.heading)}</h1>\n${body}\n</main>\n` +
    `<footer><a href="${escapeHtml(absoluteUrl(baseUrl, "/bot"))}">About this dataset</a></footer>\n` +
    "</body>\n</html>\n"
  );
}

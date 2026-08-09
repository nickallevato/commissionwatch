import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { extractPdfText, looksLikePdf, UnsupportedDocumentError } from "./pdf-text";

/**
 * Text out of a stored artifact, whatever format it arrived in.
 *
 * The parse stage used to call `extractPdfText` directly, which was right while every
 * document either was a PDF or was nothing we could read. Bozeman's agendas are neither:
 * `AgendaViewer.php` serves **HTML**, and it is the best-structured agenda input either
 * jurisdiction has — lettered items, sponsor names in parentheses, one item per block.
 * Sent to the PDF extractor it raises `UnsupportedDocumentError` and every Bozeman agenda
 * lands as `parse_unsupported`: bytes held, zero agenda items, for a document that is
 * easier to read than the PDFs that do work.
 *
 * So the dispatch happens here, on the bytes rather than on the content type — a
 * Content-Type header is what a server claims, and Gallatin already proved that claim can
 * be wrong. Anything that is neither a PDF nor HTML still raises
 * `UnsupportedDocumentError`, so Gallatin's Word documents behave exactly as they did.
 */

export interface DocumentText {
  /** One entry per reconstructed line, in reading order, blank lines dropped. */
  lines: string[];
  /**
   * Pages, for `ingestion_runs.counts.pages_read`. An HTML document is one page: it has
   * no pagination to report and claiming zero would read as "nothing was there".
   */
  pageCount: number;
}

/** Block-level elements. A boundary here ends a line. */
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/** Elements whose text is markup, not content. */
const IGNORED_ELEMENTS = new Set(["script", "style", "noscript", "head", "title"]);

/**
 * `<!doctype html>` or an `<html`/`<body` tag near the start of the bytes.
 *
 * Only the first kilobyte is examined: an agenda is tens of kilobytes and the declaration
 * is in the first line of every capture we hold, while scanning the whole document would
 * make any file containing the string "<html" look like a web page.
 */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 1024))
    .toLowerCase();
  return /<!doctype\s+html|<html[\s>]|<body[\s>]/.test(head);
}

function tidy(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Lines out of HTML, split at block boundaries.
 *
 * `cheerio`'s `.text()` concatenates every text node with no separator at all, so an
 * agenda comes back as one line and every line-oriented extractor downstream returns
 * nothing. This walks the tree instead and breaks where the document breaks, which is the
 * same problem `pdf-text.ts` solves with y coordinates.
 */
export function extractHtmlText(bytes: Uint8Array): DocumentText {
  const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const $ = cheerio.load(html);

  const lines: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    const line = tidy(current.join(""));
    current = [];
    if (line !== "") lines.push(line);
  };

  const walk = (node: AnyNode): void => {
    if (node.type === "text") {
      current.push(node.data);
      return;
    }
    if (node.type !== "tag") return;
    if (IGNORED_ELEMENTS.has(node.name)) return;

    const isBlock = BLOCK_ELEMENTS.has(node.name);
    if (isBlock) flush();
    for (const child of node.children) {
      walk(child);
    }
    if (isBlock) flush();
  };

  const root = $("body").length > 0 ? $("body")[0] : $.root()[0];
  for (const child of root.children) {
    walk(child);
  }
  flush();

  return { lines, pageCount: 1 };
}

/**
 * Extracts `bytes` into lines, choosing the reader by what the bytes are.
 *
 * Throws {@link UnsupportedDocumentError} when they are neither a PDF nor HTML, so the
 * caller can still distinguish "cannot read this format" from "this document is broken".
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  contentType: string | null = null,
): Promise<DocumentText> {
  if (looksLikePdf(bytes)) {
    return extractPdfText(bytes, contentType);
  }
  if (looksLikeHtml(bytes)) {
    return extractHtmlText(bytes);
  }
  throw new UnsupportedDocumentError(
    `bytes are neither a PDF nor HTML (content-type ${contentType ?? "unknown"})`,
    contentType,
  );
}

import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PDF text extraction that keeps the lines.
 *
 * This exists because the obvious reuse does not work. `agents/meeting-monitor`'s
 * `parser/extractors.ts` splits on `\n` and requires an item number at the start
 * of a line — but `pdfjs-dist`'s `getTextContent()` returns a page's text items
 * with no line structure at all, and the naive join produces one enormous line
 * per page. Fed that, the existing extractor returns **zero** agenda items from a
 * real agenda. It is not a duplicate to replace it; it is a different problem.
 *
 * So lines are reconstructed from each item's y coordinate, which the PDF does
 * carry, and everything downstream gets to be line-oriented the way an agenda is.
 */

/**
 * Raised when bytes are not something this module can read — a Word document,
 * for instance, which Gallatin serves behind `ViewFile/Agenda` paths (verified
 * 2026-08-09). Distinct from a parse failure: nothing went wrong, the format is
 * simply not one we extract from, and the pipeline records that as a skip rather
 * than as an error.
 */
export class UnsupportedDocumentError extends Error {
  constructor(
    readonly detail: string,
    readonly contentType: string | null = null,
  ) {
    super(`unsupported document: ${detail}`);
    this.name = "UnsupportedDocumentError";
  }
}

/** `%PDF-` at byte 0. The magic number, not the content type header. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

/**
 * A text item as pdfjs reports it. Declared structurally rather than imported:
 * pdfjs ships its own types behind an ESM-only entry point, and this is the
 * whole of what we read.
 */
interface TextItemLike {
  str: string;
  /** `[a, b, c, d, e, f]`; `f` is the baseline y in PDF user space. */
  transform: number[];
  hasEOL?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextItem(value: unknown): value is TextItemLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.str === "string" &&
    Array.isArray(value.transform) &&
    value.transform.length >= 6
  );
}

/**
 * Two items are on the same line when their baselines are within this many PDF
 * user-space units. Generous enough for superscripts and mixed font sizes,
 * tight enough not to merge consecutive agenda items — agenda leading is
 * typically 12–18 units.
 */
const SAME_LINE_TOLERANCE = 3;

/** Discards a run of an agenda's dot leaders: "Item 4 .......... page 3". */
function tidy(line: string): string {
  return line.replace(/\.{4,}/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Where pdfjs's bundled standard-font metrics live, as a directory URL.
 *
 * `require.resolve` finds the installed package wherever it actually is, so
 * this is correct in the repo, in the test run and in the container without any
 * of them agreeing on a layout.
 */
function standardFontDataUrl(): string {
  const entry = require.resolve("pdfjs-dist/package.json");
  return `${pathToFileURL(dirname(entry)).href}/standard_fonts/`;
}

export interface PdfText {
  /** One entry per reconstructed line, in reading order, blank lines dropped. */
  lines: string[];
  pageCount: number;
}

/**
 * Extracts `bytes` into lines.
 *
 * Throws {@link UnsupportedDocumentError} when the bytes are not a PDF, so the
 * caller can distinguish "cannot read this format" from "this PDF is broken".
 */
export async function extractPdfText(
  bytes: Uint8Array,
  contentType: string | null = null,
): Promise<PdfText> {
  if (!looksLikePdf(bytes)) {
    throw new UnsupportedDocumentError(
      `bytes do not begin with %PDF- (content-type ${contentType ?? "unknown"})`,
      contentType,
    );
  }

  // pdfjs-dist v4 is ESM-only. A dynamic import is how a CommonJS build reaches
  // it; there is no CJS entry point to require.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const task = pdfjs.getDocument({
    // Without this pdfjs logs "Ensure that the `standardFontDataUrl` API
    // parameter is provided" once per standard font and falls back to a
    // substitute. Resolved from the installed package rather than hardcoded, so
    // it stays right inside the production image too.
    standardFontDataUrl: standardFontDataUrl(),
    // pdfjs takes ownership of the buffer it is handed, so it gets a copy.
    data: Uint8Array.from(bytes),
    // No worker thread: this already runs inside a queue worker, and a nested
    // worker would need a separate bundle on disk in the production image.
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  });

  const document = await task.promise;
  try {
    const lines: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();

      let currentY: number | null = null;
      let current: string[] = [];
      const flush = (): void => {
        if (current.length === 0) return;
        const line = tidy(current.join(""));
        if (line !== "") lines.push(line);
        current = [];
      };

      for (const raw of content.items) {
        if (!isTextItem(raw)) continue;
        const y = raw.transform[5];
        if (currentY !== null && Math.abs(y - currentY) > SAME_LINE_TOLERANCE) {
          flush();
        }
        currentY = y;
        current.push(raw.str);
        if (raw.hasEOL === true) {
          flush();
          currentY = null;
        }
      }
      flush();
      page.cleanup();
    }
    return { lines, pageCount: document.numPages };
  } finally {
    await document.destroy();
  }
}

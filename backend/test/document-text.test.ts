import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDocumentText,
  extractHtmlText,
  looksLikeHtml,
} from "../src/services/ingestion/document-text";
import { mergeOrphanMarkers } from "../src/services/ingestion/agenda-items";
import { UnsupportedDocumentError } from "../src/services/ingestion/pdf-text";
import { extractAgendaItems } from "../src/services/ingestion/agenda-items";

/**
 * Reading an agenda that is not a PDF.
 *
 * Bozeman's `AgendaViewer.php` serves HTML, and it is the best-structured agenda input
 * this project has: lettered sections, dotted sub-items, sponsor names in parentheses.
 * Before this module the parse stage knew only `extractPdfText`, so every one of those
 * agendas landed as `parse_unsupported` — bytes stored, zero agenda items, for a document
 * that is easier to read than the PDFs that already worked.
 *
 * The fixture is the verbatim 2026-08-09 capture in `fixtures/bozeman-granicus/`.
 */

const BOZEMAN_AGENDA = new Uint8Array(
  readFileSync(
    join(__dirname, "fixtures", "bozeman-granicus", "agendaviewer-clip2784.html"),
  ),
);

const GALLATIN_AGENDA_PDF = new Uint8Array(
  readFileSync(join(__dirname, "fixtures", "gallatin", "viewfile-agenda-06022025-2.pdf")),
);

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("looksLikeHtml", () => {
  it("recognises a document that declares itself", () => {
    assert.equal(looksLikeHtml(bytes("<!DOCTYPE html><html><body>hi</body></html>")), true);
    assert.equal(looksLikeHtml(bytes("<html lang='en'>\n<head></head>")), true);
    assert.equal(looksLikeHtml(BOZEMAN_AGENDA), true);
  });

  it("does not mistake a PDF or plain text for a page", () => {
    assert.equal(looksLikeHtml(GALLATIN_AGENDA_PDF), false);
    assert.equal(looksLikeHtml(bytes("AGENDA\n1. Call to order")), false);
    assert.equal(looksLikeHtml(new Uint8Array(0)), false);
  });

  it("only reads the head of the bytes", () => {
    // A document that merely mentions <html> a long way in is not a web page. Scanning
    // the whole thing would make any file quoting markup look like one.
    const late = `${"x".repeat(4000)}<html>`;
    assert.equal(looksLikeHtml(bytes(late)), false);
  });
});

describe("extractHtmlText", () => {
  it("breaks lines where the document breaks", () => {
    // cheerio's own .text() returns "onetwothree" — one line, and every line-oriented
    // extractor downstream then finds nothing.
    const { lines } = extractHtmlText(
      bytes("<body><p>one</p><div>two<br>three</div></body>"),
    );
    assert.deepEqual(lines, ["one", "two", "three"]);
  });

  it("drops script and style content, which is markup and not record", () => {
    const { lines } = extractHtmlText(
      bytes("<body><style>p{color:red}</style><script>var a=1</script><p>Agenda</p></body>"),
    );
    assert.deepEqual(lines, ["Agenda"]);
  });

  it("collapses whitespace, including the non-breaking kind Granicus emits", () => {
    const { lines } = extractHtmlText(
      bytes("<body><p>August&nbsp;&nbsp;4,&nbsp;2026</p></body>"),
    );
    assert.deepEqual(lines, ["August 4, 2026"]);
  });

  it("reports one page, because an HTML document has no pagination to report", () => {
    assert.equal(extractHtmlText(bytes("<body><p>x</p></body>")).pageCount, 1);
  });

  it("reads the captured Bozeman agenda into its own lines", () => {
    const { lines } = extractHtmlText(BOZEMAN_AGENDA);
    assert.ok(lines.includes("THE CITY COMMISSION OF BOZEMAN, MONTANA"));
    assert.ok(lines.includes("Tuesday, August 4, 2026"));
    assert.ok(
      lines.includes(
        "G.1 Formal Cancellation of the August 11, 2026, Regular City Commission Meeting(Maas)",
      ),
    );
  });

  it("leaves a grid-split marker on its own line, verbatim", () => {
    // The source is `<span width:5%>A.&nbsp;</span><span width:95%><p>Call to Order …`.
    // The paragraph is a block, so the break is real and reconstruction is right to make
    // it. Rejoining is `mergeOrphanMarkers`' job, not this module's, and the line-level
    // output stays a faithful reading of the markup.
    const { lines } = extractHtmlText(BOZEMAN_AGENDA);
    assert.ok(lines.includes("A."));
    assert.ok(
      lines.includes(
        "Call to Order - EARLY START TIME of 2:00 PM - Commission Room, City Hall, 121 North Rouse",
      ),
    );
  });

  it("does not insert whitespace the document does not contain", () => {
    // The capture really says `Meeting</a>(Maas)`. A browser renders "Meeting(Maas)" and
    // so do we: tidying a record into what it ought to have said is still editing it.
    const { lines } = extractHtmlText(BOZEMAN_AGENDA);
    assert.ok(lines.some((line) => line.includes("Approval(Edwards)")));
  });
});

describe("mergeOrphanMarkers", () => {
  it("rejoins a marker the source put in its own element", () => {
    assert.deepEqual(mergeOrphanMarkers(["A.", "Call to Order", "B.", "Pledge"]), [
      "A. Call to Order",
      "B. Pledge",
    ]);
  });

  it("leaves an ordinary line alone", () => {
    assert.deepEqual(mergeOrphanMarkers(["G.1 Formal Cancellation", "Consent"]), [
      "G.1 Formal Cancellation",
      "Consent",
    ]);
  });

  it("does not swallow a marker that is followed by another marker", () => {
    // Two markers in a row is a layout this rule does not understand. Guessing which text
    // belongs to which would attach an item title to the wrong item.
    assert.deepEqual(mergeOrphanMarkers(["A.", "B.", "Pledge"]), ["A.", "B. Pledge"]);
  });
});

describe("extractDocumentText", () => {
  it("reads a PDF through the PDF extractor", async () => {
    const text = await extractDocumentText(GALLATIN_AGENDA_PDF, "application/pdf");
    assert.ok(text.pageCount > 0);
    assert.ok(text.lines.length > 0);
  });

  it("reads HTML through the HTML extractor", async () => {
    const text = await extractDocumentText(BOZEMAN_AGENDA, "text/html");
    assert.ok(text.lines.length > 20);
  });

  it("decides on the bytes, not on what the server claimed", async () => {
    // A Content-Type header is an assertion by the server, and Gallatin already proved
    // that assertion can be wrong.
    const text = await extractDocumentText(BOZEMAN_AGENDA, "application/pdf");
    assert.ok(text.lines.includes("THE CITY COMMISSION OF BOZEMAN, MONTANA"));
  });

  it("still refuses a format it cannot read, rather than returning nothing", async () => {
    // Gallatin serves Word documents behind ViewFile/Agenda paths. The bytes are still
    // stored and still citable; the parse stage records the gap.
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    await assert.rejects(
      () => extractDocumentText(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      UnsupportedDocumentError,
    );
  });
});

describe("the Bozeman agenda, end to end", () => {
  it("yields real agenda items rather than an empty extraction", async () => {
    const text = await extractDocumentText(BOZEMAN_AGENDA, "text/html");
    const { items } = extractAgendaItems(text.lines);

    // The 2026-08-04 agenda carries fifteen consent items alone, G.1 through G.15.
    assert.ok(items.length >= 20, `expected 20+ items, got ${items.length}`);

    const titles = items.map((item) => item.title);
    assert.ok(
      titles.includes(
        "Formal Cancellation of the August 11, 2026, Regular City Commission Meeting(Maas)",
      ),
    );
    assert.ok(titles.some((title) => title.startsWith("Community Housing Work Session")));

    // Dotted markers are preserved as printed, and the ordinal is document-wide.
    const consent = items.filter((item) => /^G\.\d+$/.test(item.marker));
    assert.equal(consent.length, 15);
    assert.deepEqual(
      items.map((item) => item.itemNumber),
      items.map((_item, index) => index + 1),
    );
  });

  it("describes the record and asserts nothing about it", () => {
    // The extractor reports what the document printed. Nothing here infers motive, and
    // no title is rewritten.
    const { items } = extractAgendaItems([
      "G.1 Authorize the City Manager to Sign a Term Contract with Cascadia Partners, LLC (DiTommaso)",
    ]);
    assert.equal(items.length, 1);
    assert.equal(
      items[0].title,
      "Authorize the City Manager to Sign a Term Contract with Cascadia Partners, LLC (DiTommaso)",
    );
    assert.equal(items[0].marker, "G.1");
  });
});

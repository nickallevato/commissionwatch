import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractAgendaItems } from "../src/services/ingestion/agenda-items";
import {
  extractPdfText,
  looksLikePdf,
  UnsupportedDocumentError,
} from "../src/services/ingestion/pdf-text";

/**
 * The agenda extractor, and the PDF line reconstruction it depends on.
 *
 * Nothing here touches the network: the one PDF used is the Gallatin agenda
 * captured on 2026-08-04 and stored under `test/fixtures/gallatin/`.
 */

const FIXTURE_DIR = join(__dirname, "fixtures", "gallatin");

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

/**
 * The shape of the real Gallatin Weed Board agenda pulled 2026-08-09, verbatim
 * down to the roman-numeral sections and the restarting item numbers.
 */
const GALLATIN_WEED_BOARD_LINES = [
  "GALLATIN COUNTY WEED DISTRICT",
  "903 North Black Avenue",
  "Bozeman, MT 59715",
  "REGULAR MONTHLY BOARD MEETING",
  "June 4, 2026",
  "AGENDA",
  "I. PUBLIC COMMENT (Limited to 5 minutes unless special request is granted)",
  "II. MINUTES – April 2, 2026",
  "III. OLD BUSINESS",
  "1. Outstanding Noxious Weed Management Award",
  "IV. NEW BUSINESS",
  "1. Monthly Report Q&A",
  "2. Commissioner Report",
  "3. Coordinators Report",
  "• Grants Update",
  "• Events/Projects/Trainings",
  "4. Round Table",
];

describe("extractAgendaItems", () => {
  it("numbers items across the whole document, not within a section", () => {
    const { items } = extractAgendaItems(GALLATIN_WEED_BOARD_LINES);

    // The document prints "1." twice — once under OLD BUSINESS and once under
    // NEW BUSINESS. Trusting the printed marker would collide on
    // (meeting_id, item_number) and lose an item.
    assert.deepEqual(
      items.map((item) => item.itemNumber),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      items.map((item) => item.marker),
      ["1", "1", "2", "3", "4"],
    );
  });

  it("keeps the section an item sat under", () => {
    const { items } = extractAgendaItems(GALLATIN_WEED_BOARD_LINES);
    assert.equal(items[0].title, "Outstanding Noxious Weed Management Award");
    assert.equal(items[0].category, "III. OLD BUSINESS");
    assert.equal(items[1].category, "IV. NEW BUSINESS");
  });

  it("folds bullets into the description of the item above them", () => {
    const { items } = extractAgendaItems(GALLATIN_WEED_BOARD_LINES);
    const coordinators = items.find((item) => item.title === "Coordinators Report");
    assert.ok(coordinators, "expected a Coordinators Report item");
    assert.equal(coordinators.description, "Grants Update Events/Projects/Trainings");
  });

  it("reports whether the document called itself an agenda", () => {
    assert.equal(extractAgendaItems(GALLATIN_WEED_BOARD_LINES).sawAgendaHeading, true);
    assert.equal(extractAgendaItems(["1. Something"]).sawAgendaHeading, false);
  });

  it("treats a roman-numeral heading as a section, not as an item", () => {
    const { items } = extractAgendaItems(["III. OLD BUSINESS", "1. A thing"]);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "A thing");
  });

  it("does not lose an item whose text merely begins with the letter I", () => {
    // "I. Approve the contract" is an item, not a section. Classifying on the
    // numeral style alone would silently drop it.
    const { items } = extractAgendaItems([
      "I. Approve the contract with the county road department",
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Approve the contract with the county road department");
  });

  it("recognises an unnumbered heading line", () => {
    const { items } = extractAgendaItems(["CONSENT AGENDA", "1. Claims and payroll"]);
    assert.equal(items[0].category, "CONSENT AGENDA");
  });

  it("returns nothing for an empty document rather than throwing", () => {
    assert.deepEqual(extractAgendaItems([]), { items: [], sawAgendaHeading: false });
  });

  it("drops page numbers rather than filing them as items", () => {
    const { items } = extractAgendaItems(["1. A thing", "Page 2 of 4", "2. Another thing"]);
    assert.deepEqual(
      items.map((item) => item.title),
      ["A thing", "Another thing"],
    );
  });

  it("clamps a title to what agenda_items.title can hold", () => {
    const long = "x".repeat(400);
    const { items } = extractAgendaItems([`1. ${long}`]);
    assert.equal(items[0].title.length, 255);
  });
});

describe("looksLikePdf", () => {
  it("recognises the %PDF- magic number", () => {
    assert.equal(looksLikePdf(fixture("viewfile-agenda-06022025-2.pdf")), true);
  });

  it("rejects a Word document, which Gallatin does serve behind agenda URLs", () => {
    // The first four bytes of any OOXML file: it is a zip.
    assert.equal(looksLikePdf(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])), false);
  });

  it("rejects bytes too short to carry a header", () => {
    assert.equal(looksLikePdf(new Uint8Array([0x25, 0x50])), false);
  });
});

describe("extractPdfText", () => {
  it("reconstructs lines from a real agenda rather than one blob per page", async () => {
    const text = await extractPdfText(fixture("viewfile-agenda-06022025-2.pdf"));
    assert.ok(text.pageCount >= 1, "expected at least one page");
    // The whole reason this module exists: pdfjs joins a page's text items with
    // spaces, so a naive extractor sees one line per page and a line-oriented
    // parser finds nothing.
    assert.ok(
      text.lines.length > text.pageCount,
      `expected more lines (${text.lines.length}) than pages (${text.pageCount})`,
    );
    assert.ok(
      text.lines.every((line) => line === line.trim() && line !== ""),
      "expected trimmed, non-empty lines",
    );
  });

  it("refuses a non-PDF with a typed error the pipeline can recognise", async () => {
    await assert.rejects(
      () => extractPdfText(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "application/vnd.ms-word"),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedDocumentError);
        assert.equal(error.contentType, "application/vnd.ms-word");
        return true;
      },
    );
  });

  it("yields agenda items when the two stages are composed", async () => {
    const text = await extractPdfText(fixture("viewfile-agenda-06022025-2.pdf"));
    const { items } = extractAgendaItems(text.lines);
    assert.ok(items.length > 0, "expected the captured agenda to yield items");
    assert.ok(
      items.every((item) => item.title.length > 0 && item.itemNumber > 0),
      "every item needs a title and an ordinal",
    );
    assert.deepEqual(
      items.map((item) => item.itemNumber),
      items.map((_item, index) => index + 1),
      "ordinals must be dense and 1-based",
    );
  });
});

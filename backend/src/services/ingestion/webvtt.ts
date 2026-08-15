/**
 * WebVTT, read off the bytes.
 *
 * Bozeman's Granicus portal serves `videos/{clip_id}/captions.vtt` under the same
 * posture as an agenda, and every one of the 1,135 archived meetings carries a
 * clip id. This module is the only thing in the project that understands that
 * format, and it does two jobs that must never disagree: deciding whether a
 * response is a caption file at all, and turning one into cues.
 *
 * ## Why the dispatch is on the bytes and never on the Content-Type
 *
 * Same rule `document-text.ts` already follows for PDF and HTML. A Content-Type
 * is what a server claims, and an unknown clip id on this host answers
 * `500 text/html` with a Slim framework error page — probed 2026-08-14, clip
 * 999999, 2,512 bytes of HTML. Trusting the header would let a vendor error page
 * be stored as a transcript.
 *
 * ## Why nothing here is allowed to skip
 *
 * `parseWebVttCues` throws, with the line number, on anything it cannot read. A
 * parser that dropped the cues it did not understand would produce a transcript
 * with a hole in it that reads exactly like a transcript without one — and this
 * project publishes the result as the custodian's record.
 *
 * The sampled files use none of WebVTT's optional machinery: across clips 2775
 * and 2786 there are no cue identifiers, no `NOTE`/`STYLE`/`REGION` blocks, no
 * cue settings after the arrow, no inline tags, and timestamps always in the long
 * `HH:MM:SS.mmm` form. The general forms are handled anyway, because a parser
 * written to one encoder's exact output breaks silently the first time the vendor
 * upgrades it.
 *
 * ## What is not here, and will not be
 *
 * No speaker parsing. `>>` is the CEA-608 speaker-*change* marker: it carries no
 * identity, and in these files it appears mid-payload, so splitting on it cuts
 * sentences in half and hands the tail to an invented speaker. `Name:` prefixes
 * stay in the payload text verbatim — stripping them would edit the custodian's
 * record — and are never promoted to a field. See `migrations/090`.
 */

/** One caption cue. Times are milliseconds into the recording, never a clock. */
export interface VttCue {
  startMs: number;
  endMs: number;
  /** The payload verbatim. Multi-line payloads keep their line breaks. */
  text: string;
}

/** Raised when the bytes are WebVTT-shaped but a specific line cannot be read. */
export class WebVttParseError extends Error {
  constructor(
    readonly line: number,
    detail: string,
  ) {
    super(`WebVTT line ${line}: ${detail}`);
    this.name = 'WebVttParseError';
  }
}

const BOM = '﻿';

/**
 * The WebVTT spec's own file signature: an optional BOM, `WEBVTT`, then EOF, a
 * newline, a carriage return, a space or a tab.
 *
 * Decidable on the first sixteen bytes, and true of the eight-byte empty stub —
 * which is the whole point. `WEBVTT\n\n` is a valid caption file stating that
 * there are no captions, and it must be readable as such rather than as a
 * malformed response.
 */
export function looksLikeWebVtt(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 16));
  const body = head.startsWith(BOM) ? head.slice(BOM.length) : head;
  if (!body.startsWith('WEBVTT')) return false;
  const next = body.charAt('WEBVTT'.length);
  return next === '' || next === '\n' || next === '\r' || next === ' ' || next === '\t';
}

/** `00:29:38.500` or `29:38.500` -> milliseconds. Null when it is neither. */
export function parseVttTimestamp(text: string): number | null {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(text);
  if (match === null) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  return (
    hours * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number(match[4])
  );
}

/** Blocks WebVTT defines that carry no cue. A whole block, up to the blank line. */
const NON_CUE_BLOCKS = /^(NOTE|STYLE|REGION)(\s|$)/;

const ARROW = '-->';

/**
 * Every cue in the file, in file order.
 *
 * Pure and does no I/O, which is what lets the fetch handler decide
 * `published` / `absent` from the same code the parse handler indexes with —
 * there is no second implementation to drift.
 *
 * Returns `[]` for the eight-byte empty stub without throwing. That is what makes
 * `absent` a recordable state about the custodian's record rather than an error
 * about ours.
 */
export function parseWebVttCues(bytes: Uint8Array): VttCue[] {
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const text = (raw.startsWith(BOM) ? raw.slice(BOM.length) : raw).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const header = lines[0] ?? '';
  if (!/^WEBVTT([ \t].*)?$/.test(header)) {
    throw new WebVttParseError(1, `expected a WEBVTT signature, got ${JSON.stringify(header.slice(0, 40))}`);
  }

  const cues: VttCue[] = [];
  // Line 1 is the signature; the rest of the header block runs to the first blank
  // line and is skipped with it.
  let index = 1;
  let inHeader = true;

  while (index < lines.length) {
    if (lines[index].trim() === '') {
      inHeader = false;
      index += 1;
      continue;
    }

    // Collect the block: everything up to the next blank line or EOF.
    const start = index;
    while (index < lines.length && lines[index].trim() !== '') index += 1;
    const block = lines.slice(start, index);

    if (inHeader) continue;
    if (NON_CUE_BLOCKS.test(block[0])) continue;

    const arrowAt = block.findIndex((line) => line.includes(ARROW));
    if (arrowAt === -1) {
      // Not a cue, not a comment, not a style block. Refused rather than skipped:
      // whatever it is, ignoring it would silently shorten the transcript.
      throw new WebVttParseError(
        start + 1,
        `block has no '${ARROW}' timing line and is not NOTE, STYLE or REGION`,
      );
    }
    if (arrowAt > 1) {
      throw new WebVttParseError(
        start + 1,
        'a cue may carry at most one identifier line before its timings',
      );
    }

    const timingLineNo = start + arrowAt + 1;
    const timing = block[arrowAt];
    const [before, ...after] = timing.split(ARROW);
    if (after.length !== 1) {
      throw new WebVttParseError(timingLineNo, `expected exactly one '${ARROW}' in the timing line`);
    }
    const startMs = parseVttTimestamp(before.trim());
    if (startMs === null) {
      throw new WebVttParseError(
        timingLineNo,
        `start timestamp ${JSON.stringify(before.trim())} is not HH:MM:SS.mmm or MM:SS.mmm`,
      );
    }
    // Cue settings — `align:start position:10%` — follow the end timestamp on the
    // same line. None of the sampled files uses them; they are read off rather
    // than assumed absent.
    const endToken = after[0].trim().split(/\s+/)[0] ?? '';
    const endMs = parseVttTimestamp(endToken);
    if (endMs === null) {
      throw new WebVttParseError(
        timingLineNo,
        `end timestamp ${JSON.stringify(endToken)} is not HH:MM:SS.mmm or MM:SS.mmm`,
      );
    }
    if (endMs < startMs) {
      throw new WebVttParseError(timingLineNo, `cue ends at ${endMs}ms before it starts at ${startMs}ms`);
    }

    cues.push({ startMs, endMs, text: block.slice(arrowAt + 1).join('\n') });
  }

  return cues;
}

/**
 * The projection of a cue list into the one string `artifact_texts.text` holds,
 * with each cue's span in it.
 *
 * One function, so the text and the index that describes it are computed from the
 * same arithmetic and can never be two different answers to the same question.
 *
 * Cues whose payload is empty carry no text to address and are left out of both
 * halves — `transcript_cues.text_length > 0` refuses them anyway, and a row that
 * quoted nothing would resolve a citation to silence. They are still counted in
 * `transcript_status.cue_count`, which reports what the file contains rather than
 * what we indexed.
 */
export interface TranscriptProjection {
  text: string;
  spans: { cueIndex: number; startMs: number; endMs: number; offset: number; length: number }[];
}

export function projectTranscript(cues: readonly VttCue[]): TranscriptProjection {
  const spans: TranscriptProjection['spans'] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const [cueIndex, cue] of cues.entries()) {
    if (cue.text === '') continue;
    if (parts.length > 0) offset += 1; // the '\n' the join will insert
    parts.push(cue.text);
    spans.push({
      cueIndex,
      startMs: cue.startMs,
      endMs: cue.endMs,
      offset,
      length: cue.text.length,
    });
    offset += cue.text.length;
  }
  return { text: parts.join('\n'), spans };
}

import type { Knex } from "knex";
import { extractPdfText, looksLikePdf } from "../ingestion/pdf-text";
import { OpenRouterClient } from "./openrouter";
import { extractClaims, persistClaims, type ExtractionOutcome } from "./extractor";

/**
 * Extract one meeting's minutes, end to end.
 *
 * Deliberately a service called by a route rather than a CLI script. The
 * lesson is two days old and cost this project a live outage: `npm run sweep`
 * is `tsx src/scripts/sweep.ts`, `backend/Dockerfile` copies `dist/` and
 * `migrations/` and never `src/`, and so the only lever for enabling a source
 * did not exist inside the container. An operator action that cannot be taken
 * on the deployment is not an operator action.
 *
 * Reads stored bytes only. Nothing here reaches the source — the artifact was
 * fetched by the `fetch` stage, is addressed by its hash, and is what the
 * citations will point at.
 */

export class ExtractionUnavailable extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ExtractionUnavailable";
  }
}

export interface MinutesArtifact {
  sha256: string;
  storage_key: string;
  content_type: string | null;
}

/**
 * The minutes for a meeting, or null.
 *
 * Chosen by `meeting_documents.document_type`, not by guessing at the newest
 * artifact: an agenda and a set of minutes for the same meeting are both PDFs
 * from the same host, and extracting officials' votes from an *agenda* would
 * produce claims about things that had not happened yet.
 */
export async function findMinutesArtifact(
  db: Knex,
  meetingId: string,
): Promise<MinutesArtifact | null> {
  const row: unknown = await db("ingestion_jobs as j")
    .join("artifacts as a", db.raw("a.sha256 = j.target ->> 'sha256'"))
    .where("j.stage", "parse")
    .whereRaw("j.target ->> 'meetingId' = ?", [meetingId])
    .whereRaw("lower(coalesce(j.target ->> 'documentType', '')) = 'minutes'")
    .orderBy("j.created_at", "desc")
    .first("a.sha256 as sha256", "a.storage_key as storage_key", "a.content_type as content_type");

  if (typeof row !== "object" || row === null) return null;
  const value = row as Record<string, unknown>;
  if (typeof value.sha256 !== "string" || typeof value.storage_key !== "string") return null;
  return {
    sha256: value.sha256,
    storage_key: value.storage_key,
    content_type: typeof value.content_type === "string" ? value.content_type : null,
  };
}

export interface RunExtractionDeps {
  db: Knex;
  read: (storageKey: string) => Promise<Buffer>;
  client: OpenRouterClient;
}

export interface RunExtractionResult {
  meeting_id: string;
  artifact_sha256: string;
  outcome: ExtractionOutcome;
  stored: number;
}

/**
 * Run the extractor over a meeting's minutes and store what survives.
 *
 * Every failure here is a distinct, stated condition rather than an empty
 * result: "no minutes have been fetched for this meeting" and "the model was
 * rate-limited" and "nothing in the document could be verified" are three
 * different facts, and collapsing them into "0 claims" is how a transparency
 * project ends up quietly asserting that a meeting had no votes.
 */
export async function runExtraction(
  deps: RunExtractionDeps,
  meetingId: string,
): Promise<RunExtractionResult> {
  if (!deps.client.configured) {
    throw new ExtractionUnavailable(
      "OPENROUTER_API_KEY is not set on this deployment, so nothing was extracted.",
      503,
    );
  }

  const artifact = await findMinutesArtifact(deps.db, meetingId);
  if (artifact === null) {
    throw new ExtractionUnavailable(
      "No minutes document has been fetched for this meeting. Minutes are a separate " +
        "document from the agenda, and a meeting can be ingested long before they are published.",
      404,
    );
  }

  const bytes = await deps.read(artifact.storage_key);
  if (!looksLikePdf(bytes)) {
    throw new ExtractionUnavailable(
      `The stored minutes artifact is not a PDF (content type ${artifact.content_type ?? "unknown"}).`,
      422,
    );
  }

  const { lines } = await extractPdfText(bytes);
  // Rejoined with newlines, which is the text the citations index into. The
  // verifier matches whitespace-insensitively for exactly this reason: a line
  // break here is an artefact of glyph positions, not of the record.
  const text = lines.join("\n");
  if (text.trim() === "") {
    // A scanned image of a page has no text layer. That is a real finding about
    // the document — and the honest answer is a records request, not an OCR
    // guess presented as a citation.
    throw new ExtractionUnavailable(
      "The minutes PDF carries no extractable text layer, so there is nothing to cite. " +
        "It is likely a scan; the records-request route is the way to obtain a text copy.",
      422,
    );
  }

  const outcome = await extractClaims(deps.client, { documentText: text });
  const stored = await persistClaims(deps.db, outcome, {
    meetingId,
    artifactSha256: artifact.sha256,
  });

  return { meeting_id: meetingId, artifact_sha256: artifact.sha256, outcome, stored };
}

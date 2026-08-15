import type { Knex } from "knex";

/**
 * Holds the text extracted from an artifact, so it can be searched.
 *
 * P6. The extraction has run since P1 and its output was thrown away the moment
 * agenda items were read out of it — which left the *body* of every document
 * unsearchable, and the body is where most terms appear. One row per artifact,
 * replaced on re-parse rather than accumulated: an artifact is content
 * addressed, so a second extraction of the same bytes is a better reading of the
 * same document, not a second document.
 *
 * It writes what was extracted and nothing else. No summary, no normalisation
 * beyond the line joining the extractor already did — the searchable text and
 * the text a reader would find in the stored bytes have to be the same thing.
 *
 * **There is one of these and there must stay one of these.**
 * `services/extraction/verify.ts` locates a quotation as a character offset into
 * exactly this string, and that offset is what `minute_claims.quote_offset`
 * stores and what `transcript_cues.text_offset` addresses. A second indexing path
 * with its own projection would be a second offset space, and a citation resolved
 * in the wrong one points at the wrong words. It lives in its own module rather
 * than in `handlers.ts` for that reason: `ingestion/transcripts.ts` needs it too,
 * and reaching back into the handler module for it would make the two files
 * import each other.
 */
export async function recordArtifactText(
  db: Knex,
  artifactId: string,
  text: string,
): Promise<number> {
  await db("artifact_texts")
    .insert({
      artifact_id: artifactId,
      text,
      char_count: text.length,
      extracted_at: db.fn.now(),
    })
    .onConflict("artifact_id")
    .merge(["text", "char_count", "extracted_at", "updated_at"]);
  return text.length;
}

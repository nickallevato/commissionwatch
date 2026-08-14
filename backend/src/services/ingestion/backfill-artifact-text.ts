import type { Knex } from "knex";
import { extractDocumentText } from "./document-text";
import { recordArtifactText } from "./handlers";
import { UnsupportedDocumentError } from "./pdf-text";

/**
 * Indexes the text of artifacts that were parsed before minutes were indexed.
 *
 * The `parse` handler used to return `parse_not_agenda` *before* it called
 * `recordArtifactText`, so every set of minutes, every packet and every
 * attachment this project has fetched was stored, content addressed, and never
 * indexed into `artifact_texts` — the table `services/search.ts` reads for
 * document bodies. Fixing the handler fixes the next fetch and nothing else:
 * `parse` is only enqueued when a fetch produced *new* bytes, and by design an
 * unchanged document is never re-fetched. Without this, the correction would
 * only reach documents the county has not published yet.
 *
 * **This deliberately does not go through the queue.** A `parse` job belongs to
 * an `ingestion_runs` row, which belongs to a source, and writing one here would
 * put a sweep in the ledger that never happened — the status page reads those
 * rows and would report a fetch nobody made. Every stage after `fetch` reads
 * stored bytes rather than the network, which is exactly the property that lets
 * this run as a plain pass over storage instead.
 *
 * It extracts text and nothing else. No agenda items: the rule the old branch
 * was protecting is still right, and manufacturing an agenda out of minutes
 * during a backfill would be a worse version of the same mistake.
 *
 * Idempotent. `recordArtifactText` merges on `artifact_id`, and the candidate
 * query skips anything already indexed, so an interrupted run resumes by being
 * run again.
 */

export interface BackfillResult {
  /** Artifacts considered. */
  examined: number;
  /** Artifacts whose text is now in `artifact_texts`. */
  indexed: number;
  /** Characters written across all of them. */
  chars: number;
  /**
   * Artifacts whose bytes no reader understands — Word documents, images,
   * scans. Counted rather than logged away: it is a fact about the record, and
   * it is the number that says how much of the archive needs a records request
   * rather than a parser.
   */
  unsupported: number;
  /** Artifacts whose bytes could not be read from storage at all. */
  unreadable: number;
}

export interface BackfillOptions {
  /** Reads an artifact's bytes by storage key. */
  read: (storageKey: string) => Promise<Buffer>;
  /** Stop after this many artifacts. */
  limit?: number;
  logger?: Pick<Console, "info" | "warn">;
}

interface Candidate {
  id: string;
  storage_key: string;
  content_type: string | null;
}

/**
 * Artifacts that are reachable from a meeting document and have no text row.
 *
 * The join is the same path `services/search.ts` walks to reach the publication
 * wall — `artifact_texts → document_versions → meeting_documents → meetings`.
 * An artifact with no `document_versions` row can never be returned by search
 * no matter what is indexed for it, so extracting its text would be work that
 * nothing could ever read. The wall itself is not applied here: this writes to
 * an internal table, and withholding the index for an unpublished meeting would
 * mean publishing a meeting later left its documents permanently unsearchable.
 */
export async function findUnindexedArtifacts(db: Knex, limit: number): Promise<Candidate[]> {
  const rows: unknown = await db("artifacts as a")
    .join("document_versions as dv", "dv.artifact_id", "a.id")
    .leftJoin("artifact_texts as at", "at.artifact_id", "a.id")
    .whereNull("at.artifact_id")
    .distinct("a.id", "a.storage_key", "a.content_type")
    .orderBy("a.id")
    .limit(limit);

  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Candidate => {
    if (typeof row !== "object" || row === null) return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.id === "string" && typeof candidate.storage_key === "string";
  });
}

export async function backfillArtifactText(
  db: Knex,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const limit = options.limit ?? 500;
  const logger = options.logger ?? console;
  const result: BackfillResult = {
    examined: 0,
    indexed: 0,
    chars: 0,
    unsupported: 0,
    unreadable: 0,
  };

  const candidates = await findUnindexedArtifacts(db, limit);

  for (const artifact of candidates) {
    result.examined += 1;

    let content: Buffer;
    try {
      content = await options.read(artifact.storage_key);
    } catch (error) {
      // The row says bytes exist and storage disagrees. That is worth knowing
      // and it is not worth stopping for: one missing object must not strand
      // the rest of the archive unindexed.
      result.unreadable += 1;
      logger.warn(
        `backfill: cannot read ${artifact.storage_key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    let text;
    try {
      text = await extractDocumentText(content, artifact.content_type);
    } catch (error) {
      if (error instanceof UnsupportedDocumentError) {
        result.unsupported += 1;
        continue;
      }
      throw error;
    }

    result.chars += await recordArtifactText(db, artifact.id, text.lines.join("\n"));
    result.indexed += 1;
  }

  return result;
}

import type { Knex } from "knex";

/**
 * What a finding rests on.
 *
 * "No unsourced claim reaches the public site" is one of the two invariants
 * this queue exists to enforce, and the spec asks for it to be *enforced*, not
 * discouraged. So approval refuses when this resolver returns nothing, and the
 * console renders what it does return beside the claim text — the operator sees
 * the binding before deciding, rather than being asked to trust that one exists.
 *
 * Three routes to a stored artifact, most specific first:
 *
 *  1. **`anomaly_flags.artifact_id`** — a records-derived flag is about one
 *     document, and that column is the citation.
 *  2. **A sha256 in the flag's metadata.** P5's `last_minute_agenda_change`
 *     carries `from_sha256` and `to_sha256` precisely so the claim is checkable
 *     against the stored bytes by anyone holding them.
 *  3. **The meeting's stored documents**, through `document_versions →
 *     meeting_documents`. This is what makes a meeting-derived finding
 *     approvable at all, and it is honest rather than generous: the meeting
 *     record the claim describes was extracted from those bytes.
 *
 * A meeting with no stored artifact yields no citation and its findings cannot
 * be approved. That is the correct refusal — there is genuinely nothing behind
 * the claim — and not a gap to be papered over with a fourth route.
 */

export type CitationKind = "flag_artifact" | "metadata_sha256" | "meeting_document";

export interface Citation {
  kind: CitationKind;
  artifact_id: string;
  sha256: string;
  storage_key: string;
  content_type: string | null;
  source_url: string | null;
  byte_size: number;
  fetched_at: string;
  /** Present when the artifact is reachable through a `meeting_documents` row. */
  document_title: string | null;
  document_type: string | null;
  version_no: number | null;
}

export interface CitableFlag {
  id: string;
  meeting_id: string | null;
  artifact_id: string | null;
  metadata: unknown;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

/**
 * Every 64-hex value under a key ending in `sha256`.
 *
 * Keyed on the name rather than on "any 64-hex string anywhere" so a hash that
 * happens to appear inside a scraped title is not mistaken for a citation the
 * detector made. Walks nested objects and arrays, because a metadata shape is
 * a detector's business and this must not depend on it staying flat.
 */
export function metadataHashes(metadata: unknown): string[] {
  const found = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && key.toLowerCase().endsWith("sha256")) {
        const candidate = value.toLowerCase();
        if (SHA256_RE.test(candidate)) found.add(candidate);
        continue;
      }
      walk(value);
    }
  };

  walk(metadata);
  return [...found];
}

interface ArtifactRow {
  id: string;
  sha256: string;
  storage_key: string;
  content_type: string | null;
  source_url: string | null;
  byte_size: number | string;
  fetched_at: unknown;
  document_title?: string | null;
  document_type?: string | null;
  version_no?: number | string | null;
}

function toCitation(kind: CitationKind, row: ArtifactRow): Citation {
  return {
    kind,
    artifact_id: row.id,
    sha256: row.sha256,
    storage_key: row.storage_key,
    content_type: row.content_type ?? null,
    source_url: row.source_url ?? null,
    byte_size: Number(row.byte_size ?? 0),
    fetched_at: asIso(row.fetched_at),
    document_title: row.document_title ?? null,
    document_type: row.document_type ?? null,
    version_no:
      row.version_no === null || row.version_no === undefined ? null : Number(row.version_no),
  };
}

const ARTIFACT_COLUMNS = [
  "artifacts.id",
  "artifacts.sha256",
  "artifacts.storage_key",
  "artifacts.content_type",
  "artifacts.source_url",
  "artifacts.byte_size",
  "artifacts.fetched_at",
];

/** Every artifact this finding cites, deduplicated, most specific route first. */
export async function resolveCitations(db: Knex, flag: CitableFlag): Promise<Citation[]> {
  const citations: Citation[] = [];
  const seen = new Set<string>();

  const add = (kind: CitationKind, rows: ArtifactRow[]): void => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      citations.push(toCitation(kind, row));
    }
  };

  if (flag.artifact_id !== null) {
    const rows = await db("artifacts")
      .where({ id: flag.artifact_id })
      .select<ArtifactRow[]>(ARTIFACT_COLUMNS);
    add("flag_artifact", rows);
  }

  const hashes = metadataHashes(flag.metadata);
  if (hashes.length > 0) {
    // Left-joined, not inner: a hash the detector recorded cites the bytes
    // whether or not the artifact is attached to a `meeting_documents` row. The
    // join only supplies the document's title and version for display, and a
    // missing one renders as nothing rather than dropping the citation.
    const rows = await db("artifacts")
      .leftJoin("document_versions", "document_versions.artifact_id", "artifacts.id")
      .leftJoin(
        "meeting_documents",
        "meeting_documents.id",
        "document_versions.meeting_document_id",
      )
      .whereIn("artifacts.sha256", hashes)
      .select<ArtifactRow[]>([
        ...ARTIFACT_COLUMNS,
        "meeting_documents.title as document_title",
        "meeting_documents.document_type as document_type",
        "document_versions.version_no as version_no",
      ]);
    add("metadata_sha256", rows);
  }

  if (flag.meeting_id !== null) {
    const rows = await db("artifacts")
      .join("document_versions", "document_versions.artifact_id", "artifacts.id")
      .join(
        "meeting_documents",
        "meeting_documents.id",
        "document_versions.meeting_document_id",
      )
      .where("meeting_documents.meeting_id", flag.meeting_id)
      .orderBy("meeting_documents.created_at", "asc")
      .orderBy("document_versions.version_no", "asc")
      .select<ArtifactRow[]>([
        ...ARTIFACT_COLUMNS,
        "meeting_documents.title as document_title",
        "meeting_documents.document_type as document_type",
        "document_versions.version_no as version_no",
      ]);
    add("meeting_document", rows);
  }

  return citations;
}

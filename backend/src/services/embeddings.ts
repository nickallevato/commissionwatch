import knex from '../config/database';

export interface EmbeddingRecord {
  id: string;
  document_id: string;
  chunk_index: number;
  chunk_text: string;
  embedding: number[] | null;
  model: string;
}

/**
 * Splits document text into chunks for embedding.
 * Actual embedding generation will be implemented in Phase 3.
 */
export function chunkText(text: string, maxChunkSize = 1000): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChunkSize, text.length);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export async function storeChunks(documentId: string, text: string): Promise<void> {
  const chunks = chunkText(text);
  const rows = chunks.map((chunk, index) => ({
    document_id: documentId,
    chunk_index: index,
    chunk_text: chunk,
    model: 'pending',
  }));

  await knex('document_embeddings').insert(rows);
}

export async function searchSimilar(
  _queryEmbedding: number[],
  _limit = 10,
): Promise<EmbeddingRecord[]> {
  // Phase 3: actual vector similarity search
  // Will use: ORDER BY embedding <=> $1 LIMIT $2
  return [];
}

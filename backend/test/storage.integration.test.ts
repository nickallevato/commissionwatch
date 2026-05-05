import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { uploadDocument, downloadDocument, deleteDocument } from '../src/services/storage';

describe('Storage Service Integration', () => {
  const testKey = `test/sample-${Date.now()}.pdf`;
  const testContent = Buffer.from('%PDF-1.4 sample document content for testing');

  before(async () => {
    // Requires MinIO to be running (docker compose up minio)
    if (!process.env.MINIO_ENDPOINT) {
      process.env.MINIO_ENDPOINT = 'localhost';
    }
  });

  after(async () => {
    try {
      await deleteDocument(testKey);
    } catch {
      // cleanup best-effort
    }
  });

  it('should upload a document and retrieve it', async () => {
    const key = await uploadDocument(testKey, testContent, 'application/pdf');
    assert.equal(key, testKey);

    const retrieved = await downloadDocument(testKey);
    assert.deepEqual(retrieved, testContent);
  });
});

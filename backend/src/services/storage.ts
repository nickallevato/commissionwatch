import { Client } from 'minio';
import { Readable } from 'stream';

const client = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000', 10),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'commwatch',
  secretKey: process.env.MINIO_SECRET_KEY || 'commwatch-secret',
});

const BUCKET = process.env.MINIO_BUCKET || 'meeting-documents';

async function ensureBucket(): Promise<void> {
  const exists = await client.bucketExists(BUCKET);
  if (!exists) {
    await client.makeBucket(BUCKET);
  }
}

export async function uploadDocument(
  key: string,
  data: Buffer | Readable,
  contentType: string,
): Promise<string> {
  await ensureBucket();
  await client.putObject(BUCKET, key, data, undefined, { 'Content-Type': contentType });
  return key;
}

export async function downloadDocument(key: string): Promise<Buffer> {
  const stream = await client.getObject(BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function deleteDocument(key: string): Promise<void> {
  await client.removeObject(BUCKET, key);
}

export async function getDocumentUrl(key: string, expirySeconds = 3600): Promise<string> {
  return client.presignedGetObject(BUCKET, key, expirySeconds);
}

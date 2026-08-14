import { Client, type ClientOptions } from 'minio';
import { Readable } from 'stream';

/**
 * The connection, in one place.
 *
 * Read as a function rather than inlined into the client constructor because
 * the health check needs the same five settings and had begun duplicating them:
 * `routes/health.ts` built its own `Client` from these exact variables, with a
 * comment saying plainly that the right fix was an exported probe here. This is
 * that fix. Five environment reads copied into a second file is the kind of
 * drift that ends with a probe reporting on a bucket the application never
 * writes to.
 */
function storageOptions(): ClientOptions {
  return {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY || 'commwatch',
    secretKey: process.env.MINIO_SECRET_KEY || 'commwatch-secret',
  };
}

function bucketName(): string {
  return process.env.MINIO_BUCKET || 'meeting-documents';
}

const client = new Client(storageOptions());

const BUCKET = bucketName();

async function ensureBucket(): Promise<void> {
  const exists = await client.bucketExists(BUCKET);
  if (!exists) {
    await client.makeBucket(BUCKET);
  }
}

export type StorageState = 'reachable' | 'unreachable' | 'unconfigured';

/**
 * Is the object store answering?
 *
 * `unconfigured` is a distinct answer from `unreachable`, and the distinction is
 * what keeps the health check honest: the deployment sets `MINIO_ENDPOINT` and
 * CI does not, so falling back to the `localhost` default here would make every
 * CI run report a storage failure that is really a missing setting. A field that
 * is permanently wrong in one environment teaches a reader to ignore it.
 *
 * The client is built per call from the current environment rather than reusing
 * the module's. That is deliberate: the health suite makes storage unreachable
 * by pointing `MINIO_PORT` at a closed port at runtime, which a client frozen at
 * import time could not observe. It costs nothing — the constructor opens no
 * socket.
 *
 * `bucketExists` is the probe because a missing bucket still proves the server
 * answered, and creating one would be a health check with a side effect.
 */
export async function probeStorage(): Promise<StorageState> {
  if (!process.env.MINIO_ENDPOINT) return 'unconfigured';
  try {
    await new Client(storageOptions()).bucketExists(bucketName());
    return 'reachable';
  } catch {
    return 'unreachable';
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

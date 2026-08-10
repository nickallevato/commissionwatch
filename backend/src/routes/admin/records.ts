import { Router, type Request } from 'express';
import express from 'express';
import db from '../../config/database';
import {
  RecordsError,
  RecordsService,
  type RecordsRequestStatus,
} from '../../services/records/requests';
import type { ExtractedEntities } from '../../services/records/extraction';
import { listGaps } from '../../services/records/gaps';
import {
  generateOperatorRequest,
  listJurisdictionLaw,
  normaliseRequester,
} from '../../services/records/generator';

/**
 * The operator's records surface: requests, uploads, extraction, corrections.
 *
 * Every route here is operator-only, mounted behind `requireOperator` in the
 * admin router. That is not defence in depth, it is the requirement:
 * extraction output names people, and this is the only place it is readable.
 */

const router = Router();

let service = new RecordsService(db);

/**
 * Swap the service this router uses.
 *
 * The default is backed by MinIO, which is right in production and wrong in
 * the regular test suite — CI runs Postgres and nothing else, and
 * `test:storage` is a separate script for exactly that reason. Mirrors
 * `registerDigestStatus` in routes/health.ts, which is the same seam for the
 * same reason.
 */
export function registerRecordsService(next: RecordsService): void {
  service = next;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Uploads arrive as base64 in a JSON body rather than multipart. It avoids a
 * dependency in an arm64 cross-build for no loss, and it is trivially testable.
 * The limit is raised on this router alone — a 24 MB body limit on the public
 * API would be a denial-of-service surface; on the operator's upload route it
 * is the requirement.
 */
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
router.use(express.json({ limit: '24mb' }));

function fail(res: import('express').Response, err: unknown, next: (e?: unknown) => void): void {
  if (err instanceof RecordsError) {
    res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
    return;
  }
  next(err);
}

// ---- P7: gaps, the records law, and drafting ------------------------------

/**
 * These sit above `/requests/:id` on purpose — they use their own path segments
 * rather than `/requests/gaps`, which the id route would otherwise swallow and
 * answer with "Invalid request id".
 *
 * The operator scope sees two gap kinds the public one does not: a disabled
 * source and a failed fetch. Those describe *our* ingestion rather than the
 * public record, and publishing them would present our operational state as
 * though it were the county's.
 */
router.get('/gaps', async (req, res, next) => {
  try {
    const meetingId = typeof req.query.meeting_id === 'string' ? req.query.meeting_id : undefined;
    if (meetingId !== undefined && !UUID_RE.test(meetingId)) {
      res.status(400).json({ error: 'Invalid meeting_id format', statusCode: 400 });
      return;
    }
    const data = await listGaps(db, 'operator', { meetingId });
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

/**
 * Every jurisdiction and the state of its records law.
 *
 * A jurisdiction with no row is listed with an advisory rather than omitted:
 * the missing row is what blocks the whole feature, and a console that hid it
 * would present "no gaps can be requested" as though it were a property of the
 * record rather than of our own table.
 */
router.get('/law', async (_req, res, next) => {
  try {
    const data = await listJurisdictionLaw(db);
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

interface DraftRequestBody {
  gap_id?: unknown;
  requester?: unknown;
}

router.post(
  '/draft-request',
  async (req: Request<unknown, unknown, DraftRequestBody>, res, next) => {
    try {
      const body = req.body ?? {};
      if (typeof body.gap_id !== 'string' || body.gap_id.trim() === '') {
        res.status(400).json({ error: 'gap_id is required', statusCode: 400 });
        return;
      }

      const requester = normaliseRequester(body.requester);
      const generated = await generateOperatorRequest(db, { gapId: body.gap_id, requester });

      // 201: a `records_requests` row was created, in `draft`. Nothing was sent,
      // and nothing in this application will send it.
      res.status(201).json(generated);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

// ---- requests -------------------------------------------------------------

router.get('/requests', async (_req, res, next) => {
  try {
    const data = await service.listRequests();
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

interface CreateRequestBody {
  subject?: unknown;
  jurisdiction_id?: unknown;
  status?: unknown;
  response_due_at?: unknown;
  notes?: unknown;
}

router.post('/requests', async (req: Request<unknown, unknown, CreateRequestBody>, res, next) => {
  try {
    const body = req.body ?? {};
    if (typeof body.subject !== 'string' || body.subject.trim() === '') {
      res.status(400).json({ error: 'subject is required', statusCode: 400 });
      return;
    }

    const request = await service.createRequest({
      subject: body.subject,
      jurisdiction_id: typeof body.jurisdiction_id === 'string' ? body.jurisdiction_id : null,
      status: typeof body.status === 'string' ? (body.status as RecordsRequestStatus) : undefined,
      response_due_at:
        typeof body.response_due_at === 'string' ? new Date(body.response_due_at) : null,
      notes: typeof body.notes === 'string' ? body.notes : null,
    });

    res.status(201).json(request);
  } catch (err) {
    fail(res, err, next);
  }
});

router.get('/requests/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'Invalid request id', statusCode: 400 });
      return;
    }

    const found = await service.getRequest(id);
    if (!found) {
      res.status(404).json({ error: 'Records request not found', statusCode: 404 });
      return;
    }

    res.json(found);
  } catch (err) {
    next(err);
  }
});

interface UpdateRequestBody {
  status?: unknown;
  responded_at?: unknown;
  response_due_at?: unknown;
  notes?: unknown;
}

router.patch('/requests/:id', async (req: Request<{ id: string }, unknown, UpdateRequestBody>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'Invalid request id', statusCode: 400 });
      return;
    }

    const body = req.body ?? {};
    const updated = await service.updateRequest(id, {
      status: typeof body.status === 'string' ? (body.status as RecordsRequestStatus) : undefined,
      responded_at: typeof body.responded_at === 'string' ? new Date(body.responded_at) : undefined,
      response_due_at:
        typeof body.response_due_at === 'string' ? new Date(body.response_due_at) : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
    });

    if (!updated) {
      res.status(404).json({ error: 'Records request not found', statusCode: 404 });
      return;
    }

    res.json(updated);
  } catch (err) {
    fail(res, err, next);
  }
});

// ---- documents ------------------------------------------------------------

interface UploadBody {
  filename?: unknown;
  content_type?: unknown;
  content_base64?: unknown;
  text?: unknown;
  request_id?: unknown;
}

async function handleUpload(
  req: Request<Record<string, string>, unknown, UploadBody>,
  res: import('express').Response,
  next: (e?: unknown) => void,
  requestId: string | null,
): Promise<void> {
  try {
    const body = req.body ?? {};
    if (typeof body.filename !== 'string' || body.filename.trim() === '') {
      res.status(400).json({ error: 'filename is required', statusCode: 400 });
      return;
    }
    if (typeof body.content_base64 !== 'string' || body.content_base64 === '') {
      res.status(400).json({ error: 'content_base64 is required', statusCode: 400 });
      return;
    }

    const content = Buffer.from(body.content_base64, 'base64');
    if (content.length === 0) {
      res.status(400).json({ error: 'content_base64 did not decode to any bytes', statusCode: 400 });
      return;
    }
    if (content.length > MAX_DOCUMENT_BYTES) {
      res.status(413).json({
        error: `Documents are limited to ${MAX_DOCUMENT_BYTES} bytes`,
        statusCode: 413,
      });
      return;
    }

    const result = await service.ingestDocument({
      filename: body.filename,
      contentType: typeof body.content_type === 'string' ? body.content_type : null,
      content,
      text: typeof body.text === 'string' ? body.text : null,
      requestId,
    });

    // `created: false` means identical bytes were already stored and nothing
    // was reprocessed. Reported rather than hidden, so a re-upload does not
    // look like it silently did nothing.
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    fail(res, err, next);
  }
}

router.post('/documents', (req, res, next) => {
  void handleUpload(req, res, next, null);
});

router.post('/requests/:id/documents', (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Invalid request id', statusCode: 400 });
    return;
  }
  void handleUpload(req, res, next, req.params.id);
});

router.get('/documents/:artifactId/extraction', async (req, res, next) => {
  try {
    const { artifactId } = req.params;
    if (!UUID_RE.test(artifactId)) {
      res.status(400).json({ error: 'Invalid document id', statusCode: 400 });
      return;
    }

    const current = await service.latestExtraction(artifactId);
    if (!current) {
      res.status(404).json({ error: 'No extraction for that document', statusCode: 404 });
      return;
    }

    const history = await service.extractionHistory(artifactId);
    res.json({ current, history });
  } catch (err) {
    next(err);
  }
});

interface CorrectionBody {
  entities?: unknown;
  note?: unknown;
}

router.post(
  '/documents/:artifactId/extraction',
  async (req: Request<{ artifactId: string }, unknown, CorrectionBody>, res, next) => {
    try {
      const { artifactId } = req.params;
      if (!UUID_RE.test(artifactId)) {
        res.status(400).json({ error: 'Invalid document id', statusCode: 400 });
        return;
      }

      const body = req.body ?? {};
      if (typeof body.entities !== 'object' || body.entities === null) {
        res.status(400).json({ error: 'entities is required', statusCode: 400 });
        return;
      }

      const corrected = await service.correctExtraction({
        artifactId,
        entities: body.entities as ExtractedEntities,
        operatorId: req.operator?.id ?? null,
        note: typeof body.note === 'string' ? body.note : null,
      });

      // 201: a correction appends. The superseded row is still there.
      res.status(201).json(corrected);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

export default router;
